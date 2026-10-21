/**
 * Hivemind hook (ARCHITECTURE.md §6.3, §6.4). One command handles every event for Claude Code and Codex:
 *   node hook.mjs claude|codex     (JSON payload on stdin)
 *
 * Fail-open: any error means exit 0 with no output. This file has no static imports of its own modules; the
 * tool adapter, git.mjs and limits.mjs are loaded with dynamic import() inside the top-level try, so a missing
 * or broken module can't crash the process before error handling exists. Only node: built-ins are imported
 * statically.
 *
 * Time: one deadline runs from process start. Git and the network get only what is left of it, and the network
 * budget is reserved before any Git work starts, so a slow Git can never cost a deny decision. A watchdog exits 0
 * (and logs a line) if anything still hangs.
 *
 * @typedef {import('../../shared/contracts').HookRequest} HookRequest
 * @typedef {import('../../shared/contracts').HookResponse} HookResponse
 * @typedef {import('../../shared/contracts').HookEvent} HookEvent
 * @typedef {import('../../shared/contracts').GitStateReport} GitStateReport
 * @typedef {import('../../shared/contracts').LastPush} LastPush
 * @typedef {import('../../shared/hook-modules').ToolAdapter} ToolAdapter
 * @typedef {import('../../shared/hook-modules').GitModule} GitModule
 * @typedef {import('../../shared/hook-modules').Identity} Identity
 * @typedef {import('../../shared/hook-modules').GitMemory} GitMemory
 * @typedef {import('../../shared/hook-modules').HookOutcome} HookOutcome
 * @typedef {import('../../shared/hook-modules').ParsedHookInput & { source?: string | null }} ParsedInput
 *
 * @typedef {{
 *   v: 2;
 *   idents: Record<string, { ident: Identity | null; at: number }>;
 *   callsign: string | null;
 *   mode: string | null;
 *   heartbeatMs: number | null;
 *   lastHeartbeat: number;
 *   shellSeq: number;
 *   shellAck: number;
 *   gitMemory: GitMemory | null;
 *   gitMemoryAt: number;
 *   forced?: string[];
 *   baselineAt: number;
 *   settingsHash: string | null;
 *   failures: number;
 *   lastAttemptAt: number;
 *   outageSince: number | null;
 *   outageNotified: boolean;
 * }} SessionState
 *
 * @typedef {{ server: string; token: string; repos: string[] }} HookConfig
 */
import {
  appendFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { homedir, hostname } from 'node:os';
import { basename, dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes } from 'node:crypto';

const EVENTS = new Set(['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'SessionEnd']);
/** Events whose output can carry additionalContext (Stop can only block, SessionEnd has no output). */
const CONTEXT_EVENTS = new Set(['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse']);
/** The session keeps running after these SessionEnd reasons, so its state is kept. */
const NOT_EXIT = new Set(['clear', 'resume']);
const IDENT_TTL_MS = 10_000;
const NOT_REPO_TTL_MS = 60_000;
const MAX_IDENTS = 20;
const LOG_MAX_BYTES = 1_000_000;
const SETTINGS_MAX_BYTES = 64 * 1024;
const STDIN_MAX_BYTES = 16 * 1024 * 1024;
const STATE_MAX_AGE_MS = 2 * 24 * 60 * 60_000;
/** Total time from process start (the tool kills the hook at 5 s; SessionEnd at 3 s). */
const DEADLINE_MS = 4_000;
const SESSION_END_DEADLINE_MS = 2_300;
/** Kept free after the network call for output and state writes. */
const MARGIN_MS = 300;
const MAX_TEXT = 8 * 1024;
const MAX_PATH = 1024;
const MAX_BRANCH = 300;
const MAX_BODY = 200 * 1024;
const CALLSIGN_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const OUTAGE_NOTICE =
  "[Hivemind] Can't reach the server (3 failed attempts). Coordination is paused and edits aren't being checked. Retrying every minute.";

/** @type {{ home: string | null; event: string | null; tool: string | null; token: string | null; started: number; deadline: number; statePath: string | null; watchdog: ReturnType<typeof setTimeout> | null }} */
const ctx = {
  home: null, event: null, tool: null, token: null, started: Date.now(), deadline: Date.now() + DEADLINE_MS, statePath: null, watchdog: null,
};

const remaining = () => ctx.deadline - Date.now();

/**
 * Race a promise against a time budget; rejects when the budget runs out.
 * @template T
 * @param {Promise<T> | T} p
 * @param {number} ms
 * @returns {Promise<T>}
 */
function within(p, ms) {
  if (ms <= 0) return Promise.reject(new Error('out of time'));
  /** @type {ReturnType<typeof setTimeout>} */
  let timer;
  return Promise.race([
    Promise.resolve(p),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('out of time')), ms); }),
  ]).finally(() => clearTimeout(timer));
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** @returns {Promise<string | null>} null when the input is over the cap */
async function readStdin() {
  /** @type {Buffer[]} */
  const chunks = [];
  let size = 0;
  for await (const c of process.stdin) {
    size += /** @type {Buffer} */ (c).length;
    if (size > STDIN_MAX_BYTES) return null;
    chunks.push(/** @type {Buffer} */ (c));
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * @param {string} s
 * @returns {string}
 */
function sha(s) {
  return createHash('sha256').update(s).digest('hex');
}

/**
 * @param {string} text
 * @returns {string}
 */
const stripBom = (text) => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);

/** @returns {SessionState} */
function freshState() {
  return {
    v: 2, idents: {}, callsign: null, mode: null, heartbeatMs: null, lastHeartbeat: 0, shellSeq: 0, shellAck: 0,
    gitMemory: null, gitMemoryAt: 0, baselineAt: 0, settingsHash: null, failures: 0, lastAttemptAt: 0, outageSince: null, outageNotified: false,
  };
}

/** Session state lives under the Hivemind home (owner-only where supported), never in a shared temp folder. */
const stateDir = () => join(/** @type {string} */ (ctx.home), 'state');

/**
 * @param {string} session
 * @returns {string}
 */
function statePathFor(session) {
  return join(stateDir(), `${sha(session).slice(0, 32)}.json`);
}

/** @param {number} ms */
function pause(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* ignore */ }
}

/**
 * @param {string} path
 * @returns {SessionState | null} null when the file can't be read reliably (a write must then be skipped)
 */
function loadState(path) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const s = JSON.parse(readFileSync(path, 'utf8'));
      if (s && s.v === 2 && typeof s.idents === 'object') return { ...freshState(), ...s };
      return freshState();
    } catch (e) {
      if (/** @type {NodeJS.ErrnoException} */ (e).code === 'ENOENT') return freshState();
      pause(15); // another process may be replacing the file right now
    }
  }
  return null;
}

/**
 * Atomic write: exclusive-create a private temp file, then rename. No in-place fallback.
 * @param {string} path
 * @param {SessionState} s
 */
function writeStateFile(path, s) {
  mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  writeFileSync(tmp, JSON.stringify(s), { flag: 'wx', mode: 0o600 });
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      renameSync(tmp, path);
      return;
    } catch {
      pause(10 * (attempt + 1));
    }
  }
  try { unlinkSync(tmp); } catch { /* ignore */ }
}

/**
 * Read-modify-write of only what this event changed: re-reads just before writing, so a parallel hook
 * process's changes are merged rather than overwritten.
 * @template T
 * @param {(s: SessionState) => T} fn
 * @returns {T | undefined}
 */
function updateState(fn) {
  if (!ctx.statePath) return undefined;
  const s = loadState(ctx.statePath);
  if (!s) return undefined;
  const result = fn(s);
  try { writeStateFile(ctx.statePath, s); } catch { /* state is a cache */ }
  return result;
}

/** Drop state files nobody has touched for two days. */
function pruneStates() {
  try {
    const dir = stateDir();
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      try {
        if (Date.now() - statSync(p).mtimeMs > STATE_MAX_AGE_MS) unlinkSync(p);
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
}

/**
 * One JSON line per network attempt or caught error. Never tokens, message text or parser snippets.
 * @param {boolean} ok
 * @param {unknown} [error]
 * @param {number} [ms]
 */
function log(ok, error, ms) {
  try {
    if (!ctx.home || !existsSync(ctx.home)) return;
    const path = join(ctx.home, 'hook.log');
    try {
      if (statSync(path).size > LOG_MAX_BYTES) renameSync(path, `${path}.1`);
    } catch { /* no log yet */ }
    let msg;
    if (error instanceof SyntaxError) msg = 'SyntaxError: invalid JSON';
    else if (error !== undefined) msg = String(error instanceof Error ? `${error.name}: ${error.message}` : error);
    if (msg !== undefined && ctx.token) msg = msg.split(ctx.token).join('[token]');
    appendFileSync(path, `${JSON.stringify({
      ts: Date.now(), event: ctx.event, tool: ctx.tool, ok, ms: ms ?? Date.now() - ctx.started, ...(msg !== undefined ? { error: msg.slice(0, 200) } : {}),
    })}\n`);
  } catch { /* logging must never break the hook */ }
}

/**
 * @param {string} server
 * @returns {boolean} https anywhere; http only for loopback
 */
function serverAllowed(server) {
  try {
    const u = new URL(server);
    if (u.protocol === 'https:') return true;
    return u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  } catch {
    return false;
  }
}

/**
 * @param {string} home
 * @returns {HookConfig | null}
 */
function readConfig(home) {
  try {
    const c = JSON.parse(stripBom(readFileSync(join(home, 'config.json'), 'utf8')));
    if (typeof c?.server !== 'string' || typeof c?.token !== 'string' || !Array.isArray(c?.repos)) return null;
    if (!serverAllowed(c.server)) return null;
    return { server: c.server.replace(/\/+$/, ''), token: c.token, repos: c.repos.filter((/** @type {unknown} */ r) => typeof r === 'string') };
  } catch {
    return null;
  }
}

/**
 * @param {unknown} v
 * @returns {string[]}
 */
function strList(v) {
  return Array.isArray(v) ? v.filter((p) => typeof p === 'string' && p.length > 0 && p.length <= 200).slice(0, 100) : [];
}

/**
 * .hivemind/project.json from the checkout, reduced to requireTask/advisory/ignore, with a hash of that.
 * Refuses symlinks and anything whose real path leaves the checkout. Null when absent or unusable.
 * @param {string} root
 * @returns {{ settings: { requireTask?: boolean; advisory?: string[]; ignore?: string[] }; hash: string } | null}
 */
function readSettings(root) {
  try {
    const dir = join(root, '.hivemind');
    const path = join(dir, 'project.json');
    if (lstatSync(dir).isSymbolicLink()) return null;
    const st = lstatSync(path);
    if (st.isSymbolicLink() || !st.isFile() || st.size > SETTINGS_MAX_BYTES) return null;
    const realRoot = realpathSync.native(root);
    const realFile = realpathSync.native(path);
    if (!realFile.toLowerCase().startsWith(realRoot.toLowerCase() + sep)) return null;
    const raw = JSON.parse(stripBom(readFileSync(path, 'utf8')));
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
    /** @type {{ requireTask?: boolean; advisory?: string[]; ignore?: string[] }} */
    const settings = {};
    if (typeof raw.requireTask === 'boolean') settings.requireTask = raw.requireTask;
    if (Array.isArray(raw.advisory)) settings.advisory = strList(raw.advisory);
    if (Array.isArray(raw.ignore)) settings.ignore = strList(raw.ignore);
    return { settings, hash: sha(JSON.stringify(settings)) };
  } catch {
    return null;
  }
}

/**
 * @param {unknown} v
 * @param {number} max
 * @returns {string | null}
 */
const capText = (v, max) => (typeof v === 'string' && v !== '' ? (v.length > max ? `${v.slice(0, max - 1)}…` : v) : null);

/**
 * @param {unknown} v
 * @returns {HookResponse}
 */
function validateResponse(v) {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error('response is not an object');
  const r = /** @type {Record<string, unknown>} */ (v);
  if (r.decision !== 'allow' && r.decision !== 'deny' && r.decision !== 'block' && r.decision !== 'none') throw new Error('bad decision');
  if (typeof r.heartbeatMs !== 'number' || !Number.isFinite(r.heartbeatMs) || r.heartbeatMs < 0) throw new Error('bad heartbeatMs');
  if (r.reason !== null && r.reason !== undefined && typeof r.reason !== 'string') throw new Error('bad reason');
  if (r.context !== null && r.context !== undefined && typeof r.context !== 'string') throw new Error('bad context');
  if (typeof r.callsign !== 'string' || (r.callsign !== '' && !CALLSIGN_RE.test(r.callsign))) throw new Error('bad callsign');
  /** @type {LastPush[]} */
  const lastPush = [];
  if (Array.isArray(r.lastPush)) {
    for (const p of r.lastPush.slice(0, 50)) {
      if (typeof p === 'object' && p !== null && typeof p.path === 'string' && p.path.length <= MAX_PATH && typeof p.sha === 'string' && p.sha.length <= 80
        && typeof p.blob === 'string' && p.blob.length <= 80 && typeof p.by === 'string' && CALLSIGN_RE.test(p.by)
        && typeof p.branch === 'string' && p.branch.length <= MAX_BRANCH && typeof p.at === 'number' && Number.isFinite(p.at)) {
        lastPush.push({ path: p.path, sha: p.sha, blob: p.blob, by: p.by, branch: p.branch, at: p.at });
      }
    }
  }
  return {
    decision: r.decision,
    reason: capText(r.reason, MAX_TEXT),
    context: capText(r.context, MAX_TEXT),
    callsign: r.callsign,
    lastPush,
    heartbeatMs: r.heartbeatMs,
    mode: r.mode === 'enforce' || r.mode === 'warn' || r.mode === 'off' ? r.mode : 'enforce',
  };
}

/** A 4xx other than 408 and 429: the server saw the request and refused it. Not an outage. */
class Rejected extends Error {}

/**
 * @param {HookConfig} config
 * @param {HookRequest} req
 * @param {number} timeoutMs
 * @returns {Promise<HookResponse>}
 */
async function post(config, req, timeoutMs) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(`${config.server}/hook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${config.token}` },
      body: JSON.stringify(req),
      redirect: 'error',
      signal: ac.signal,
    });
    if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) {
      await res.body?.cancel().catch(() => {});
      throw new Rejected(`rejected: HTTP ${res.status}`);
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return validateResponse(JSON.parse(await res.text()));
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Keep valid local states inside the server's validation limits (path 1024, branch 300, body 256 KB).
 * @param {HookRequest} req
 */
function fitRequest(req) {
  if (req.branch && req.branch.length > MAX_BRANCH) req.branch = req.branch.slice(0, MAX_BRANCH);
  if (req.head && req.head.length > 100) req.head = req.head.slice(0, 100);
  const git = req.git;
  if (!git) return;
  /** @param {string[] | undefined} list */
  const keep = (list) => {
    if (!list) return list;
    const ok = list.filter((p) => p.length <= MAX_PATH);
    if (ok.length !== list.length) git.truncated = true;
    return ok;
  };
  git.divergent = keep(git.divergent) ?? [];
  if (git.baseline) git.baseline = keep(git.baseline);
  if (git.upstream && git.upstream.length > 200) git.upstream = null;
  if (git.pushed) {
    git.pushed.files = git.pushed.files.filter((f) => f.path.length <= MAX_PATH && f.blob.length <= 80).slice(0, 500);
    if (git.pushed.branch.length > MAX_BRANCH || git.pushed.sha.length > 80 || git.pushed.files.length === 0) git.pushed = null;
  }
  while (JSON.stringify(req).length > MAX_BODY && (git.divergent.length > 1 || (git.baseline?.length ?? 0) > 1)) {
    git.truncated = true;
    git.divergent = git.divergent.slice(0, Math.floor(git.divergent.length / 2));
    if (git.baseline) git.baseline = git.baseline.slice(0, Math.floor(git.baseline.length / 2));
  }
  if (JSON.stringify(req).length > MAX_BODY) delete req.git;
}

/**
 * @param {{ default?: unknown }} mod
 * @returns {any}
 */
const impl = (mod) => mod.default ?? mod;

// ---------------------------------------------------------------------------
// The hook
// ---------------------------------------------------------------------------

/**
 * Local me check (§5): no network.
 * @param {ParsedInput} input
 * @param {SessionState} state
 * @returns {HookOutcome | null}
 */
function meCheck(input, state) {
  if (!state.callsign || input.me === null || input.me === state.callsign) return null;
  return {
    decision: 'deny',
    reason: `[Hivemind] Wrong callsign: you are ${state.callsign}, not "${input.me}". Pass me: "${state.callsign}" to every Hivemind tool.`,
    context: null,
  };
}

/** @type {typeof import('./limits.mjs').HOOK_LIMITS | null} */
let LIM = null;

/**
 * Claim the one-per-outage notice, if the breaker is open, nobody has said it yet, and this event can carry it.
 * The claim is made under the state merge, so parallel processes can't both print it.
 * @param {string} event
 * @returns {HookOutcome | null}
 */
function claimOutageNotice(event) {
  if (!LIM || !CONTEXT_EVENTS.has(event)) return null;
  const limits = LIM;
  /** @type {number | null} */
  let outage = null;
  const eligible = updateState((s) => {
    if (s.failures < limits.breakerFailures || s.outageNotified) return false;
    s.outageNotified = true;
    outage = s.outageSince ?? 0;
    return true;
  });
  // The state merge isn't a lock, so the claim itself is an exclusive-create marker, one per outage.
  let claimed = false;
  if (eligible && ctx.statePath) {
    try {
      writeFileSync(`${ctx.statePath}.notice.${outage}`, '', { flag: 'wx', mode: 0o600 });
      claimed = true;
    } catch { /* another process said it */ }
  }
  return claimed ? { decision: 'allow', reason: null, context: OUTAGE_NOTICE } : null;
}

/**
 * When `join` installed this script as `<home>/hook/hook.mjs` next to `<home>/config.json`, that `<home>` is the
 * Hivemind home, even if HIVEMIND_HOME isn't set in the agent's environment. Node runs the script by its real path,
 * so a symlinked or junctioned hook folder is detected next to its target (and otherwise falls back to ~/.hivemind).
 * @returns {string | null}
 */
function installedHome() {
  try {
    const hookDir = dirname(fileURLToPath(import.meta.url));
    if (basename(hookDir) !== 'hook') return null;
    const home = dirname(hookDir);
    return existsSync(join(home, 'config.json')) ? home : null;
  } catch {
    return null;
  }
}

/**
 * @returns {Promise<{ out: HookOutcome | null; event: HookEvent | null; adapter: ToolAdapter | null }>}
 */
async function run() {
  const tool = process.argv[2];
  if (tool !== 'claude' && tool !== 'codex') return { out: null, event: null, adapter: null };

  ctx.home = process.env.HIVEMIND_HOME || installedHome() || join(homedir(), '.hivemind');
  const home = ctx.home;
  if (existsSync(join(home, 'off'))) return { out: null, event: null, adapter: null };
  const config = readConfig(home);
  if (!config) return { out: null, event: null, adapter: null };
  ctx.token = config.token;

  const stdin = await readStdin();
  if (stdin === null) return { out: null, event: null, adapter: null };

  LIM = (await import('./limits.mjs')).HOOK_LIMITS;
  const limits = LIM;
  /** @type {ToolAdapter} */
  const adapter = impl(await import(tool === 'claude' ? './claude.mjs' : './codex.mjs'));
  /** @type {GitModule & { refs?: (root: string) => Promise<{ branch: string | null; head: string | null }> }} */
  const gitMod = impl(await import('./git.mjs'));

  /** @type {ParsedInput} */
  const input = await adapter.parse(JSON.parse(stdin));
  const event = input.event;
  ctx.event = event;
  ctx.tool = input.tool;
  if (!EVENTS.has(event)) return { out: null, event: null, adapter };
  const netTimeout = event === 'SessionEnd' ? limits.sessionEndTimeoutMs : limits.hookTimeoutMs;
  if (event === 'SessionEnd') {
    ctx.deadline = ctx.started + SESSION_END_DEADLINE_MS;
    arm();
  }
  // Test-only: HIVEMIND_GIT_BUDGET_MS raises the Git time cap so slow CI runners don't hit it. Never set in production.
  const GIT_CAP_MS = Number(process.env.HIVEMIND_GIT_BUDGET_MS) || 1_500;
  /** Time Git may use: whatever is left after reserving the network call and the margin. */
  const gitBudget = () => Math.min(GIT_CAP_MS, remaining() - netTimeout - MARGIN_MS);

  ctx.statePath = statePathFor(input.session);
  const statePath = ctx.statePath;
  /** @type {SessionState} */
  let state = loadState(statePath) ?? freshState();

  const now = Date.now();
  const done = (/** @type {HookOutcome | null} */ out) => ({ out, event, adapter });

  // Resolve the checkout (cached per cwd; "not a repo" too) and check that its root commit is mapped.
  const entry = state.idents[input.cwd];
  /** @type {Identity | null} */
  let ident = entry ? entry.ident : null;
  if (entry && !entry.ident && now - entry.at < NOT_REPO_TTL_MS) return done(null);
  if (!ident) {
    try {
      ident = await within(gitMod.identity(input.cwd), gitBudget());
    } catch (e) {
      log(false, e);
      return done(null);
    }
    const found = ident;
    updateState((s) => {
      s.idents[input.cwd] = { ident: found, at: now };
      const keys = Object.keys(s.idents);
      if (keys.length > MAX_IDENTS) {
        keys.sort((a, b) => (s.idents[a]?.at ?? 0) - (s.idents[b]?.at ?? 0));
        for (const k of keys.slice(0, keys.length - MAX_IDENTS)) delete s.idents[k];
      }
    });
    if (!ident) {
      log(false, 'no git identity for cwd');
      return done(null);
    }
  }
  if (!config.repos.includes(ident.repo)) return done(null);

  // Local fast paths: no network.
  if (event === 'PreToolUse' && input.isHivemindTool) return done(meCheck(input, state));
  /** @type {string[]} */
  let paths = [];
  if (event === 'PreToolUse') {
    paths = gitMod.normalize(ident.root, input.cwd, input.editPaths);
    if (paths.length === 0) return done(null);
  }

  // A fresh session (a real start, or one we have no baseline for) resets its bookkeeping; resume and compact don't.
  const isStart = event === 'SessionStart';
  const freshStart = isStart && (input.source === 'startup' || input.source == null || state.baselineAt === 0);
  if (freshStart) {
    updateState((s) => {
      s.lastHeartbeat = 0; s.gitMemory = null; s.gitMemoryAt = 0; s.forced = []; s.baselineAt = 0; s.settingsHash = null; s.heartbeatMs = null;
      s.shellAck = s.shellSeq;
    });
    pruneStates();
  }
  if (isStart || event === 'PostToolUse') {
    if (event === 'PostToolUse' && input.isShell) updateState((s) => { s.shellSeq += 1; });
    state = loadState(statePath) ?? state;
  }
  /** @type {string[]} */
  let forcedNow = [];
  if (event === 'PostToolUse') {
    if (state.heartbeatMs === 0) return done(null);
    const interval = state.heartbeatMs ?? limits.heartbeatMs;
    // An edit of a file Git has not yet reported as divergent is not throttled: the heartbeat records it, so the
    // remembered set stays Git-confirmed and a push right after the edit is recognised (§12, issue #20).
    // Each path forces at most once until it shows up in a Git report (gitignored output never does), so edits that
    // never become divergent don't cost a request each.
    try {
      if (input.editPaths.length > 0 && state.gitMemory) {
        const known = new Set([...state.gitMemory.divergent, ...(state.forced ?? [])]);
        forcedNow = gitMod.normalize(ident.root, input.cwd, input.editPaths).filter((p) => !known.has(p));
      }
    } catch (e) {
      log(false, e); // not a network failure: no breaker count
    }
    if (forcedNow.length === 0 && state.shellSeq <= state.shellAck && now < state.lastHeartbeat + interval) return done(null);
  }

  // Circuit breaker: skip the network while it is open.
  if (state.failures >= limits.breakerFailures && now - state.lastAttemptAt < limits.breakerOpenMs) {
    return done(claimOutageNotice(event));
  }

  // Fresh branch and head for anything that goes to the network (SessionEnd uses the cache).
  if (event !== 'SessionEnd' && entry && now - entry.at > IDENT_TTL_MS && gitBudget() > 0) {
    try {
      const refs = typeof gitMod.refs === 'function'
        ? await within(gitMod.refs(ident.root), gitBudget())
        : await within(gitMod.identity(input.cwd), gitBudget());
      if (refs && (!('repo' in refs) || refs.repo === ident.repo)) {
        ident = { ...ident, branch: refs.branch, head: refs.head };
        const fresh = ident;
        updateState((s) => { s.idents[input.cwd] = { ident: fresh, at: Date.now() }; });
      }
    } catch (e) {
      log(false, e);
    }
  }

  /** @type {HookRequest} */
  const req = {
    v: 1, event, agent: tool, session: input.session,
    repo: ident.repo, checkout: sha(`${hostname()}\n${ident.root}`).slice(0, 16),
    branch: ident.branch, head: ident.head,
  };
  if (input.tool) req.tool = input.tool.slice(0, 200);
  if (ident.repoName) req.repoName = ident.repoName.slice(0, 200);
  if (event === 'PreToolUse') req.paths = paths.filter((p) => p.length <= MAX_PATH);
  if (event === 'Stop') req.stopActive = input.stopActive;
  if (event === 'SessionEnd') req.endReason = input.endReason;

  // Git state (§6.3 step 9): not on PreToolUse or SessionEnd, and not while heartbeats are off.
  /** @type {GitMemory | null} */
  let newMemory = null;
  const memoryAt = Date.now();
  const sendBaseline = isStart && freshStart;
  const wantsGit = isStart
    || ((event === 'UserPromptSubmit' || event === 'Stop' || event === 'PostToolUse') && state.heartbeatMs !== 0);
  if (wantsGit && gitBudget() > 0) {
    try {
      const s = await within(gitMod.state(ident.root, sendBaseline ? null : state.gitMemory), gitBudget());
      /** @type {GitStateReport} */
      const report = { ...s.report };
      if (sendBaseline) report.baseline ??= report.divergent;
      else delete report.baseline;
      req.git = report;
      req.shellSinceHeartbeat = state.shellSeq > state.shellAck;
      newMemory = s.memory;
    } catch (e) {
      log(false, e);
    }
  }
  const sentSeq = state.shellSeq;

  // Settings: on a fresh SessionStart and whenever the file changes.
  const settings = event === 'SessionEnd' ? null : readSettings(ident.root);
  const sendSettings = settings !== null && settings.hash !== state.settingsHash;
  if (settings && sendSettings) req.settings = settings.settings;

  if (state.failures >= limits.breakerFailures && state.outageSince !== null) req.outageMs = Math.max(1, now - state.outageSince);
  fitRequest(req);

  const t0 = Date.now();
  /** @type {HookResponse} */
  let resp;
  try {
    resp = await post(config, req, Math.max(100, Math.min(netTimeout, remaining() - MARGIN_MS)));
    log(true, undefined, Date.now() - t0);
  } catch (e) {
    log(false, e, Date.now() - t0);
    if (e instanceof Rejected) return done(null); // the server refused this request; the server is up
    updateState((s) => {
      s.failures += 1;
      s.lastAttemptAt = Math.max(s.lastAttemptAt, Date.now());
      if (s.failures === 1) s.outageSince = Date.now();
    });
    return done(claimOutageNotice(event));
  }

  // Success: merge only what this request changed.
  const sentGit = req.git !== undefined;
  const hash = settings && sendSettings ? settings.hash : null;
  updateState((s) => {
    s.failures = 0;
    s.lastAttemptAt = Math.max(s.lastAttemptAt, Date.now());
    s.outageSince = null;
    s.outageNotified = false;
    if (resp.callsign) s.callsign = resp.callsign;
    s.mode = resp.mode;
    s.heartbeatMs = resp.heartbeatMs;
    if (sentGit) {
      s.lastHeartbeat = Math.max(s.lastHeartbeat, Date.now());
      s.shellAck = Math.max(s.shellAck, sentSeq);
      if (newMemory && memoryAt > s.gitMemoryAt) {
        const seenBefore = new Set([...(s.gitMemory?.divergent ?? []), ...newMemory.divergent]);
        s.gitMemory = newMemory; s.gitMemoryAt = memoryAt;
        // Paths Git has reported are tracked by the memory again; the rest stay marked so they don't force again.
        s.forced = [...(s.forced ?? []).filter((p) => !seenBefore.has(p)), ...forcedNow.filter((p) => !seenBefore.has(p))].slice(-50);
      }
      if (sendBaseline) s.baselineAt = Date.now();
    }
    if (hash) s.settingsHash = hash;
  });

  /** @type {HookOutcome} */
  const outcome = { decision: 'allow', reason: null, context: resp.context };
  if (event === 'PreToolUse' && resp.decision === 'deny') {
    outcome.decision = 'deny';
    outcome.reason = resp.reason;
  } else if (event === 'Stop' && resp.decision === 'block' && !input.stopActive && resp.reason) {
    outcome.decision = 'block';
    outcome.reason = resp.reason;
  }

  // Stale-copy check (§6.3 step 12): a failure drops only the warning.
  if (event === 'PreToolUse' && outcome.decision !== 'deny' && resp.lastPush && resp.lastPush.length > 0 && remaining() > MARGIN_MS) {
    try {
      const lines = await within(gitMod.staleWarnings(ident.root, ident.branch, resp.lastPush), Math.min(1_000, remaining() - MARGIN_MS));
      if (lines.length > 0) {
        const text = `[Hivemind] Before you edit:\n${lines.map((l) => `- ${l}`).join('\n')}`;
        outcome.context = outcome.context ? `${outcome.context}\n\n${text}` : text;
      }
    } catch (e) {
      log(false, e);
    }
  }

  if (event === 'SessionEnd' && !NOT_EXIT.has(input.endReason ?? '')) {
    try { unlinkSync(statePath); } catch { /* ignore */ }
  }
  return done(outcome);
}

/**
 * @param {string | null} out
 */
function finish(out) {
  if (ctx.watchdog) clearTimeout(ctx.watchdog);
  const quit = () => process.exit(0);
  process.stdout.on('error', quit); // EPIPE: the tool went away; nothing left to say
  if (out) process.stdout.write(out, quit);
  else quit();
  setTimeout(quit, 500).unref();
}

// Never run longer than the tool's own timeout (5 s; 3 s for SessionEnd). Kept ref'd so it fires even when
// the event loop would otherwise be empty.
function arm() {
  if (ctx.watchdog) clearTimeout(ctx.watchdog);
  ctx.watchdog = setTimeout(() => {
    log(false, 'watchdog: deadline passed, exiting');
    process.exit(0);
  }, Math.max(50, ctx.deadline - Date.now() + 100));
}
arm();

try {
  const { out, event, adapter } = await run();
  finish(out && adapter && event ? adapter.format(event, out) : null);
} catch (e) {
  log(false, e);
  try {
    // Any error counts as a failure towards the circuit breaker, if we got far enough to have a session.
    updateState((s) => {
      s.failures += 1;
      s.lastAttemptAt = Math.max(s.lastAttemptAt, Date.now());
      if (s.failures === 1) s.outageSince = Date.now();
    });
  } catch { /* ignore */ }
  finish(null);
}
