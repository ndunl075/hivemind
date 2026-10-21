// @ts-nocheck -- shared helpers for the CLI tests (loosely typed on purpose). Not part of the shipped commands' logic.
/**
 * Test harness: a temporary "laptop" (home folder, HIVEMIND_HOME, a throwaway Git project), a stubbed runner for
 * `claude` and `codex`, and a fake Hivemind server on port 8790. Nothing here touches a real ~/.claude, ~/.claude.json,
 * ~/.codex or ~/.hivemind.
 */
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { createContext } from './context.mjs';

export const PORT = 8790;
export const SERVER = `http://127.0.0.1:${PORT}`;
// Fake credentials; the gitleaks allowlist covers the hm_a.test. and hm_v.test. prefixes.
export const AGENT_TOKEN = 'hm_a.test.ana.1.AAAAAAAAAAAAAAAA';
export const OTHER_TOKEN = 'hm_a.test.ben.1.BBBBBBBBBBBBBBBB';
export const VIEWER_TOKEN = 'hm_v.test.1.VVVVVVVVVVVVVVVV';
export const VIEWER_TOKEN_2 = 'hm_v.test.2.WWWWWWWWWWWWWWWW';
export const ADMIN_SECRET = 'admin-secret-for-tests-only';

const git = (args, cwd) => execFileSync('git', args, {
  cwd, encoding: 'utf8',
  env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' },
}).trim();

/** A throwaway Git project with one commit. Returns its path and root commit. */
export function makeProject(base, name = 'proj') {
  const dir = join(base, name);
  mkdirSync(dir, { recursive: true });
  git(['init', '-q', '-b', 'main'], dir);
  git(['config', 'core.autocrlf', 'false'], dir);
  writeFileSync(join(dir, 'a.txt'), `${name}\n`);
  git(['add', '.'], dir);
  git(['commit', '-q', '-m', `first commit of ${name}`], dir);
  return { dir, root: git(['rev-parse', 'HEAD'], dir) };
}

/**
 * The stubbed `claude` and `codex`. `claude mcp ...` keeps its servers in <home>/.claude.json like the real one, so
 * tests can check that other servers survive. Every call is recorded in `calls`.
 */
export function makeRunner(home, { claude = true, codex = true } = {}) {
  const calls = [];
  const file = join(home, '.claude.json');
  const load = () => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {});
  const save = (o) => writeFileSync(file, `${JSON.stringify(o, null, 2)}\n`);
  const runner = async (cmd, args) => {
    calls.push({ cmd, args: [...args] });
    if (cmd === 'codex') return codex ? { code: 0, stdout: 'codex-cli 0.159.3', stderr: '' } : { code: 127, stdout: '', stderr: 'not found' };
    if (cmd !== 'claude' || !claude) return { code: 127, stdout: '', stderr: 'not found' };
    if (args[0] === '--version') return { code: 0, stdout: '2.1.287', stderr: '' };
    if (args[0] === 'mcp') {
      const o = load();
      o.mcpServers ??= {};
      if (args[1] === 'get') {
        const s = o.mcpServers[args[2]];
        return s ? { code: 0, stdout: `${args[2]}:\n  Type: ${s.type}\n  URL: ${s.url}\n  Headers helper: ${s.headersHelper}\n`, stderr: '' } : { code: 1, stdout: '', stderr: 'No MCP server found' };
      }
      if (args[1] === 'add-json') {
        if (args[2] !== '--scope' || args[3] !== 'user') return { code: 1, stdout: '', stderr: 'scope?' };
        if (o.mcpServers[args[4]]) return { code: 1, stdout: '', stderr: 'already exists' };
        o.mcpServers[args[4]] = JSON.parse(args[5]);
        save(o);
        return { code: 0, stdout: 'added', stderr: '' };
      }
      if (args[1] === 'remove') {
        if (!o.mcpServers[args[4]]) return { code: 1, stdout: '', stderr: 'not found' };
        delete o.mcpServers[args[4]];
        save(o);
        return { code: 0, stdout: 'removed', stderr: '' };
      }
    }
    return { code: 1, stdout: '', stderr: 'unsupported in the stub' };
  };
  return { runner, calls, file };
}

/** A fake laptop. `run(main, argv, extra)` runs the CLI's main() with captured output. */
export function makeLaptop(base, opts = {}) {
  const dir = mkdtempSync(join(base, 'lap-'));
  const homedir = join(dir, 'home');
  mkdirSync(homedir);
  const project = makeProject(dir);
  const stub = makeRunner(homedir, opts);
  const answers = { secrets: [...(opts.secrets ?? [])], lines: [...(opts.lines ?? [])] };
  const prompts = [];
  const lap = {
    dir,
    homedir,
    project,
    stub,
    prompts,
    answers,
    env: { HIVEMIND_HOME: join(homedir, '.hivemind'), ...(opts.env ?? {}) },
    out: '',
    err: '',
    ctx(extra = {}) {
      return createContext({
        env: lap.env,
        homedir,
        cwd: project.dir,
        nodePath: opts.nodePath ?? process.execPath,
        out: (t) => { lap.out += t; },
        err: (t) => { lap.err += t; },
        runner: stub.runner,
        readSecret: async (label) => { prompts.push(label); if (!answers.secrets.length) throw new Error(`unexpected secret prompt: ${label}`); return answers.secrets.shift(); },
        readLine: async (label) => { prompts.push(label); if (!answers.lines.length) throw new Error(`unexpected prompt: ${label}`); return answers.lines.shift(); },
        interactive: false,
        platform: process.platform,
        ...extra,
      });
    },
    async run(main, argv, extra = {}) {
      lap.out = '';
      lap.err = '';
      const code = await main(argv, lap.ctx(extra));
      return { code, out: lap.out, err: lap.err };
    },
    path(...p) { return join(homedir, ...p); },
  };
  return lap;
}

/** All files under a folder as { relativePath: content }, for before/after comparisons. */
export function snapshot(root) {
  const out = {};
  const walk = (d) => {
    if (!existsSync(d)) return;
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out[relative(root, p).replace(/\\/g, '/')] = readFileSync(p, 'utf8');
    }
  };
  walk(root);
  return out;
}

/** mtimes of the same files, to show that a second run wrote nothing. */
export function mtimes(root) {
  const out = {};
  const walk = (d) => {
    if (!existsSync(d)) return;
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out[relative(root, p).replace(/\\/g, '/')] = statSync(p).mtimeMs;
    }
  };
  walk(root);
  return out;
}

/**
 * The fake Hivemind server on 8790. Requests are recorded with their Authorization header.
 * Routes follow server/src/worker.ts.
 */
export async function startFakeServer() {
  const requests = [];
  const sockets = new Set();
  const server = createServer((req, res) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => {
      let body = null;
      try { body = data ? JSON.parse(data) : null; } catch { /* keep null */ }
      const auth = req.headers.authorization ?? '';
      requests.push({ method: req.method, url: req.url, auth, body });
      const send = (status, obj) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
      const url = req.url;
      if (url.startsWith('/admin/')) {
        if (auth !== `Bearer ${ADMIN_SECRET}`) return send(401, { error: 'invalid admin token' });
        if (req.method === 'POST' && url === '/admin/rooms') return send(200, { room: body.room, viewerToken: VIEWER_TOKEN });
        if (req.method === 'DELETE' && /^\/admin\/rooms\/[a-z0-9-]+$/.test(url)) return send(200, { deleted: true });
        if (req.method === 'POST' && url.endsWith('/invite')) return send(200, { agentToken: body.person === 'ben' ? OTHER_TOKEN : AGENT_TOKEN });
        if (req.method === 'POST' && url.endsWith('/revoke')) return send(200, body.rotate === 'viewer' ? { viewerToken: VIEWER_TOKEN_2 } : {});
        return send(404, { error: 'not found' });
      }
      if (auth !== `Bearer ${AGENT_TOKEN}`) return send(401, { error: 'invalid token' });
      if (url === '/whoami') return send(200, { room: 'hack', person: 'ana', mode: 'enforce' });
      if (url === '/mode') return send(200, { mode: body.mode });
      if (url === '/unlock') return send(200, { released: [{ path: 'src/a.ts', holder: 'codex-ben', kind: 'file' }], note: 'Also dropped something.' });
      return send(404, { error: 'not found' });
    });
  });
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(PORT, '127.0.0.1', resolve); });
  return {
    requests,
    close: () => new Promise((r) => { for (const s of sockets) s.destroy(); server.close(() => r()); }),
  };
}

export function tempBase(prefix = 'hm-cli-') {
  return realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
}

export function cleanup(base) {
  rmSync(base, { recursive: true, force: true });
}
