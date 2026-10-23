// @ts-nocheck -- tests use loosely typed fixtures and a fake server; the code under test is type-checked.
/**
 * hook.mjs with several rooms in config.json (ARCHITECTURE.md §6.1): the room is picked by the checkout's root commit.
 * The real script runs as a child process against fake /hook servers on ephemeral ports, with HIVEMIND_HOME and the
 * session state pointed at temporary folders. Nothing here touches a real laptop's setup.
 */
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

const HOOK = decodeURIComponent(new URL('./hook.mjs', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const FIXTURES = new URL('../../shared/fixtures/hooks/claude/', import.meta.url);
// Fake; built so secret scanners don't flag the literals.
const TOKEN_A = ['hm_a', 'test', 'ana', '1', 'AAAA'].join('.');
const TOKEN_B = ['hm_a', 'test', 'ben', '1', 'BBBB'].join('.');
const OK = { decision: 'allow', reason: null, context: null, callsign: 'claude-test', heartbeatMs: 15000, mode: 'enforce' };

vi.setConfig({ testTimeout: 60000 });

let base;
let repoA; // root commit rootA
let repoB;
let rootA;
let rootB;
let sessions = 0;
const cleanups = [];

const git = (args, cwd) => execFileSync('git', args, {
  cwd, encoding: 'utf8',
  env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' },
}).trim();

function makeRepo(name) {
  const dir = join(base, name);
  mkdirSync(dir);
  git(['init', '-q', '-b', 'main'], dir);
  writeFileSync(join(dir, 'a.txt'), `${name}\n`);
  git(['add', '.'], dir);
  git(['commit', '-q', '-m', `first of ${name}`], dir);
  return { dir, root: git(['rev-parse', 'HEAD'], dir) };
}

beforeAll(() => {
  base = realpathSync.native(mkdtempSync(join(tmpdir(), 'hm-hook-rooms-')));
  ({ dir: repoA, root: rootA } = makeRepo('proj-a'));
  ({ dir: repoB, root: rootB } = makeRepo('proj-b'));
});
afterAll(() => rmSync(base, { recursive: true, force: true }));
afterEach(async () => { while (cleanups.length) await cleanups.pop()(); });

async function fakeServer() {
  const requests = [];
  const sockets = new Set();
  const server = createServer((req, res) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => {
      requests.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(data || 'null') });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(OK));
    });
  });
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  cleanups.push(() => new Promise((r) => { for (const s of sockets) s.destroy(); server.close(() => r()); }));
  return { url: `http://127.0.0.1:${server.address().port}`, requests };
}

/** A laptop whose config.json holds exactly `config` (an object, or raw text). */
function laptop(config) {
  const dir = mkdtempSync(join(base, 'lap-'));
  const home = join(dir, 'home');
  mkdirSync(home);
  writeFileSync(join(home, 'config.json'), typeof config === 'string' ? config : JSON.stringify(config));
  return { home, session: `sess-${process.pid}-${++sessions}` };
}

const entry = (server, token, repos, extra = {}) => ({ server, room: 'r', person: 'p', token, repos, ...extra });

function run(t, cwd, event = 'SessionStart') {
  const raw = JSON.parse(readFileSync(new URL(`${event}.json`, FIXTURES), 'utf8'));
  raw.cwd = cwd;
  raw.session_id = t.session;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [HOOK, 'claude'], {
      env: { ...process.env, HIVEMIND_HOME: t.home },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.on('close', (code) => resolve({ code, stdout }));
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(raw));
  });
}

describe('room selection by repo', () => {
  it('picks the room whose repos include the checkout, and sends that room its own token', async () => {
    const a = await fakeServer();
    const b = await fakeServer();
    const t = laptop({ rooms: [entry(a.url, TOKEN_A, [rootA]), entry(b.url, TOKEN_B, [rootB])] });
    expect((await run(t, repoB)).code).toBe(0);
    expect(a.requests).toHaveLength(0);
    expect(b.requests).toHaveLength(1);
    expect(b.requests[0].auth).toBe(`Bearer ${TOKEN_B}`);
    expect(b.requests[0].body.repo).toBe(rootB);
  });

  it('two rooms, two repos: each repo talks to its own server only', async () => {
    const a = await fakeServer();
    const b = await fakeServer();
    const t = laptop({ rooms: [entry(a.url, TOKEN_A, [rootA]), entry(b.url, TOKEN_B, [rootB])] });
    await run(t, repoA);
    t.session += '-2';
    await run(t, repoB);
    expect(a.requests.map((r) => r.auth)).toEqual([`Bearer ${TOKEN_A}`]);
    expect(b.requests.map((r) => r.auth)).toEqual([`Bearer ${TOKEN_B}`]);
  });

  it('no room has the repo: exit 0, no output, no network', async () => {
    const a = await fakeServer();
    const b = await fakeServer();
    const t = laptop({ rooms: [entry(a.url, TOKEN_A, [rootA]), entry(b.url, TOKEN_B, ['0000000000000000000000000000000000000000'])] });
    for (const e of ['SessionStart', 'UserPromptSubmit', 'Stop']) {
      const r = await run(t, repoB, e);
      expect(r.code).toBe(0);
      expect(r.stdout).toBe('');
    }
    expect(a.requests).toHaveLength(0);
    expect(b.requests).toHaveLength(0);
  });

  it('a repo listed in two rooms goes to the first one', async () => {
    const a = await fakeServer();
    const b = await fakeServer();
    const t = laptop({ rooms: [entry(a.url, TOKEN_A, [rootA, rootB]), entry(b.url, TOKEN_B, [rootB])] });
    await run(t, repoB);
    expect(a.requests).toHaveLength(1);
    expect(b.requests).toHaveLength(0);
  });

  it('a room entry that is unusable is skipped and the others still work', async () => {
    const b = await fakeServer();
    const t = laptop({
      rooms: [entry('ftp://example.invalid', TOKEN_A, [rootB]), { server: b.url, repos: [rootB] }, 'nonsense', entry(b.url, TOKEN_B, [rootB])],
    });
    await run(t, repoB);
    expect(b.requests.map((r) => r.auth)).toEqual([`Bearer ${TOKEN_B}`]);
  });

  it('a hivemind tool of any room gets the me check, with no network call', async () => {
    const a = await fakeServer();
    const t = laptop({ rooms: [entry(a.url, TOKEN_A, [rootA], { mcp: 'hivemind-plat' })] });
    await run(t, repoA); // SessionStart: learns the callsign
    const before = a.requests.length;
    const raw = JSON.parse(readFileSync(new URL('PreToolUse.Edit.json', FIXTURES), 'utf8'));
    raw.cwd = repoA;
    raw.session_id = t.session;
    raw.tool_name = 'mcp__hivemind-plat__status';
    raw.tool_input = { me: 'someone-else' };
    const out = await new Promise((resolve) => {
      const child = spawn(process.execPath, [HOOK, 'claude'], { env: { ...process.env, HIVEMIND_HOME: t.home }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      let stdout = '';
      child.stdout.on('data', (c) => { stdout += c; });
      child.on('close', () => resolve(stdout));
      child.stdin.end(JSON.stringify(raw));
    });
    expect(a.requests).toHaveLength(before);
    expect(JSON.parse(out).hookSpecificOutput.permissionDecision).toBe('deny');
    expect(out).toContain('claude-test');
  });
});

describe('config.json formats and version skew', () => {
  it('the old single-room format still works, with no migration', async () => {
    const a = await fakeServer();
    const t = laptop({ server: a.url, room: 'r', person: 'p', token: TOKEN_A, repos: [rootA] });
    await run(t, repoA);
    expect(a.requests.map((r) => r.auth)).toEqual([`Bearer ${TOKEN_A}`]);
    const none = laptop({ server: a.url, room: 'r', person: 'p', token: TOKEN_A, repos: [rootB] });
    await run(none, repoA);
    expect(a.requests).toHaveLength(1);
  });

  it('a file written by the new CLI (top-level copy of the primary room plus a rooms list) uses the rooms list', async () => {
    const a = await fakeServer();
    const b = await fakeServer();
    const t = laptop({
      ...entry(a.url, TOKEN_A, [rootA]),
      rooms: [entry(a.url, TOKEN_A, [rootA], { mcp: 'hivemind' }), entry(b.url, TOKEN_B, [rootB], { mcp: 'hivemind-plat' })],
    });
    await run(t, repoB);
    expect(a.requests).toHaveLength(0);
    expect(b.requests).toHaveLength(1);
  });

  it('what an older hook reads from a new file (the top level) is the primary room, so it keeps working for that room', () => {
    // The old reader: server, token and repos at the top level. The new CLI always writes them (see commands tests).
    const file = JSON.parse(JSON.stringify({
      ...entry('https://hive.example.com', TOKEN_A, [rootA]),
      rooms: [entry('https://hive.example.com', TOKEN_A, [rootA]), entry('https://other.example.com', TOKEN_B, [rootB])],
    }));
    expect(typeof file.server === 'string' && typeof file.token === 'string' && Array.isArray(file.repos)).toBe(true);
    expect(file.repos).toEqual([rootA]);
  });

  it('a file with no usable room (empty list, or only broken entries) does nothing', async () => {
    const a = await fakeServer();
    for (const config of [{ rooms: [] }, { rooms: [{ token: TOKEN_A }] }, '{ not json', '{}']) {
      const t = laptop(config);
      const r = await run(t, repoA);
      expect(r.code).toBe(0);
      expect(r.stdout).toBe('');
    }
    expect(a.requests).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Callsigns repeat across rooms, so a session must only use the Hivemind server of its own project's room.

/** A Claude PreToolUse for a tool of an MCP server, from `cwd`. Returns the parsed stdout (or null when quiet). */
async function toolCall(t, cwd, tool, input = {}) {
  const raw = JSON.parse(readFileSync(new URL('PreToolUse.Edit.json', FIXTURES), 'utf8'));
  raw.cwd = cwd;
  raw.session_id = t.session;
  raw.tool_name = tool;
  raw.tool_input = input;
  const out = await new Promise((resolve) => {
    const child = spawn(process.execPath, [HOOK, 'claude'], { env: { ...process.env, HIVEMIND_HOME: t.home }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.on('close', () => resolve(stdout));
    child.stdin.end(JSON.stringify(raw));
  });
  return out === '' ? null : JSON.parse(out);
}
const denied = (o) => o?.hookSpecificOutput?.permissionDecision === 'deny';
const reasonOf = (o) => o?.hookSpecificOutput?.permissionDecisionReason ?? '';

describe('Hivemind tools are tied to the project\'s room', () => {
  it('a tool of another room\'s server is denied, the right room\'s server is not', async () => {
    const a = await fakeServer();
    const b = await fakeServer();
    const t = laptop({ rooms: [entry(a.url, TOKEN_A, [rootA], { mcp: 'hivemind', room: 'ra' }), entry(b.url, TOKEN_B, [rootB], { mcp: 'hivemind-b', room: 'rb' })] });
    const wrong = await toolCall(t, repoA, 'mcp__hivemind-b__status', { me: 'claude-test' });
    expect(denied(wrong)).toBe(true);
    expect(reasonOf(wrong)).toContain('mcp__hivemind__*');
    const wrong2 = await toolCall(t, repoB, 'mcp__hivemind__status', { me: 'claude-test' });
    expect(denied(wrong2)).toBe(true);
    expect(reasonOf(wrong2)).toContain('mcp__hivemind-b__*');
    expect(await toolCall(t, repoB, 'mcp__hivemind-b__status', { me: 'claude-test' })).toBeNull();
    expect(a.requests.length + b.requests.length).toBe(0); // all local
  });

  it('no room for the folder (unmapped repo, or not a repo): Hivemind tools are denied, other tools are untouched', async () => {
    const a = await fakeServer();
    const t = laptop({ rooms: [entry(a.url, TOKEN_A, [rootA], { mcp: 'hivemind' })] });
    const notRepo = join(base, 'plain');
    mkdirSync(notRepo, { recursive: true });
    expect(denied(await toolCall(t, repoB, 'mcp__hivemind__status', { me: 'x' }))).toBe(true);
    expect(denied(await toolCall(t, notRepo, 'mcp__hivemind__status', { me: 'x' }))).toBe(true);
    expect(await toolCall(t, repoB, 'mcp__other__thing', {})).toBeNull();
    expect(await toolCall(t, notRepo, 'Read', { file_path: join(notRepo, 'x') })).toBeNull();
  });

  it('a user\'s own hivemind-notes server is not a Hivemind server', async () => {
    const a = await fakeServer();
    const t = laptop({ rooms: [entry(a.url, TOKEN_A, [rootA], { mcp: 'hivemind' })] });
    expect(await toolCall(t, repoA, 'mcp__hivemind-notes__add', { me: 'whatever' })).toBeNull();
    expect(await toolCall(t, repoB, 'mcp__hivemind-notes__add', { me: 'whatever' })).toBeNull();
  });

  it('the SessionStart briefing names the tool prefix when the laptop is in several rooms, and only then', async () => {
    const a = await fakeServer();
    const b = await fakeServer();
    const two = laptop({ rooms: [entry(a.url, TOKEN_A, [rootA], { mcp: 'hivemind', room: 'ra' }), entry(b.url, TOKEN_B, [rootB], { mcp: 'hivemind-b', room: 'rb' })] });
    const r = await run(two, repoB);
    expect(r.stdout).toContain('This project\'s room is \\"rb\\"; its tools are mcp__hivemind-b__*.');
    const one = laptop({ rooms: [entry(a.url, TOKEN_A, [rootA], { mcp: 'hivemind', room: 'ra' })] });
    expect((await run(one, repoA)).stdout).not.toContain('its tools are');
  });

  it('the saved callsign belongs to a room: moving the session to another room\'s repo does not reuse it', async () => {
    const a = await fakeServer();
    const b = await fakeServer();
    const t = laptop({ rooms: [entry(a.url, TOKEN_A, [rootA], { mcp: 'hivemind', room: 'ra' }), entry(b.url, TOKEN_B, [rootB], { mcp: 'hivemind-b', room: 'rb' })] });
    await run(t, repoA); // learns callsign "claude-test" in room ra
    // the same session now works in room rb's repo and calls its tool with another callsign: no stale callsign applies
    expect(await toolCall(t, repoB, 'mcp__hivemind-b__status', { me: 'claude-in-rb' })).toBeNull();
    // back in ra the callsign is checked again (the state was reset for rb, so ra has none until its next SessionStart)
    await run(t, repoA);
    expect(denied(await toolCall(t, repoA, 'mcp__hivemind__status', { me: 'someone-else' }))).toBe(true);
  });
});
