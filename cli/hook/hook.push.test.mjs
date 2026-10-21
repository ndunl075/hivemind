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
      env: { ...process.env, HIVEMIND_HOME: home, TEMP: tmp, TMP: tmp, TMPDIR: tmp },
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
    child.on('close', (code) => resolve(code));
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify({ hook_event_name, session_id: session, cwd: w.agent, ...extra }));
  });
}

describe('issue #20: edit and push inside one heartbeat interval', () => {
  it('reports the push when the edit was throttled and the push came through Bash', async () => {
    const srv = await fakeServer();
    const w = world();
    const send = agentSession(w, srv.url);
    await send('SessionStart', { source: 'startup' });
    expect(srv.requests[0].git.divergent).toEqual([]);

    const file = join(w.agent, 'a.txt');
    await send('PreToolUse', { tool_name: 'Edit', tool_input: { file_path: file } });
    writeFileSync(file, 'changed\n');
    await send('PostToolUse', { tool_name: 'Edit', tool_input: { file_path: file } }); // throttled: no request
    const sent = srv.requests.length;
    git(['commit', '-q', '-am', 'change a'], w.agent);
    git(['push', '-q', 'origin', 'main'], w.agent);
    await send('PostToolUse', { tool_name: 'Bash', tool_input: { command: 'git commit && git push' } });

    expect(srv.requests).toHaveLength(sent + 1);
    const last = srv.requests.at(-1);
    expect(last.event).toBe('PostToolUse');
    expect(last.git.pushed).toMatchObject({ branch: 'main', files: [{ path: 'a.txt', blob: git(['rev-parse', 'HEAD:a.txt'], w.agent) }] });
    expect(last.git.divergent).toEqual([]);
  });

  it('only the edited files count: a fetched teammate commit is not ours', async () => {
    const srv = await fakeServer();
    const w = world();
    const mate = join(w.dir, 'mate');
    git(['clone', '-q', w.remote, mate], w.dir);
    writeFileSync(join(mate, 'b.txt'), 'b\n');
    git(['add', '-A'], mate);
    git(['commit', '-q', '-m', 'mate'], mate);
    git(['push', '-q', 'origin', 'main'], mate);

    const send = agentSession(w, srv.url);
    await send('SessionStart', { source: 'startup' });
    const file = join(w.agent, 'a.txt');
    writeFileSync(file, 'mine\n');
    await send('PostToolUse', { tool_name: 'Write', tool_input: { file_path: file } });
    git(['commit', '-q', '-am', 'mine'], w.agent);
    git(['pull', '-q', '--no-rebase', '--no-edit', 'origin', 'main'], w.agent);
    git(['push', '-q', 'origin', 'main'], w.agent);
    await send('PostToolUse', { tool_name: 'Bash', tool_input: { command: 'git pull && git push' } });

    const pushed = srv.requests.at(-1).git.pushed;
    expect(pushed.files.map((f) => f.path)).toEqual(['a.txt']);
  });

  it('an edit outside the checkout or under .git is not remembered', async () => {
    const srv = await fakeServer();
    const w = world();
    const send = agentSession(w, srv.url);
    await send('SessionStart', { source: 'startup' });
    await send('PostToolUse', { tool_name: 'Edit', tool_input: { file_path: join(w.dir, 'elsewhere.txt') } });
    await send('PostToolUse', { tool_name: 'Edit', tool_input: { file_path: join(w.agent, '.git', 'config') } });
    await send('UserPromptSubmit', {});
    expect(srv.requests.at(-1).git.divergent).toEqual([]);
  });
});
