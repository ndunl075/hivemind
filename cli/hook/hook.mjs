/**
 * Hivemind hook (ARCHITECTURE.md §6.3, §6.4). One command handles every event for Claude Code and Codex:
 *   node hook.mjs claude|codex     (JSON payload on stdin)
 *
 * Fail-open: any error means exit 0 with no output. This file has no static imports of its own modules; the
 * tool adapter, git.mjs and limits.mjs are loaded with dynamic import() inside the top-level try, so a missing
 * or broken module can't crash the process before error handling exists. Only node: built-ins are imported
 * statically.
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
 * @typedef {import('../../shared/hook-modules').ParsedHookInput} ParsedHookInput
 *
 * @typedef {{
 *   v: 1;
 *   idents: Record<string, { ident: Identity; at: number }>;
 *   callsign: string | null;
 *   mode: string | null;
 *   heartbeatMs: number | null;
 *   lastHeartbeat: number;
 *   shellSinceHeartbeat: boolean;
 *   gitMemory: GitMemory | null;
 *   settingsHash: string | null;
 *   failures: number;
 *   lastAttemptAt: number;
 *   outageSince: number | null;
 *   outageNotified: boolean;
 * }} SessionState
 *
 * @typedef {{ server: string; token: string; repos: string[] }} HookConfig
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const EVENTS = new Set(['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'SessionEnd']);
/** Events whose output can carry additionalContext (Stop can only block, SessionEnd has no output). */
const CONTEXT_EVENTS = new Set(['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse']);
/** The session keeps running after these SessionEnd reasons, so its state is kept. */
const NOT_EXIT = new Set(['clear', 'resume']);
const IDENT_TTL_MS = 10_000;
const LOG_MAX_BYTES = 1_000_000;
const SETTINGS_MAX_BYTES = 64 * 1024;
const STATE_MAX_AGE_MS = 2 * 24 * 60 * 60_000;
const OUTAGE_NOTICE =
  "[Hivemind] Can't reach the server (3 failed attempts). Coordination is paused and edits aren't being checked. Retrying every minute.";

/** @type {{ home: string; event: string | null; tool: string | null; token: string | null; started: number; state: SessionState | null; statePath: string | null }} */
const ctx = {
  home: process.env.HIVEMIND_HOME || join(homedir(), '.hivemind'),
  event: null, tool: null, token: null, started: Date.now(), state: null, statePath: null,
};

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** @returns {Promise<string>} */
async function readStdin() {
  /** @type {Buffer[]} */
  const chunks = [];
  for await (const c of process.stdin) chunks.push(/** @type {Buffer} */ (c));
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * @param {string} s
 * @returns {string}
 */
function sha(s) {
  return createHash('sha256').update(s).digest('hex');
}

/** @returns {SessionState} */
function freshState() {
  return {
    v: 1, idents: {}, callsign: null, mode: null, heartbeatMs: null, lastHeartbeat: 0, shellSinceHeartbeat: false,
    gitMemory: null, settingsHash: null, failures: 0, lastAttemptAt: 0, outageSince: null, outageNotified: false,
  };
}

const stateDir = () => join(tmpdir(), 'hivemind-hook');

/**
 * @param {string} session
 * @returns {string}
 */
function statePathFor(session) {
  return join(stateDir(), `${sha(session).slice(0, 32)}.json`);
}

/**
 * @param {string} path
 * @returns {SessionState}
 */
function loadState(path) {
  try {
    const s = JSON.parse(readFileSync(path, 'utf8'));
    if (s && s.v === 1 && typeof s.idents === 'object') return { ...freshState(), ...s };
  } catch { /* missing or corrupt: start over */ }
  return freshState();
}

/** Write atomically (a parallel hook process may be writing too; the last writer wins). */
function saveState() {
  if (!ctx.state || !ctx.statePath) return;
  try {
    mkdirSync(stateDir(), { recursive: true });
    const tmp = `${ctx.statePath}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(ctx.state), { mode: 0o600 });
    try {
      renameSync(tmp, ctx.statePath);
    } catch {
      writeFileSync(ctx.statePath, JSON.stringify(ctx.state), { mode: 0o600 });
      try { unlinkSync(tmp); } catch { /* ignore */ }
    }
  } catch { /* state is a cache; losing it only costs a lookup */ }
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
 * One JSON line per network attempt or caught error. Never tokens or message text.
 * @param {boolean} ok
 * @param {unknown} [error]
 * @param {number} [ms]
 */
function log(ok, error, ms) {
  try {
    if (!existsSync(ctx.home)) return;
    const path = join(ctx.home, 'hook.log');
    try {
      if (statSync(path).size > LOG_MAX_BYTES) renameSync(path, `${path}.1`);
    } catch { /* no log yet */ }
    let msg = error === undefined ? undefined : String(error instanceof Error ? `${error.name}: ${error.message}` : error);
    if (msg !== undefined && ctx.token) msg = msg.split(ctx.token).join('[token]');
    appendFileSync(path, `${JSON.stringify({
      ts: Date.now(), event: ctx.event, tool: ctx.tool, ok, ms: ms ?? Date.now() - ctx.started, ...(msg !== undefined ? { error: msg.slice(0, 300) } : {}),
    })}\n`);
  } catch { /* logging must never break the hook */ }
}

/**
 * @param {string} home
 * @returns {HookConfig | null}
 */
function readConfig(home) {
  try {
    const c = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8'));
    if (typeof c?.server !== 'string' || typeof c?.token !== 'string' || !Array.isArray(c?.repos)) return null;
    if (!/^https?:\/\//.test(c.server)) return null;
    return { server: c.server.replace(/\/+$/, ''), token: c.token, repos: c.repos.filter((/** @type {unknown} */ r) => typeof r === 'string') };
  } catch {
    return null;
  }
}

/**
 * .hivemind/project.json from the checkout, parsed, with a hash of its text. Null when absent or unusable.
 * @param {string} root
 * @returns {{ settings: Record<string, unknown>; hash: string } | null}
 */
function readSettings(root) {
  try {
    const path = join(root, '.hivemind', 'project.json');
    if (statSync(path).size > SETTINGS_MAX_BYTES) return null;
    const text = readFileSync(path, 'utf8');
    const settings = JSON.parse(text);
    if (typeof settings !== 'object' || settings === null || Array.isArray(settings)) return null;
    return { settings, hash: sha(text) };
  } catch {
    return null;
  }
}

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
  /** @type {LastPush[]} */
  const lastPush = [];
  if (Array.isArray(r.lastPush)) {
    for (const p of r.lastPush) {
      if (typeof p === 'object' && p !== null && typeof p.path === 'string' && typeof p.sha === 'string' && typeof p.blob === 'string'
        && typeof p.by === 'string' && typeof p.branch === 'string' && typeof p.at === 'number') {
        lastPush.push({ path: p.path, sha: p.sha, blob: p.blob, by: p.by, branch: p.branch, at: p.at });
      }
    }
  }
  return {
    decision: r.decision,
    reason: typeof r.reason === 'string' ? r.reason : null,
    context: typeof r.context === 'string' ? r.context : null,
    callsign: typeof r.callsign === 'string' ? r.callsign : '',
    lastPush,
    heartbeatMs: r.heartbeatMs,
    mode: r.mode === 'enforce' || r.mode === 'warn' || r.mode === 'off' ? r.mode : 'enforce',
  };
}

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
      signal: ac.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return validateResponse(JSON.parse(await res.text()));
  } finally {
    clearTimeout(timer);
  }
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
 * @param {ParsedHookInput} input
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

/**
 * Failed network attempt: count it, and say so once when the circuit breaker opens.
 * @param {SessionState} state
 * @param {number} now
 * @param {string} event
 * @returns {HookOutcome | null}
 */
function recordFailure(state, now, event) {
  state.failures += 1;
  state.lastAttemptAt = now;
  if (state.failures === 1) state.outageSince = now;
  return outageNotice(state, event);
}

/**
 * @param {SessionState} state
 * @param {string} event
 * @returns {HookOutcome | null}
 */
function outageNotice(state, event) {
  const { HOOK_LIMITS } = /** @type {{ HOOK_LIMITS: typeof import('./limits.mjs').HOOK_LIMITS }} */ (limitsModule);
  if (state.failures < HOOK_LIMITS.breakerFailures || state.outageNotified || !CONTEXT_EVENTS.has(event)) return null;
  state.outageNotified = true;
  return { decision: 'allow', reason: null, context: OUTAGE_NOTICE };
}

/** @type {unknown} */
let limitsModule = null;

/**
 * @returns {Promise<{ out: HookOutcome | null; event: HookEvent | null; adapter: ToolAdapter | null }>}
 */
async function run() {
  const tool = process.argv[2];
  if (tool !== 'claude' && tool !== 'codex') return { out: null, event: null, adapter: null };

  const stdin = await readStdin();
  const home = ctx.home;
  if (existsSync(join(home, 'off'))) return { out: null, event: null, adapter: null };
  const config = readConfig(home);
  if (!config) return { out: null, event: null, adapter: null };
  ctx.token = config.token;

  limitsModule = await import('./limits.mjs');
  const { HOOK_LIMITS } = /** @type {{ HOOK_LIMITS: typeof import('./limits.mjs').HOOK_LIMITS }} */ (limitsModule);
  /** @type {ToolAdapter} */
  const adapter = impl(await import(tool === 'claude' ? './claude.mjs' : './codex.mjs'));
  /** @type {GitModule} */
  const gitMod = impl(await import('./git.mjs'));

  const input = adapter.parse(JSON.parse(stdin));
  const event = input.event;
  ctx.event = event;
  ctx.tool = input.tool;
  if (!EVENTS.has(event)) return { out: null, event: null, adapter };

  const statePath = statePathFor(input.session);
  const state = loadState(statePath);
  ctx.state = state;
  ctx.statePath = statePath;

  const now = Date.now();
  const done = (/** @type {HookOutcome | null} */ out) => ({ out, event, adapter });

  // Resolve the checkout (cached per cwd) and check that its root commit is mapped.
  const cached = state.idents[input.cwd];
  /** @type {Identity | null} */
  let ident = cached ? cached.ident : null;
  if (!ident) {
    ident = await gitMod.identity(input.cwd);
    if (!ident) return done(null);
    state.idents[input.cwd] = { ident, at: now };
    saveState();
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
  if (event === 'SessionStart') {
    state.lastHeartbeat = 0;
    state.shellSinceHeartbeat = false;
    state.gitMemory = null;
    state.settingsHash = null;
    state.heartbeatMs = null;
    pruneStates();
  }
  if (event === 'PostToolUse') {
    if (input.isShell) state.shellSinceHeartbeat = true;
    if (state.heartbeatMs === 0) {
      saveState();
      return done(null);
    }
    const interval = state.heartbeatMs ?? HOOK_LIMITS.heartbeatMs;
    if (!state.shellSinceHeartbeat && now < state.lastHeartbeat + interval) {
      saveState();
      return done(null);
    }
  }

  // Circuit breaker: skip the network while it is open.
  if (state.failures >= HOOK_LIMITS.breakerFailures && now - state.lastAttemptAt < HOOK_LIMITS.breakerOpenMs) {
    const out = outageNotice(state, event);
    saveState();
    return done(out);
  }

  // Fresh branch and head for anything that goes to the network (SessionEnd uses the cache).
  if (event !== 'SessionEnd' && now - (state.idents[input.cwd]?.at ?? 0) > IDENT_TTL_MS) {
    const fresh = await gitMod.identity(input.cwd);
    if (fresh && fresh.repo === ident.repo) {
      ident = fresh;
      state.idents[input.cwd] = { ident, at: now };
    }
  }

  /** @type {HookRequest} */
  const req = {
    v: 1, event, agent: tool, session: input.session,
    repo: ident.repo, checkout: sha(`${hostname()}\n${ident.root}`).slice(0, 16),
    branch: ident.branch, head: ident.head,
  };
  if (input.tool) req.tool = input.tool;
  if (ident.repoName) req.repoName = ident.repoName;
  if (event === 'PreToolUse') req.paths = paths;
  if (event === 'Stop') req.stopActive = input.stopActive;
  if (event === 'SessionEnd') req.endReason = input.endReason;

  // Git state (§6.3 step 9): not on PreToolUse or SessionEnd, and not while heartbeats are off.
  /** @type {GitMemory | null} */
  let newMemory = null;
  const wantsGit = event === 'SessionStart'
    || ((event === 'UserPromptSubmit' || event === 'Stop' || event === 'PostToolUse') && state.heartbeatMs !== 0);
  if (wantsGit) {
    try {
      const s = await gitMod.state(ident.root, event === 'SessionStart' ? null : state.gitMemory);
      /** @type {GitStateReport} */
      const report = { ...s.report };
      if (event === 'SessionStart') report.baseline ??= report.divergent;
      else delete report.baseline;
      req.git = report;
      req.shellSinceHeartbeat = state.shellSinceHeartbeat;
      newMemory = s.memory;
    } catch (e) {
      log(false, e);
    }
  }

  // Settings: on SessionStart and whenever the file changes.
  const settings = event === 'SessionEnd' ? null : readSettings(ident.root);
  const sendSettings = settings !== null && settings.hash !== state.settingsHash;
  if (settings && sendSettings) req.settings = /** @type {any} */ (settings.settings);

  if (state.failures >= HOOK_LIMITS.breakerFailures && state.outageSince !== null) req.outageMs = Math.max(1, now - state.outageSince);

  const t0 = Date.now();
  /** @type {HookResponse} */
  let resp;
  try {
    resp = await post(config, req, event === 'SessionEnd' ? HOOK_LIMITS.sessionEndTimeoutMs : HOOK_LIMITS.hookTimeoutMs);
    log(true, undefined, Date.now() - t0);
  } catch (e) {
    log(false, e, Date.now() - t0);
    const out = recordFailure(state, Date.now(), event);
    saveState();
    return done(out);
  }

  // Success.
  state.failures = 0;
  state.lastAttemptAt = Date.now();
  state.outageSince = null;
  state.outageNotified = false;
  if (resp.callsign) state.callsign = resp.callsign;
  state.mode = resp.mode;
  state.heartbeatMs = resp.heartbeatMs;
  if (req.git) {
    state.lastHeartbeat = Date.now();
    state.shellSinceHeartbeat = false;
    if (newMemory) state.gitMemory = newMemory;
  }
  if (settings && sendSettings) state.settingsHash = settings.hash;

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
  if (event === 'PreToolUse' && outcome.decision !== 'deny' && resp.lastPush && resp.lastPush.length > 0) {
    try {
      const lines = await gitMod.staleWarnings(ident.root, ident.branch, resp.lastPush);
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
    ctx.state = null;
  } else {
    saveState();
  }
  return done(outcome);
}

/**
 * @param {string | null} out
 */
function finish(out) {
  if (out) process.stdout.write(out, () => process.exit(0));
  else process.exit(0);
  setTimeout(() => process.exit(0), 500).unref();
}

// Never run longer than the tool's own timeout (5 s; 3 s for SessionEnd).
const watchdog = setTimeout(() => process.exit(0), 3_500);
watchdog.unref();

try {
  const { out, event, adapter } = await run();
  clearTimeout(watchdog);
  finish(out && adapter && event ? adapter.format(event, out) : null);
} catch (e) {
  log(false, e);
  try {
    // Any error counts as a failure towards the circuit breaker, if we got far enough to have a session.
    if (ctx.state) {
      ctx.state.failures += 1;
      ctx.state.lastAttemptAt = Date.now();
      if (ctx.state.failures === 1) ctx.state.outageSince = Date.now();
      saveState();
    }
  } catch { /* ignore */ }
  finish(null);
}
