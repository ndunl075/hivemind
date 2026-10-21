// @ts-nocheck -- tests use loosely typed fixtures and a fake server; the code under test is type-checked.
/**
 * Issue #20: a push that follows an edit within one heartbeat interval is still recognised. The real hook.mjs runs
 * as a child process against a fake /hook server, a bare origin and a clone (ARCHITECTURE.md §6.3 and §12).
 */
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const HOOK = new URL('./hook.mjs', import.meta.url);
const HOOK_PATH = decodeURIComponent(HOOK.pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const FAKE_CRED = ['hm_a', 'test', 'nobody', '1', 'AAAA'].join('.');
const OK = { decision: 'allow', reason: null, context: null, callsign: 'claude-test', heartbeatMs: 15000, mode: 'enforce' };

let base;
let counter = 0;
const cleanups = [];
const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] }).trim();

beforeAll(() => { base = realpathSync.native(mkdtempSync(join(tmpdir(), 'hm-push-'))); });
afterAll(() => rmSync(base, { recursive: true, force: true }));
afterEach(async () => { while (cleanups.length) await cleanups.pop()(); });

async function fakeServer() {
  const requests = [];
  const server = createServer((req, res) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => {
      requests.push(JSON.parse(data));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(OK));
    });
  });
  const sockets = new Set();
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  cleanups.push(() => new Promise((r) => { for (const s of sockets) s.destroy(); server.close(() => r()); }));
  return { url: `http://127.0.0.1:${server.address().port}`, requests };
}

/** A bare origin with main (a.txt), and one clone of it. */
function world() {
  const dir = join(base, `w${++counter}`);
  mkdirSync(dir);
  const remote = join(dir, 'remote.git');
  git(['init', '-q', '--bare', '-b', 'main', remote], dir);
  const seed = join(dir, 'seed');
  git(['clone', '-q', remote, seed], dir);
  git(['checkout', '-q', '-b', 'main'], seed);
  writeFileSync(join(seed, 'a.txt'), 'a\n');
  git(['add', '-A'], seed);
  git(['commit', '-q', '-m', 'seed'], seed);
  git(['push', '-q', 'origin', 'main'], seed);
  const agent = join(dir, 'agent');
  git(['clone', '-q', remote, agent], dir);
  const rootSha = git(['rev-list', '--max-parents=0', 'HEAD'], agent).split('\n').sort()[0];
  return { dir, remote, agent, rootSha };
}

function agentSession(w, url) {
  const home = join(w.dir, 'home');
  const tmp = join(w.dir, 'tmp');
  mkdirSync(home);
  mkdirSync(tmp);
  writeFileSync(join(home, 'config.json'), JSON.stringify({ server: url, room: 'r', person: 'nobody', token: FAKE_CRED, repos: [w.rootSha] }));
  const session = `sess-push-${process.pid}-${counter}`;
  return (hook_event_name, extra = {}) => new Promise((resolve) => {
    const child = spawn(process.execPath, [HOOK_PATH, 'claude'], {
      env: { ...process.env, HIVEMIND_GIT_BUDGET_MS: '30000', HIVEMIND_HOME: home, TEMP: tmp, TMP: tmp, TMPDIR: tmp },
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
    child.on('close', (code) => resolve(code));
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify({ hook_event_name, session_id: session, cwd: w.agent, ...extra }));
  });
}

describe('issue #20: edit and push inside one heartbeat interval', () => {
  it('reports the push when the edit and the push come within one heartbeat interval', async () => {
    const srv = await fakeServer();
    const w = world();
    const send = agentSession(w, srv.url);
    await send('SessionStart', { source: 'startup' });
    expect(srv.requests[0].git.divergent).toEqual([]);

    const file = join(w.agent, 'a.txt');
    await send('PreToolUse', { tool_name: 'Edit', tool_input: { file_path: file } });
    writeFileSync(file, 'changed\n');
    await send('PostToolUse', { tool_name: 'Edit', tool_input: { file_path: file } }); // a new divergent file: heartbeat now
    expect(srv.requests.at(-1).git.divergent).toEqual(['a.txt']);
    git(['commit', '-q', '-am', 'change a'], w.agent);
    git(['push', '-q', 'origin', 'main'], w.agent);
    await send('PostToolUse', { tool_name: 'Bash', tool_input: { command: 'git commit && git push' } });

    const last = srv.requests.at(-1);
    expect(last.event).toBe('PostToolUse');
    expect(last.git.pushed).toMatchObject({ branch: 'main', files: [{ path: 'a.txt', blob: git(['rev-parse', 'HEAD:a.txt'], w.agent) }] });
    expect(last.git.divergent).toEqual([]);
  });

  it('a teammate\'s push of the same file, pulled over the agent\'s discarded edit, is not the agent\'s push', async () => {
    const srv = await fakeServer();
    const w = world();
    const mate = join(w.dir, 'mate');
    const send = agentSession(w, srv.url);
    await send('SessionStart', { source: 'startup' });
    git(['clone', '-q', w.remote, mate], w.dir);
    writeFileSync(join(mate, 'a.txt'), 'mate\n');
    git(['commit', '-q', '-am', 'mate'], mate);
    git(['push', '-q', 'origin', 'main'], mate);

    const file = join(w.agent, 'a.txt');
    writeFileSync(file, 'mine\n');
    await send('PostToolUse', { tool_name: 'Edit', tool_input: { file_path: file } });
    git(['checkout', '--', 'a.txt'], w.agent);
    git(['pull', '-q', '--ff-only'], w.agent);
    await send('PostToolUse', { tool_name: 'Bash', tool_input: { command: 'git checkout -- a.txt && git pull --ff-only' } });
    expect(srv.requests.at(-1).git.pushed).toBeNull();
  });

  it('a new edit sends a heartbeat at once, a repeated edit of the same file stays throttled', async () => {
    const srv = await fakeServer();
    const w = world();
    const send = agentSession(w, srv.url);
    await send('SessionStart', { source: 'startup' });
    const file = join(w.agent, 'a.txt');
    writeFileSync(file, 'one\n');
    await send('PostToolUse', { tool_name: 'Edit', tool_input: { file_path: file } });
    expect(srv.requests).toHaveLength(2);
    writeFileSync(file, 'two\n');
    await send('PostToolUse', { tool_name: 'Edit', tool_input: { file_path: file } });
    expect(srv.requests).toHaveLength(2);
  });

  it('edits of a gitignored file force one heartbeat, not one per edit', async () => {
    const srv = await fakeServer();
    const w = world();
    writeFileSync(join(w.agent, '.gitignore'), 'out/\n');
    git(['add', '-A'], w.agent);
    git(['commit', '-q', '-m', 'ignore out'], w.agent);
    const send = agentSession(w, srv.url);
    await send('SessionStart', { source: 'startup' });
    mkdirSync(join(w.agent, 'out'));
    const file = join(w.agent, 'out', 'build.log');
    for (const text of ['1', '2', '3']) {
      writeFileSync(file, text);
      await send('PostToolUse', { tool_name: 'Write', tool_input: { file_path: file } });
    }
    expect(srv.requests).toHaveLength(2); // SessionStart, then one forced heartbeat
  });

  it('an edit outside the checkout or under .git sends nothing', async () => {
    const srv = await fakeServer();
    const w = world();
    const send = agentSession(w, srv.url);
    await send('SessionStart', { source: 'startup' });
    await send('PostToolUse', { tool_name: 'Edit', tool_input: { file_path: join(w.dir, 'elsewhere.txt') } });
    await send('PostToolUse', { tool_name: 'Edit', tool_input: { file_path: join(w.agent, '.git', 'config') } });
    expect(srv.requests).toHaveLength(1);
  });
});
