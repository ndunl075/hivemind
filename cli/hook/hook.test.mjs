// @ts-nocheck -- tests use loosely typed fixtures and a fake server; the code under test is type-checked.
/**
 * End-to-end tests for hook.mjs: the real script runs as a child process against a fake /hook server on an
 * ephemeral port, with HIVEMIND_HOME and the OS temp directory (where the per-session state lives) pointed at
 * temporary folders, and a throwaway Git repository as the checkout. Nothing here touches a real laptop's setup.
 */
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { LIMITS } from '../../shared/contracts.ts';
import { HOOK_LIMITS } from './limits.mjs';

const HOOK_DIR = new URL('./', import.meta.url);
const HOOK_FILES = ['hook.mjs', 'claude.mjs', 'codex.mjs', 'git.mjs', 'limits.mjs'];
const FIXTURES = new URL('../../shared/fixtures/hooks/claude/', import.meta.url);
const FAKE_AGENT_CRED = ['hm_a', 'test', 'nobody', '1', 'AAAA'].join('.'); // fake; built so secret scanners don't flag the literal
const NOTICE =
  "[Hivemind] Can't reach the server (3 failed attempts). Coordination is paused and edits aren't being checked. Retrying every minute.";

const OK = { decision: 'allow', reason: null, context: null, callsign: 'claude-test', heartbeatMs: 15000, mode: 'enforce' };

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let base;
let repo;
let rootSha;
let sessionCounter = 0;
const cleanups = [];

const git = (args, cwd = repo) => execFileSync('git', args, {
  cwd, encoding: 'utf8',
  env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' },
}).trim();

beforeAll(() => {
  base = realpathSync.native(mkdtempSync(join(tmpdir(), 'hm-hook-')));
  repo = join(base, 'proj');
  mkdirSync(repo);
  git(['init', '-q', '-b', 'main']);
  writeFileSync(join(repo, 'a.txt'), 'a\n');
  git(['add', '.']);
  git(['commit', '-q', '-m', 'one']);
  rootSha = git(['rev-parse', 'HEAD']);
});

afterAll(() => rmSync(base, { recursive: true, force: true }));

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()();
});

/** A fake /hook server. `handler(body, call)` returns a JSON object, or takes the response itself and returns undefined. */
async function fakeServer(handler = () => OK) {
  const requests = [];
  const sockets = new Set();
  const server = createServer((req, res) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => {
      let body = null;
      try { body = JSON.parse(data); } catch { /* keep null */ }
      requests.push({ method: req.method, url: req.url, headers: req.headers, body });
      const out = handler(body, requests.length, res);
      if (out !== undefined) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(out));
      }
    });
  });
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  const close = () => new Promise((r) => { for (const s of sockets) s.destroy(); server.close(() => r()); });
  cleanups.push(close);
  return { url, requests, close };
}

/** A URL where nothing listens. */
async function deadUrl() {
  const s = createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${s.address().port}`;
  await new Promise((r) => s.close(r));
  return url;
}

/**
 * One isolated "laptop": HIVEMIND_HOME, OS temp dir (session state), and optionally a private copy of the hook modules.
 * @param {{ url: string, repos?: string[], copy?: boolean, config?: boolean }} opts
 */
function laptop({ url, repos = [rootSha], copy = false, config = true }) {
  const dir = mkdtempSync(join(base, 'lap-'));
  const home = join(dir, 'home');
  const tmp = join(dir, 'tmp');
  mkdirSync(home);
  mkdirSync(tmp);
  let hookDir = fileUrlToPath(HOOK_DIR);
  if (copy) {
    hookDir = join(dir, 'hook');
    mkdirSync(hookDir);
    for (const f of HOOK_FILES) copyFileSync(new URL(f, HOOK_DIR), join(hookDir, f));
  }
  if (config) writeFileSync(join(home, 'config.json'), JSON.stringify({ server: url, room: 'r', person: 'nobody', token: FAKE_AGENT_CRED, repos }));
  const t = { dir, home, tmp, hookDir, session: `sess-${process.pid}-${++sessionCounter}`, url };
  return t;
}

function fileUrlToPath(u) {
  return decodeURIComponent(u.pathname.replace(/^\/([A-Za-z]:)/, '$1')).replace(/\/$/, '');
}

/** Run hook.mjs with a payload on stdin. */
function run(t, payloadOrText, { tool = 'claude' } = {}) {
  const input = typeof payloadOrText === 'string' ? payloadOrText : JSON.stringify(payloadOrText);
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(process.execPath, [join(t.hookDir, 'hook.mjs'), tool], {
      env: { ...process.env, HIVEMIND_HOME: t.home, TEMP: t.tmp, TMP: t.tmp, TMPDIR: t.tmp },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('close', (code) => resolve({ code, stdout, stderr, ms: Date.now() - t0 }));
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

/** A recorded Claude payload, pointed at the test checkout and the laptop's session. */
function payload(name, t, over = {}) {
  const raw = JSON.parse(readFileSync(new URL(`${name}.json`, FIXTURES), 'utf8'));
  raw.cwd = repo;
  raw.session_id = t.session;
  if (raw.tool_input?.file_path) raw.tool_input.file_path = join(repo, 'a.txt');
  if (raw.tool_input?.notebook_path) raw.tool_input.notebook_path = join(repo, 'n.ipynb');
  return { ...raw, ...over };
}

const stateFile = (t, session = t.session) =>
  join(t.home, 'state', `${createHash('sha256').update(session).digest('hex').slice(0, 32)}.json`);
const readState = (t) => JSON.parse(readFileSync(stateFile(t), 'utf8'));
const editState = (t, fn) => {
  const s = readState(t);
  fn(s);
  writeFileSync(stateFile(t), JSON.stringify(s));
};
const fixtureStdout = (name) => JSON.parse(readFileSync(new URL(`output/${name}.json`, FIXTURES), 'utf8')).stdout;

/** SessionStart, so the laptop has a callsign and heartbeat timing. */
async function start(t) {
  const r = await run(t, payload('SessionStart', t));
  expect(r.code).toBe(0);
  return r;
}

// ---------------------------------------------------------------------------
// Output for every event, request shape
// ---------------------------------------------------------------------------

describe('events: request and exact Claude output', () => {
  it('SessionStart: registers, sends git state with baseline and settings, prints the briefing', async () => {
    mkdirSync(join(repo, '.hivemind'), { recursive: true });
    writeFileSync(join(repo, '.hivemind', 'project.json'), JSON.stringify({ requireTask: false, ignore: ['dist/'] }));
    writeFileSync(join(repo, 'pre-existing.txt'), 'x');
    cleanups.push(() => { rmSync(join(repo, '.hivemind'), { recursive: true, force: true }); rmSync(join(repo, 'pre-existing.txt'), { force: true }); });
    const srv = await fakeServer(() => ({ ...OK, context: '<briefing>' }));
    const t = laptop({ url: srv.url });
    const r = await run(t, payload('SessionStart', t));
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(fixtureStdout('SessionStart.additionalContext'));
    expect(srv.requests).toHaveLength(1);
    const { headers, body, method, url } = srv.requests[0];
    expect(method).toBe('POST');
    expect(url).toBe('/hook');
    expect(headers.authorization).toBe(`Bearer ${FAKE_AGENT_CRED}`);
    expect(body).toMatchObject({
      v: 1, event: 'SessionStart', agent: 'claude', session: t.session, repo: rootSha, branch: 'main',
      git: { upstream: null, truncated: false, pushed: null },
      shellSinceHeartbeat: false,
      settings: { requireTask: false, ignore: ['dist/'] },
    });
    expect(body.git.baseline).toContain('pre-existing.txt');
    expect(body.git.divergent).toContain('pre-existing.txt');
    expect(body.head).toBe(rootSha.slice(0, 7));
    expect(body.checkout).toMatch(/^[0-9a-f]{16}$/);
    expect(body).not.toHaveProperty('tool');
    expect(readState(t).callsign).toBe('claude-test');
  });

  it('SessionStart.resume is handled like a start', async () => {
    const srv = await fakeServer();
    const t = laptop({ url: srv.url });
    expect((await run(t, payload('SessionStart.resume', t))).code).toBe(0);
    expect(srv.requests[0].body.event).toBe('SessionStart');
  });

  it('UserPromptSubmit: git state and the unread messages', async () => {
    const srv = await fakeServer((b) => (b.event === 'UserPromptSubmit' ? { ...OK, context: '<unread-messages>' } : OK));
    const t = laptop({ url: srv.url });
    await start(t);
    const r = await run(t, payload('UserPromptSubmit', t));
    expect(r.stdout).toBe(fixtureStdout('UserPromptSubmit.additionalContext'));
    const body = srv.requests[1].body;
    expect(body.event).toBe('UserPromptSubmit');
    expect(body.git).toMatchObject({ truncated: false });
    expect(body.git).not.toHaveProperty('baseline');
  });

  it('PreToolUse deny: the exact Claude deny shape, with the normalized path in the request', async () => {
    const srv = await fakeServer(() => ({ ...OK, decision: 'deny', reason: '<reason>' }));
    const t = laptop({ url: srv.url });
    const r = await run(t, payload('PreToolUse.Edit', t));
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(fixtureStdout('PreToolUse.deny'));
    expect(srv.requests[0].body).toMatchObject({ event: 'PreToolUse', tool: 'Edit', paths: ['a.txt'] });
    expect(srv.requests[0].body).not.toHaveProperty('git');
  });

  it('PreToolUse deny with context, and allow with context', async () => {
    let mode = 'deny';
    const srv = await fakeServer(() => (mode === 'deny'
      ? { ...OK, decision: 'deny', reason: '<reason>', context: '<context>' }
      : { ...OK, decision: 'allow', context: '<context>' }));
    const t = laptop({ url: srv.url });
    expect((await run(t, payload('PreToolUse.Write', t))).stdout).toBe(fixtureStdout('PreToolUse.deny-with-context'));
    mode = 'allow';
    expect((await run(t, payload('PreToolUse.NotebookEdit', t))).stdout).toBe(fixtureStdout('PreToolUse.additionalContext'));
    expect(srv.requests[1].body.paths).toEqual(['n.ipynb']);
  });

  it('PreToolUse allow with nothing to say prints nothing', async () => {
    const srv = await fakeServer(() => ({ ...OK, decision: 'allow' }));
    const t = laptop({ url: srv.url });
    const r = await run(t, payload('PreToolUse.Edit', t));
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('');
  });

  it('PreToolUse for a path outside the checkout or under .git/ makes no request', async () => {
    const srv = await fakeServer();
    const t = laptop({ url: srv.url });
    const outside = payload('PreToolUse.Edit', t);
    outside.tool_input.file_path = join(base, 'elsewhere.txt');
    const inGit = payload('PreToolUse.Write', t);
    inGit.tool_input.file_path = join(repo, '.git', 'hooks', 'x');
    for (const p of [outside, inGit]) {
      const r = await run(t, p);
      expect(r.code).toBe(0);
      expect(r.stdout).toBe('');
    }
    expect(srv.requests).toHaveLength(0);
  });

  it('PreToolUse for other tools (Read, Grep) makes no request', async () => {
    const srv = await fakeServer();
    const t = laptop({ url: srv.url });
    for (const n of ['PreToolUse.Read', 'PreToolUse.Grep', 'PreToolUse.Bash']) expect((await run(t, payload(n, t))).stdout).toBe('');
    expect(srv.requests).toHaveLength(0);
  });

  it('PostToolUse: a forced heartbeat after a shell command delivers messages', async () => {
    const srv = await fakeServer((b) => (b.event === 'PostToolUse' ? { ...OK, context: '<context>' } : OK));
    const t = laptop({ url: srv.url });
    await start(t);
    const r = await run(t, payload('PostToolUse.Bash', t));
    expect(r.stdout).toBe(fixtureStdout('PostToolUse.additionalContext'));
    expect(srv.requests[1].body).toMatchObject({ event: 'PostToolUse', tool: 'Bash', shellSinceHeartbeat: true });
    expect(srv.requests[1].body.git).toBeTruthy();
  });

  it('Stop: git state, and a block with the direct messages', async () => {
    const srv = await fakeServer((b) => (b.event === 'Stop' ? { ...OK, decision: 'block', reason: '<direct-message>' } : OK));
    const t = laptop({ url: srv.url });
    await start(t);
    const r = await run(t, payload('Stop', t));
    expect(r.stdout).toBe(fixtureStdout('Stop.block'));
    expect(srv.requests[1].body).toMatchObject({ event: 'Stop', stopActive: false });
    expect(srv.requests[1].body.git).toBeTruthy();
  });

  it('Stop with stop_hook_active sends stopActive and never blocks again', async () => {
    const srv = await fakeServer((b) => (b.event === 'Stop' ? { ...OK, decision: 'block', reason: 'again' } : OK));
    const t = laptop({ url: srv.url });
    const r = await run(t, payload('Stop.stop_hook_active', t));
    expect(srv.requests[0].body.stopActive).toBe(true);
    expect(r.stdout).toBe('');
  });

  it('SessionEnd: sends the reason, prints nothing, forgets the session', async () => {
    const srv = await fakeServer();
    const t = laptop({ url: srv.url });
    await start(t);
    expect(existsSync(stateFile(t))).toBe(true);
    const r = await run(t, payload('SessionEnd.other', t));
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('');
    expect(srv.requests[1].body).toMatchObject({ event: 'SessionEnd', endReason: 'other' });
    expect(srv.requests[1].body).not.toHaveProperty('git');
    expect(existsSync(stateFile(t))).toBe(false);
  });

  it('SessionEnd for clear or resume keeps the session state', async () => {
    const srv = await fakeServer();
    const t = laptop({ url: srv.url });
    await start(t);
    await run(t, payload('SessionEnd.other', t, { reason: 'clear' }));
    expect(srv.requests[1].body.endReason).toBe('clear');
    expect(existsSync(stateFile(t))).toBe(true);
  });

  it('subagent events (agent_id) count as the parent session', async () => {
    const srv = await fakeServer();
    const t = laptop({ url: srv.url });
    await run(t, payload('PreToolUse.Edit', t, { agent_id: 'sub-1', agent_type: 'general-purpose' }));
    expect(srv.requests[0].body.session).toBe(t.session);
  });

  it('every recorded Claude input fixture exits 0 without crashing', async () => {
    const srv = await fakeServer();
    const t = laptop({ url: srv.url });
    for (const f of readdirSync(FIXTURES).filter((n) => n.endsWith('.json'))) {
      const r = await run(t, payload(f.replace(/\.json$/, ''), t));
      expect(r.code, f).toBe(0);
      expect(r.stderr, f).toBe('');
    }
  }, 60000);
});

// ---------------------------------------------------------------------------
// Local checks, no network
// ---------------------------------------------------------------------------

describe('local checks', () => {
  it('the me check denies a wrong callsign without any network call, and lets the right one through', async () => {
    const srv = await fakeServer();
    const t = laptop({ url: srv.url });
    await start(t);
    expect(srv.requests).toHaveLength(1);

    const wrong = await run(t, payload('PreToolUse.mcp__hivemind__status', t, { tool_input: { me: 'claude-bob' } }));
    const out = JSON.parse(wrong.stdout);
    expect(out.hookSpecificOutput.hookEventName).toBe('PreToolUse');
    expect(out.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain('claude-test');
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain('claude-bob');

    const right = await run(t, payload('PreToolUse.mcp__hivemind__status', t, { tool_input: { me: 'claude-test' } }));
    expect(right.stdout).toBe('');
    expect(srv.requests).toHaveLength(1);
  });

  it('the me check still works during an outage, and does nothing before a callsign is known', async () => {
    const t = laptop({ url: await deadUrl() });
    expect((await run(t, payload('PreToolUse.mcp__hivemind__status', t, { tool_input: { me: 'claude-bob' } }))).stdout).toBe('');
    editState(t, (s) => { s.callsign = 'claude-test'; });
    const r = await run(t, payload('PreToolUse.mcp__hivemind__status', t, { tool_input: { me: 'claude-bob' } }));
    expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision).toBe('deny');
  });

  it('an unmapped repo: exit 0, no output, no network', async () => {
    const srv = await fakeServer();
    const t = laptop({ url: srv.url, repos: ['0000000000000000000000000000000000000000'] });
    for (const n of ['SessionStart', 'UserPromptSubmit', 'PreToolUse.Edit', 'PostToolUse.Bash', 'Stop', 'SessionEnd.other']) {
      const r = await run(t, payload(n, t));
      expect(r.code, n).toBe(0);
      expect(r.stdout, n).toBe('');
    }
    expect(srv.requests).toHaveLength(0);
  });

  it('no config.json: exit 0, no output, no network', async () => {
    const srv = await fakeServer();
    const t = laptop({ url: srv.url, config: false });
    const r = await run(t, payload('SessionStart', t));
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('');
    expect(srv.requests).toHaveLength(0);
  });

  it('the off file: exit 0, no output, no network', async () => {
    const srv = await fakeServer(() => ({ ...OK, decision: 'deny', reason: 'x', context: 'y' }));
    const t = laptop({ url: srv.url });
    writeFileSync(join(t.home, 'off'), '');
    for (const n of ['SessionStart', 'PreToolUse.Edit', 'Stop']) {
      const r = await run(t, payload(n, t));
      expect(r.code, n).toBe(0);
      expect(r.stdout, n).toBe('');
    }
    expect(srv.requests).toHaveLength(0);
  });

  it('HIVEMIND_HOME decides which config is used', async () => {
    const srv = await fakeServer();
    const t = laptop({ url: srv.url });
    const other = laptop({ url: srv.url, config: false });
    await run(other, payload('SessionStart', other)); // other home has no config
    expect(srv.requests).toHaveLength(0);
    await run(t, payload('SessionStart', t));
    expect(srv.requests).toHaveLength(1);
  });

  it('bad or empty stdin, unknown event, unknown tool: exit 0, quiet', async () => {
    const srv = await fakeServer();
    const t = laptop({ url: srv.url });
    for (const input of ['', 'not json', '[]', '{}', JSON.stringify(payload('Stop', t, { hook_event_name: 'Bogus' }))]) {
      const r = await run(t, input);
      expect(r.code).toBe(0);
      expect(r.stdout).toBe('');
    }
    const r = await run(t, payload('Stop', t), { tool: 'nope' });
    expect(r.code).toBe(0);
    expect(srv.requests).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Heartbeats
// ---------------------------------------------------------------------------

describe('heartbeat throttling', () => {
  it('PostToolUse sends nothing between heartbeats, then a forced one after a shell command', async () => {
    const srv = await fakeServer();
    const t = laptop({ url: srv.url });
    await start(t);
    await run(t, payload('PostToolUse.Read', t));
    await run(t, payload('PostToolUse.Grep', t));
    expect(srv.requests).toHaveLength(1);

    await run(t, payload('PostToolUse.Bash', t));
    expect(srv.requests).toHaveLength(2);
    expect(srv.requests[1].body.shellSinceHeartbeat).toBe(true);

    await run(t, payload('PostToolUse.Read', t));
    expect(srv.requests).toHaveLength(2); // the forced heartbeat reset the timer and the flag
    expect((readState(t).shellSeq > readState(t).shellAck)).toBe(false);
  });

  it('PowerShell counts as a shell, and a shell flag survives until a heartbeat succeeds', async () => {
    let fail = true;
    const srv = await fakeServer((b, n, res) => {
      if (n > 1 && fail) { res.writeHead(500); res.end(); return undefined; }
      return OK;
    });
    const t = laptop({ url: srv.url });
    await start(t);
    await run(t, payload('PostToolUse.PowerShell', t)); // fails
    expect((readState(t).shellSeq > readState(t).shellAck)).toBe(true);
    fail = false;
    await run(t, payload('PostToolUse.Read', t)); // not a shell, but the flag forces a heartbeat
    expect(srv.requests).toHaveLength(3);
    expect(srv.requests[2].body.shellSinceHeartbeat).toBe(true);
    expect((readState(t).shellSeq > readState(t).shellAck)).toBe(false);
  });

  it('PostToolUse sends a heartbeat once heartbeatMs has passed', async () => {
    const srv = await fakeServer();
    const t = laptop({ url: srv.url });
    await start(t);
    editState(t, (s) => { s.lastHeartbeat = Date.now() - 16_000; });
    await run(t, payload('PostToolUse.Read', t));
    expect(srv.requests).toHaveLength(2);
    expect(srv.requests[1].body.git).toBeTruthy();
    expect(srv.requests[1].body.shellSinceHeartbeat).toBe(false);
  });

  it('heartbeatMs from the server sets the interval', async () => {
    const srv = await fakeServer(() => ({ ...OK, heartbeatMs: 60_000 }));
    const t = laptop({ url: srv.url });
    await start(t);
    editState(t, (s) => { s.lastHeartbeat = Date.now() - 30_000; });
    await run(t, payload('PostToolUse.Read', t));
    expect(srv.requests).toHaveLength(1);
    editState(t, (s) => { s.lastHeartbeat = Date.now() - 61_000; });
    await run(t, payload('PostToolUse.Read', t));
    expect(srv.requests).toHaveLength(2);
  });

  it('heartbeatMs 0: no PostToolUse requests (even after a shell), no git state on UserPromptSubmit or Stop', async () => {
    const srv = await fakeServer(() => ({ ...OK, heartbeatMs: 0 }));
    const t = laptop({ url: srv.url });
    await start(t);
    expect(srv.requests[0].body.git).toBeTruthy(); // SessionStart still reports its baseline
    await run(t, payload('PostToolUse.Bash', t));
    await run(t, payload('PostToolUse.Read', t));
    expect(srv.requests).toHaveLength(1);

    await run(t, payload('UserPromptSubmit', t));
    await run(t, payload('Stop', t));
    expect(srv.requests).toHaveLength(3);
    for (const r of srv.requests.slice(1)) expect(r.body).not.toHaveProperty('git');

    // Edits are still checked.
    await run(t, payload('PreToolUse.Edit', t));
    expect(srv.requests).toHaveLength(4);
  });

  it('settings are sent on SessionStart and again only when project.json changes', async () => {
    const file = join(repo, '.hivemind', 'project.json');
    mkdirSync(join(repo, '.hivemind'), { recursive: true });
    writeFileSync(file, JSON.stringify({ requireTask: true }));
    cleanups.push(() => rmSync(join(repo, '.hivemind'), { recursive: true, force: true }));
    const srv = await fakeServer();
    const t = laptop({ url: srv.url });
    await start(t);
    await run(t, payload('UserPromptSubmit', t));
    expect(srv.requests[0].body.settings).toEqual({ requireTask: true });
    expect(srv.requests[1].body).not.toHaveProperty('settings');
    writeFileSync(file, JSON.stringify({ requireTask: false }));
    await run(t, payload('UserPromptSubmit', t));
    expect(srv.requests[2].body.settings).toEqual({ requireTask: false });
    await run(t, payload('UserPromptSubmit', t));
    expect(srv.requests[3].body).not.toHaveProperty('settings');
  });

  it('a broken project.json is ignored', async () => {
    mkdirSync(join(repo, '.hivemind'), { recursive: true });
    writeFileSync(join(repo, '.hivemind', 'project.json'), '{ nope');
    cleanups.push(() => rmSync(join(repo, '.hivemind'), { recursive: true, force: true }));
    const srv = await fakeServer();
    const t = laptop({ url: srv.url });
    await start(t);
    expect(srv.requests[0].body).not.toHaveProperty('settings');
  });
});

// ---------------------------------------------------------------------------
// Git module interface (stubbed)
// ---------------------------------------------------------------------------

describe('git.mjs interface, stubbed', () => {
  const stub = (extra = '') => `
export async function identity() { return { root: ${JSON.stringify(repo)}, repo: ${JSON.stringify(rootSha)}, repoName: 'widgets', branch: 'main', head: 'abc1234' }; }
export function normalize(root, cwd, paths) { return paths.map(() => 'src/auth/login.ts'); }
export async function state(root, previous) {
  return {
    report: { divergent: ['src/auth/login.ts'], upstream: 'origin/main', truncated: false,
      pushed: { branch: 'main', sha: 'c3d4e5f', files: [{ path: 'src/auth/login.ts', blob: '9a1f' }] },
      ...(previous === null ? { baseline: ['old.txt'] } : {}) },
    memory: { comparison: { name: 'origin/main', sha: 'c3d4e5f' }, divergent: ['src/auth/login.ts'] },
  };
}
${extra}`;
  const WARNING = 'codex-ana pushed changes to this file 4m ago. Fetch and pull first.';
  const LAST_PUSH = [{ path: 'src/auth/login.ts', sha: 'c3d4e5f', blob: '9a1f', by: 'codex-ana', branch: 'main', at: 1761000000000 }];

  it('a push and a stale copy produce git.pushed and the warning text', async () => {
    const srv = await fakeServer((b) => (b.event === 'PreToolUse' ? { ...OK, lastPush: LAST_PUSH, context: 'server note' } : OK));
    const t = laptop({ url: srv.url, copy: true });
    writeFileSync(join(t.hookDir, 'git.mjs'), stub(`
export async function staleWarnings(root, branch, lastPush) {
  return lastPush.length === 1 && branch === 'main' ? [${JSON.stringify(WARNING)}] : [];
}`));

    await start(t);
    const start0 = srv.requests[0].body;
    expect(start0.repoName).toBe('widgets');
    expect(start0.git).toEqual({
      divergent: ['src/auth/login.ts'], baseline: ['old.txt'], upstream: 'origin/main', truncated: false,
      pushed: { branch: 'main', sha: 'c3d4e5f', files: [{ path: 'src/auth/login.ts', blob: '9a1f' }] },
    });

    await run(t, payload('UserPromptSubmit', t));
    expect(srv.requests[1].body.git.pushed).toEqual({ branch: 'main', sha: 'c3d4e5f', files: [{ path: 'src/auth/login.ts', blob: '9a1f' }] });
    expect(srv.requests[1].body.git).not.toHaveProperty('baseline');

    const r = await run(t, payload('PreToolUse.Edit', t));
    const ctx = JSON.parse(r.stdout).hookSpecificOutput;
    expect(ctx.hookEventName).toBe('PreToolUse');
    expect(ctx).not.toHaveProperty('permissionDecision');
    expect(ctx.additionalContext).toContain('server note');
    expect(ctx.additionalContext).toContain(WARNING);
    expect(srv.requests[2].body.paths).toEqual(['src/auth/login.ts']);
  });

  it('a stale-check failure drops only the warning, and a deny gets no warning', async () => {
    const srv = await fakeServer((b) => (b.event === 'PreToolUse' ? { ...OK, lastPush: LAST_PUSH, context: 'server note' } : OK));
    const t = laptop({ url: srv.url, copy: true });
    writeFileSync(join(t.hookDir, 'git.mjs'), stub('export async function staleWarnings() { throw new Error("boom"); }'));
    const r = await run(t, payload('PreToolUse.Edit', t));
    expect(JSON.parse(r.stdout).hookSpecificOutput.additionalContext).toBe('server note');

    const denySrv = await fakeServer(() => ({ ...OK, decision: 'deny', reason: 'held', lastPush: LAST_PUSH }));
    const t2 = laptop({ url: denySrv.url, copy: true });
    writeFileSync(join(t2.hookDir, 'git.mjs'), stub(`export async function staleWarnings() { return [${JSON.stringify(WARNING)}]; }`));
    const out = JSON.parse((await run(t2, payload('PreToolUse.Edit', t2))).stdout).hookSpecificOutput;
    expect(out.permissionDecision).toBe('deny');
    expect(out).not.toHaveProperty('additionalContext');
  });

  it('git state is remembered between heartbeats only after the server accepted the request', async () => {
    let fail = false;
    const srv = await fakeServer((b, n, res) => {
      if (fail) { res.writeHead(500); res.end(); return undefined; }
      return OK;
    });
    const t = laptop({ url: srv.url, copy: true });
    writeFileSync(join(t.hookDir, 'git.mjs'), stub('export async function staleWarnings() { return []; }'));
    await start(t);
    expect(readState(t).gitMemory.comparison.sha).toBe('c3d4e5f');
    editState(t, (s) => { s.gitMemory = { comparison: null, divergent: [] }; });
    fail = true;
    await run(t, payload('UserPromptSubmit', t));
    expect(readState(t).gitMemory).toEqual({ comparison: null, divergent: [] });
  });

  it('a git.mjs whose state() throws sends the request without git state', async () => {
    const srv = await fakeServer();
    const t = laptop({ url: srv.url, copy: true });
    writeFileSync(join(t.hookDir, 'git.mjs'), `
export async function identity() { return { root: ${JSON.stringify(repo)}, repo: ${JSON.stringify(rootSha)}, repoName: null, branch: 'main', head: 'abc1234' }; }
export function normalize(root, cwd, paths) { return paths.map(() => 'a.txt'); }
export async function state() { throw new Error('git is on fire'); }
export async function staleWarnings() { return []; }`);
    const r = await run(t, payload('UserPromptSubmit', t));
    expect(r.code).toBe(0);
    expect(srv.requests).toHaveLength(1);
    expect(srv.requests[0].body).not.toHaveProperty('git');
  });
});

// ---------------------------------------------------------------------------
// Fail-open
// ---------------------------------------------------------------------------

describe('fail-open: exit 0 within the timeout, nothing printed', () => {
  const failing = {
    'server down': async () => deadUrl(),
    'server returns 500': async () => (await fakeServer((b, n, res) => { res.writeHead(500); res.end('nope'); })).url,
    'server returns garbage': async () => (await fakeServer((b, n, res) => { res.writeHead(200); res.end('<html>not json'); })).url,
    'server returns the wrong shape': async () => (await fakeServer(() => ({ hello: 'world' }))).url,
    'server returns an unknown decision': async () => (await fakeServer(() => ({ ...OK, decision: 'explode' }))).url,
  };
  for (const [name, mk] of Object.entries(failing)) {
    it(name, async () => {
      const t = laptop({ url: await mk() });
      for (const n of ['SessionStart', 'PreToolUse.Edit', 'UserPromptSubmit', 'Stop', 'SessionEnd.other']) {
        const r = await run(t, payload(n, t));
        expect(r.code, n).toBe(0);
        // Silent, except for the one outage notice when the breaker opens (the third failure).
        if (r.stdout !== '') expect(JSON.parse(r.stdout).hookSpecificOutput.additionalContext, n).toBe(NOTICE);
        expect(r.ms, n).toBeLessThan(3000);
      }
    }, 30000);
  }

  it('a slow server: gives up after the network timeout', async () => {
    const srv = await fakeServer((b, n, res) => { /* never answer */ });
    const t = laptop({ url: srv.url });
    const r = await run(t, payload('PreToolUse.Edit', t));
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('');
    expect(r.ms).toBeGreaterThanOrEqual(HOOK_LIMITS.hookTimeoutMs - 100);
    expect(r.ms).toBeLessThan(HOOK_LIMITS.hookTimeoutMs + 1500);
    expect(srv.requests).toHaveLength(1);
  }, 15000);

  it('SessionEnd uses the shorter timeout', async () => {
    const srv = await fakeServer(() => undefined);
    const t = laptop({ url: srv.url });
    const r = await run(t, payload('SessionEnd.other', t));
    expect(r.code).toBe(0);
    expect(r.ms).toBeLessThan(HOOK_LIMITS.hookTimeoutMs);
  }, 15000);

  const broken = {
    'claude.mjs has a syntax error': (t) => writeFileSync(join(t.hookDir, 'claude.mjs'), 'export const = ;'),
    'claude.mjs is missing': (t) => rmSync(join(t.hookDir, 'claude.mjs')),
    'claude.mjs throws on load': (t) => writeFileSync(join(t.hookDir, 'claude.mjs'), 'throw new Error("load failure");'),
    'git.mjs has a syntax error': (t) => writeFileSync(join(t.hookDir, 'git.mjs'), 'this is not javascript'),
    'git.mjs is missing': (t) => rmSync(join(t.hookDir, 'git.mjs')),
    'limits.mjs is missing': (t) => rmSync(join(t.hookDir, 'limits.mjs')),
    'git.mjs has the wrong exports': (t) => writeFileSync(join(t.hookDir, 'git.mjs'), 'export const x = 1;'),
  };
  for (const [name, breakIt] of Object.entries(broken)) {
    it(`a module that fails to load: ${name}`, async () => {
      const srv = await fakeServer(() => ({ ...OK, decision: 'deny', reason: 'x' }));
      const t = laptop({ url: srv.url, copy: true });
      breakIt(t);
      for (const n of ['SessionStart', 'PreToolUse.Edit', 'Stop']) {
        const r = await run(t, payload(n, t));
        expect(r.code, n).toBe(0);
        expect(r.stdout, n).toBe('');
        expect(r.ms, n).toBeLessThan(3000);
      }
      // The failure is logged, without tokens.
      const logText = readFileSync(join(t.home, 'hook.log'), 'utf8');
      expect(logText).not.toContain(FAKE_AGENT_CRED);
      for (const line of logText.trim().split('\n')) {
        const e = JSON.parse(line);
        expect(Object.keys(e).sort()).toEqual(['error', 'event', 'ms', 'ok', 'tool', 'ts']);
        expect(e.ok).toBe(false);
      }
    });
  }

  it('the hook.log has one line per request, with ok, ms and no secrets', async () => {
    let n = 0;
    const srv = await fakeServer((b, i, res) => { if (i === 2) { res.writeHead(500); res.end(); return undefined; } return OK; });
    const t = laptop({ url: srv.url });
    await start(t);
    await run(t, payload('UserPromptSubmit', t));
    const lines = readFileSync(join(t.home, 'hook.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    n = lines.length;
    expect(n).toBe(2);
    expect(lines[0]).toMatchObject({ event: 'SessionStart', tool: null, ok: true });
    expect(lines[1]).toMatchObject({ event: 'UserPromptSubmit', ok: false });
    expect(lines[1].error).toContain('500');
    expect(typeof lines[0].ts).toBe('number');
    expect(typeof lines[0].ms).toBe('number');
    expect(JSON.stringify(lines)).not.toContain(FAKE_AGENT_CRED);
  });

  it('the hook.log rotates at 1 MB', async () => {
    const srv = await fakeServer();
    const t = laptop({ url: srv.url });
    writeFileSync(join(t.home, 'hook.log'), 'x'.repeat(1_000_100));
    await start(t);
    expect(existsSync(join(t.home, 'hook.log.1'))).toBe(true);
    expect(readFileSync(join(t.home, 'hook.log'), 'utf8').trim().split('\n')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Circuit breaker and outage reporting
// ---------------------------------------------------------------------------

describe('circuit breaker and outage notice', () => {
  it('opens after 3 failures, skips the network for 60 s, tells the agent once, then reports outageMs', async () => {
    let healthy = false;
    const srv = await fakeServer((b, n, res) => {
      if (!healthy) { res.writeHead(503); res.end('down'); return undefined; }
      return OK;
    });
    const t = laptop({ url: srv.url });

    // Failures 1 and 2: the agent is not told yet.
    for (let i = 0; i < 2; i++) expect((await run(t, payload('PreToolUse.Edit', t))).stdout).toBe('');
    expect(srv.requests).toHaveLength(2);

    // Failure 3 opens the breaker, and the output says so, as additionalContext on an allowed edit.
    const third = await run(t, payload('PreToolUse.Edit', t));
    expect(JSON.parse(third.stdout)).toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: NOTICE } });
    expect(srv.requests).toHaveLength(3);

    // While open: no network, no repeated notice, every event type is fast and quiet.
    for (const n of ['PreToolUse.Edit', 'UserPromptSubmit', 'PostToolUse.Bash', 'Stop', 'PreToolUse.Write']) {
      const r = await run(t, payload(n, t));
      expect(r.code, n).toBe(0);
      expect(r.stdout, n).toBe('');
    }
    expect(srv.requests).toHaveLength(3);

    // Half-open after 60 s: one attempt goes out, and fails again. No second notice for the same outage.
    editState(t, (s) => { s.lastAttemptAt = Date.now() - 61_000; s.outageSince = Date.now() - 120_000; });
    const retry = await run(t, payload('PreToolUse.Edit', t));
    expect(retry.stdout).toBe('');
    expect(srv.requests).toHaveLength(4);
    expect(srv.requests[3].body.outageMs).toBeGreaterThanOrEqual(120_000);
    await run(t, payload('PreToolUse.Edit', t));
    expect(srv.requests).toHaveLength(4); // open again

    // Recovery: the first success resets the counter and reports the outage length.
    healthy = true;
    editState(t, (s) => { s.lastAttemptAt = Date.now() - 61_000; });
    const ok = await run(t, payload('UserPromptSubmit', t));
    expect(ok.code).toBe(0);
    expect(srv.requests).toHaveLength(5);
    expect(srv.requests[4].body.outageMs).toBeGreaterThanOrEqual(120_000);
    const s = readState(t);
    expect(s.failures).toBe(0);
    expect(s.outageNotified).toBe(false);
    await run(t, payload('UserPromptSubmit', t));
    expect(srv.requests[5].body).not.toHaveProperty('outageMs');

    // A second outage gets its own notice.
    healthy = false;
    for (let i = 0; i < 2; i++) await run(t, payload('PreToolUse.Edit', t));
    const again = await run(t, payload('PreToolUse.Edit', t));
    expect(JSON.parse(again.stdout).hookSpecificOutput.additionalContext).toBe(NOTICE);
  }, 60000);

  it('while the breaker is open nothing waits on the network, even against a hanging server', async () => {
    const srv = await fakeServer(() => undefined); // never answers
    const t = laptop({ url: srv.url });
    await run(t, payload('PreToolUse.mcp__hivemind__status', t)); // creates the session state
    editState(t, (s) => { s.failures = 3; s.lastAttemptAt = Date.now(); s.outageSince = Date.now(); s.outageNotified = true; });
    const r = await run(t, payload('PreToolUse.Edit', t));
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('');
    expect(r.ms).toBeLessThan(HOOK_LIMITS.hookTimeoutMs);
    expect(srv.requests).toHaveLength(0);
  }, 15000);

  it('the notice waits for an event that can carry it (Stop cannot)', async () => {
    const srv = await fakeServer((b, n, res) => { res.writeHead(500); res.end(); return undefined; });
    const t = laptop({ url: srv.url });
    expect((await run(t, payload('PreToolUse.Edit', t))).stdout).toBe('');
    expect((await run(t, payload('PreToolUse.Edit', t))).stdout).toBe('');
    const stop = await run(t, payload('Stop', t)); // failure 3 on an event with no context slot
    expect(stop.stdout).toBe('');
    expect(srv.requests).toHaveLength(3);
    const next = await run(t, payload('UserPromptSubmit', t)); // breaker open: local notice
    expect(JSON.parse(next.stdout).hookSpecificOutput).toEqual({ hookEventName: 'UserPromptSubmit', additionalContext: NOTICE });
    expect(srv.requests).toHaveLength(3);
    expect((await run(t, payload('UserPromptSubmit', t))).stdout).toBe('');
  });

  it('errors that are not network errors also count towards the breaker', async () => {
    const srv = await fakeServer();
    const t = laptop({ url: srv.url, copy: true });
    writeFileSync(join(t.hookDir, 'git.mjs'), `
export async function identity() { return { root: ${JSON.stringify(repo)}, repo: ${JSON.stringify(rootSha)}, repoName: null, branch: 'main', head: 'abc' }; }
export function normalize() { throw new Error('normalize failed'); }
export async function state() { return { report: { divergent: [], upstream: null, truncated: false, pushed: null }, memory: { comparison: null, divergent: [] } }; }
export async function staleWarnings() { return []; }`);
    for (let i = 0; i < 3; i++) {
      const r = await run(t, payload('PreToolUse.Edit', t));
      expect(r.code).toBe(0);
      expect(r.stdout).toBe('');
    }
    expect(readState(t).failures).toBe(3);
    expect(srv.requests).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Review fixes: state races, deadline, settings, config, validation, caps
// ---------------------------------------------------------------------------

const STUB_IDENTITY = () => `
export async function identity() { return { root: ${JSON.stringify(repo)}, repo: ${JSON.stringify(rootSha)}, repoName: null, branch: 'main', head: 'abc1234' }; }
export function normalize(root, cwd, paths) { return paths.map(() => 'a.txt'); }
`;
const EMPTY_REPORT = '{ report: { divergent: [], upstream: null, truncated: false, pushed: null }, memory: { comparison: null, divergent: [] } }';

describe('session state: races and location', () => {
  it('lives under HIVEMIND_HOME/state, never in the OS temp folder; no temp files are left behind', async () => {
    const srv = await fakeServer();
    const t = laptop({ url: srv.url });
    await start(t);
    expect(existsSync(stateFile(t))).toBe(true);
    expect(readdirSync(t.tmp)).toEqual([]);
    expect(readdirSync(join(t.home, 'state')).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    if (process.platform !== 'win32') expect(statSync(join(t.home, 'state')).mode & 0o077).toBe(0);
  });

  it('parallel hook processes leave a valid state file, with nothing lost that was written before', async () => {
    const srv = await fakeServer();
    const t = laptop({ url: srv.url });
    await start(t);
    const runs = [];
    for (let i = 0; i < 4; i++) {
      runs.push(run(t, payload('PostToolUse.Bash', t)), run(t, payload('UserPromptSubmit', t)), run(t, payload('PostToolUse.PowerShell', t)));
    }
    const results = await Promise.all(runs);
    for (const r of results) expect(r.code).toBe(0);
    const s = readState(t); // parses
    expect(s.callsign).toBe('claude-test');
    expect(Object.keys(s.idents)).toHaveLength(1);
    expect(s.shellSeq).toBeGreaterThanOrEqual(1);
    expect(s.failures).toBe(0);
    expect(readdirSync(join(t.home, 'state')).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  }, 30000);

  it('parallel failures all count or at least one does, and the notice is claimed at most once', async () => {
    const t = laptop({ url: await deadUrl() });
    await run(t, payload('PreToolUse.mcp__hivemind__status', t)); // create state
    editState(t, (s) => { s.failures = 2; s.lastAttemptAt = 0; });
    const results = await Promise.all([1, 2, 3, 4].map(() => run(t, payload('PreToolUse.Edit', t))));
    const notices = results.filter((r) => r.stdout.includes("Can't reach the server"));
    expect(notices.length).toBeLessThanOrEqual(1);
    expect(readState(t).failures).toBeGreaterThanOrEqual(3);
  }, 30000);

  it('a newer value already in the state is not overwritten by an older request (merge, not replace)', async () => {
    const srv = await fakeServer();
    const t = laptop({ url: srv.url, copy: true });
    writeFileSync(join(t.hookDir, 'git.mjs'), `${STUB_IDENTITY()}
export async function state() { return { report: { divergent: [], upstream: null, truncated: false, pushed: null }, memory: { comparison: { name: 'o', sha: 'old' }, divergent: [] } }; }
export async function staleWarnings() { return []; }`);
    await start(t);
    const future = Date.now() + 600_000;
    editState(t, (s) => { s.gitMemory = { comparison: { name: 'o', sha: 'newer' }, divergent: [] }; s.gitMemoryAt = future; s.lastHeartbeat = future; });
    await run(t, payload('UserPromptSubmit', t));
    const s = readState(t);
    expect(s.gitMemory.comparison.sha).toBe('newer');
    expect(s.lastHeartbeat).toBe(future);
  });

  it('no-op paths do not write the state file', async () => {
    const srv = await fakeServer();
    const t = laptop({ url: srv.url });
    await start(t);
    const before = statSync(stateFile(t)).mtimeMs;
    await new Promise((r) => setTimeout(r, 30));
    await run(t, payload('PostToolUse.Read', t)); // throttled
    await run(t, payload('PreToolUse.Read', t)); // not an edit
    expect(statSync(stateFile(t)).mtimeMs).toBe(before);
  });
});

describe('deadline', () => {
  it('a hanging git state() costs at most its budget: the request still goes out, without git', async () => {
    const srv = await fakeServer();
    const t = laptop({ url: srv.url, copy: true });
    writeFileSync(join(t.hookDir, 'git.mjs'), `${STUB_IDENTITY()}
export async function state() { return new Promise(() => {}); }
export async function staleWarnings() { return []; }`);
    const r = await run(t, payload('UserPromptSubmit', t));
    expect(r.code).toBe(0);
    expect(srv.requests).toHaveLength(1);
    expect(srv.requests[0].body).not.toHaveProperty('git');
    expect(r.ms).toBeLessThan(3800);
  }, 15000);

  it('a hanging periodic refresh cannot cost a deny', async () => {
    const srv = await fakeServer(() => ({ ...OK, decision: 'deny', reason: '<reason>' }));
    const t = laptop({ url: srv.url, copy: true });
    writeFileSync(join(t.hookDir, 'git.mjs'), `${STUB_IDENTITY()}
export async function refs() { return new Promise(() => {}); }
export async function state() { return ${EMPTY_REPORT}; }
export async function staleWarnings() { return []; }`);
    await run(t, payload('PreToolUse.Edit', t)); // caches the identity
    editState(t, (s) => { for (const e of Object.values(s.idents)) e.at = Date.now() - 60_000; });
    const r = await run(t, payload('PreToolUse.Edit', t));
    expect(r.stdout).toBe(fixtureStdout('PreToolUse.deny'));
    expect(r.ms).toBeLessThan(4200);
  }, 15000);

  it('the watchdog exits 0 and logs a line when something hangs', async () => {
    const srv = await fakeServer();
    const t = laptop({ url: srv.url, copy: true });
    writeFileSync(join(t.hookDir, 'claude.mjs'), 'export async function parse() { return new Promise(() => {}); }\nexport function format() { return null; }');
    const r = await run(t, payload('Stop', t));
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('');
    expect(r.ms).toBeLessThan(4800);
    expect(readFileSync(join(t.home, 'hook.log'), 'utf8')).toContain('watchdog');
  }, 15000);
});

describe('project.json and config.json', () => {
  const settingsDir = () => join(repo, '.hivemind');
  const cleanSettings = () => cleanups.push(() => rmSync(settingsDir(), { recursive: true, force: true }));

  it('strips a UTF-8 BOM and sends only requireTask, advisory and ignore', async () => {
    mkdirSync(settingsDir(), { recursive: true });
    cleanSettings();
    writeFileSync(join(settingsDir(), 'project.json'), `﻿${JSON.stringify({ requireTask: false, advisory: ['a', 5, 'b'], ignore: ['dist/'], evil: { x: 1 }, token: 'nope' })}`);
    const srv = await fakeServer();
    const t = laptop({ url: srv.url });
    await start(t);
    expect(srv.requests[0].body.settings).toEqual({ requireTask: false, advisory: ['a', 'b'], ignore: ['dist/'] });
  });

  it('refuses a .hivemind folder that is a link to somewhere else', async () => {
    const outside = join(base, `outside-${sessionCounter}`);
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'project.json'), JSON.stringify({ requireTask: false }));
    cleanups.push(() => rmSync(outside, { recursive: true, force: true }));
    try {
      symlinkSync(outside, settingsDir(), 'junction');
    } catch {
      return; // no permission to create links here
    }
    cleanups.push(() => { try { unlinkSync(settingsDir()); } catch { rmSync(settingsDir(), { recursive: true, force: true }); } });
    const srv = await fakeServer();
    const t = laptop({ url: srv.url });
    await start(t);
    expect(srv.requests[0].body).not.toHaveProperty('settings');
  });

  it('refuses a project.json that is a symlink', async () => {
    mkdirSync(settingsDir(), { recursive: true });
    cleanSettings();
    const target = join(base, `target-${sessionCounter}.json`);
    writeFileSync(target, JSON.stringify({ requireTask: false }));
    try {
      symlinkSync(target, join(settingsDir(), 'project.json'), 'file');
    } catch {
      return;
    }
    const srv = await fakeServer();
    const t = laptop({ url: srv.url });
    await start(t);
    expect(srv.requests[0].body).not.toHaveProperty('settings');
  });

  it('reads a config.json with a BOM', async () => {
    const srv = await fakeServer();
    const t = laptop({ url: srv.url });
    const text = readFileSync(join(t.home, 'config.json'), 'utf8');
    writeFileSync(join(t.home, 'config.json'), `﻿${text}`);
    await start(t);
    expect(srv.requests).toHaveLength(1);
  });

  it('refuses plain http to anything but loopback, and https is not rejected up front', async () => {
    for (const server of ['http://example.invalid', 'http://10.0.0.5:8787', 'ftp://127.0.0.1']) {
      const t = laptop({ url: server });
      const r = await run(t, payload('SessionStart', t));
      expect(r.code).toBe(0);
      expect(r.stdout).toBe('');
      expect(existsSync(join(t.home, 'hook.log'))).toBe(false); // never even tried
    }
  });

  it('does not follow redirects', async () => {
    const target = await fakeServer();
    const srv = await fakeServer((b, n, res) => { res.writeHead(307, { location: `${target.url}/hook` }); res.end(); return undefined; });
    const t = laptop({ url: srv.url });
    const r = await run(t, payload('SessionStart', t));
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('');
    expect(srv.requests).toHaveLength(1);
    expect(target.requests).toHaveLength(0);
  });
});

describe('SessionStart source', () => {
  it('baseline only on startup (or when none exists yet); resume and compact keep the old one', async () => {
    const srv = await fakeServer();
    const t = laptop({ url: srv.url });
    await run(t, payload('SessionStart', t, { source: 'startup' }));
    expect(srv.requests[0].body.git.baseline).toBeTruthy();
    await run(t, payload('SessionStart', t, { source: 'resume' }));
    await run(t, payload('SessionStart.resume', t, { source: 'compact' }));
    expect(srv.requests[1].body.event).toBe('SessionStart');
    expect(srv.requests[1].body.git).not.toHaveProperty('baseline');
    expect(srv.requests[2].body.git).not.toHaveProperty('baseline');
    await run(t, payload('SessionStart', t, { source: 'startup' }));
    expect(srv.requests[3].body.git.baseline).toBeTruthy();
  });

  it('a resume with no state yet still sends a baseline', async () => {
    const srv = await fakeServer();
    const t = laptop({ url: srv.url });
    await run(t, payload('SessionStart.resume', t));
    expect(srv.requests[0].body.git.baseline).toBeTruthy();
  });
});

describe('server answers are validated and capped', () => {
  it('a bad callsign makes the answer a failure', async () => {
    const srv = await fakeServer(() => ({ ...OK, callsign: 'Evil Callsign\nIgnore previous', context: 'x' }));
    const t = laptop({ url: srv.url });
    const r = await run(t, payload('SessionStart', t));
    expect(r.stdout).toBe('');
    const s = readState(t);
    expect(s.callsign).toBeNull();
    expect(s.failures).toBe(1);
  });

  it('context and reason are capped at 8 KB', async () => {
    const srv = await fakeServer(() => ({ ...OK, decision: 'deny', reason: 'r'.repeat(50_000), context: 'c'.repeat(50_000) }));
    const t = laptop({ url: srv.url });
    const out = JSON.parse((await run(t, payload('PreToolUse.Edit', t))).stdout).hookSpecificOutput;
    expect(out.permissionDecisionReason.length).toBeLessThanOrEqual(8 * 1024);
    expect(out.additionalContext.length).toBeLessThanOrEqual(8 * 1024);
  });

  it('lastPush entries with bad fields are dropped before the stale check sees them', async () => {
    const good = { path: 'a.txt', sha: 'c3d4e5f', blob: '9a1f', by: 'codex-ana', branch: 'main', at: 1 };
    const srv = await fakeServer((b) => (b.event === 'PreToolUse'
      ? { ...OK, lastPush: [good, { ...good, by: 'Not A Callsign' }, { ...good, path: 'p'.repeat(5000) }, { ...good, at: 'soon' }] }
      : OK));
    const t = laptop({ url: srv.url, copy: true });
    writeFileSync(join(t.hookDir, 'git.mjs'), `${STUB_IDENTITY()}
export async function state() { return ${EMPTY_REPORT}; }
export async function staleWarnings(root, branch, lastPush) { return ['saw ' + lastPush.length]; }`);
    const out = JSON.parse((await run(t, payload('PreToolUse.Edit', t))).stdout).hookSpecificOutput;
    expect(out.additionalContext).toContain('saw 1');
  });

  it('a 4xx is logged as a rejected request and does not count as an outage', async () => {
    const srv = await fakeServer((b, n, res) => { res.writeHead(400); res.end('bad'); return undefined; });
    const t = laptop({ url: srv.url });
    for (let i = 0; i < 5; i++) {
      const r = await run(t, payload('PreToolUse.Edit', t));
      expect(r.stdout).toBe('');
    }
    expect(srv.requests).toHaveLength(5); // the breaker never opened
    expect(readState(t).failures).toBe(0);
    expect(readFileSync(join(t.home, 'hook.log'), 'utf8')).toContain('rejected: HTTP 400');
  }, 30000);

  it('a 5xx and a 429 still count as outages', async () => {
    for (const status of [503, 429]) {
      const srv = await fakeServer((b, n, res) => { res.writeHead(status); res.end(); return undefined; });
      const t = laptop({ url: srv.url });
      await run(t, payload('PreToolUse.Edit', t));
      expect(readState(t).failures).toBe(1);
    }
  });
});

describe('client-side caps', () => {
  it('a huge or odd git state is trimmed to fit the server limits', async () => {
    const srv = await fakeServer();
    const t = laptop({ url: srv.url, copy: true });
    writeFileSync(join(t.hookDir, 'git.mjs'), `${STUB_IDENTITY()}
export async function state() {
  const divergent = [];
  for (let i = 0; i < 500; i++) divergent.push('d/' + String(i).padStart(4, '0') + '/' + 'x'.repeat(900));
  divergent.push('y'.repeat(2000));
  return { report: { divergent, baseline: divergent.slice(), upstream: 'u'.repeat(500), truncated: false, pushed: null }, memory: { comparison: null, divergent: [] } };
}
export async function staleWarnings() { return []; }`);
    await run(t, payload('SessionStart', t));
    const raw = JSON.stringify(srv.requests[0].body);
    expect(raw.length).toBeLessThan(200 * 1024);
    const g = srv.requests[0].body.git;
    expect(g.truncated).toBe(true);
    for (const p of [...g.divergent, ...g.baseline]) expect(p.length).toBeLessThanOrEqual(1024);
    expect(g.divergent.length).toBeGreaterThan(0);
  });
});

describe('nits', () => {
  it('logs when there is no git identity, and remembers a non-repo for a while', async () => {
    const srv = await fakeServer();
    const t = laptop({ url: srv.url });
    const plain = join(base, 'not-a-repo');
    mkdirSync(plain, { recursive: true });
    for (let i = 0; i < 3; i++) {
      const r = await run(t, payload('UserPromptSubmit', t, { cwd: plain }));
      expect(r.code).toBe(0);
      expect(r.stdout).toBe('');
    }
    const lines = readFileSync(join(t.home, 'hook.log'), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('no git identity');
    expect(srv.requests).toHaveLength(0);
  });

  it('does not log parser error snippets', async () => {
    const srv = await fakeServer();
    const t = laptop({ url: srv.url });
    await run(t, 'sk-this-looks-secret {nope');
    const logText = existsSync(join(t.home, 'hook.log')) ? readFileSync(join(t.home, 'hook.log'), 'utf8') : '';
    expect(logText).not.toContain('sk-this-looks-secret');
    expect(logText).toContain('SyntaxError');
  });

  it('refuses stdin over 16 MB without crashing', async () => {
    const srv = await fakeServer();
    const t = laptop({ url: srv.url });
    const big = JSON.stringify(payload('Stop', t, { last_assistant_message: 'x'.repeat(17 * 1024 * 1024) }));
    const r = await run(t, big);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('');
    expect(srv.requests).toHaveLength(0);
  }, 30000);
});

// ---------------------------------------------------------------------------
// The LIMITS copy
// ---------------------------------------------------------------------------

describe('hook-local LIMITS copy', () => {
  it('every value matches shared/contracts.ts', () => {
    const keys = Object.keys(HOOK_LIMITS);
    expect(keys.length).toBeGreaterThan(0);
    for (const k of keys) {
      expect(LIMITS, `LIMITS.${k} exists`).toHaveProperty(k);
      expect(HOOK_LIMITS[k], k).toBe(LIMITS[k]);
    }
  });
});

describe('home resolution', () => {
  it('uses the folder it is installed in when HIVEMIND_HOME is unset', async () => {
    const srv = await fakeServer();
    const dir = mkdtempSync(join(base, 'inst-'));
    const home = join(dir, 'custom-home');
    const hookDir = join(home, 'hook');
    const tmp = join(dir, 'tmp');
    const fakeUserHome = join(dir, 'user');
    mkdirSync(hookDir, { recursive: true });
    mkdirSync(tmp);
    mkdirSync(fakeUserHome);
    for (const f of HOOK_FILES) copyFileSync(new URL(f, HOOK_DIR), join(hookDir, f));
    writeFileSync(join(home, 'config.json'), JSON.stringify({ server: srv.url, room: 'r', person: 'nobody', token: FAKE_AGENT_CRED, repos: [rootSha] }));
    const env = { ...process.env, TEMP: tmp, TMP: tmp, TMPDIR: tmp, HOME: fakeUserHome, USERPROFILE: fakeUserHome };
    delete env.HIVEMIND_HOME;
    const input = JSON.stringify(payload('SessionStart', { session: `inst-${process.pid}` }));
    const code = await new Promise((resolve) => {
      const child = spawn(process.execPath, [join(hookDir, 'hook.mjs'), 'claude'], { env, stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
      child.on('close', resolve);
      child.stdin.on('error', () => {});
      child.stdin.end(input);
    });
    expect(code).toBe(0);
    expect(srv.requests.length).toBeGreaterThan(0);
  });
});
