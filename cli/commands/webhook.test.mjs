// @ts-nocheck -- tests use loosely typed fixtures and a fake server; the code under test is type-checked.
/** `hivemind webhook`: bound to the project's repo, prints the payload URL and secret once, with the GitHub settings; --off. Own fake server on a free port. */
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { main } from '../hivemind.mjs';
import { githubFullName } from './admin.mjs';
import { ADMIN_SECRET, cleanup, makeLaptop, tempBase } from './testkit.mjs';

const FAKE_WEBHOOK_SECRET = 'fake-webhook-secret-for-tests-only';
let base;
let server;
let url;
const requests = [];

beforeAll(async () => {
  base = tempBase();
  server = createServer((req, res) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => {
      const body = data ? JSON.parse(data) : null;
      requests.push({ method: req.method, url: req.url, auth: req.headers.authorization ?? '', body });
      const send = (status, obj) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (req.headers.authorization !== `Bearer ${ADMIN_SECRET}`) return send(401, { error: 'invalid admin token' });
      if (req.method === 'POST' && req.url === '/admin/rooms/my-team/webhook') {
        return send(200, body.disable ? {} : { generation: 2, path: '/github/my-team/2', secret: FAKE_WEBHOOK_SECRET, fullName: body.fullName });
      }
      return send(404, { error: 'not found' });
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => {
  await new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); });
  cleanup(base);
});
beforeEach(() => { requests.length = 0; });

const count = (text, needle) => text.split(needle).length - 1;

/** A laptop whose project has an origin remote (no network involved). */
function laptop(origin = 'https://github.com/Acme/Demo-App.git', opts = {}) {
  const lap = makeLaptop(base, opts);
  if (origin) execFileSync('git', ['remote', 'add', 'origin', origin], { cwd: lap.project.dir });
  return lap;
}

describe('githubFullName', () => {
  it('reads owner/name from https, ssh and scp-like URLs', () => {
    expect(githubFullName('https://github.com/Acme/Demo-App.git')).toBe('Acme/Demo-App');
    expect(githubFullName('git@github.com:acme/demo.app.git')).toBe('acme/demo.app');
    expect(githubFullName('ssh://git@github.com/acme/demo/')).toBe('acme/demo');
    expect(githubFullName('')).toBeNull();
    expect(githubFullName(null)).toBeNull();
  });
});

describe('hivemind webhook', () => {
  it('binds the webhook to the project repo, prints the payload URL and the secret once with the GitHub settings, and never the admin secret', async () => {
    const lap = laptop(undefined, { secrets: [ADMIN_SECRET] });
    const r = await lap.run(main, ['webhook', 'my-team', '--server', url]);
    expect(r.code, r.err).toBe(0);
    expect(count(r.out, `${url}/github/my-team/2`)).toBe(1);
    expect(count(r.out, FAKE_WEBHOOK_SECRET)).toBe(1);
    expect(r.out).toContain('application/json');
    expect(r.out).toMatch(/only "Pushes"/);
    expect(r.out).toContain('Acme/Demo-App');
    expect(r.out + r.err).not.toContain(ADMIN_SECRET);
    expect(lap.prompts.some((p) => /admin/i.test(p) && /hidden/i.test(p))).toBe(true);
    expect(requests).toEqual([{
      method: 'POST', url: '/admin/rooms/my-team/webhook', auth: `Bearer ${ADMIN_SECRET}`,
      body: { repo: lap.project.root, fullName: 'Acme/Demo-App' },
    }]);
  });

  it('takes the repository from --repo when origin is not a GitHub URL, and asks for it when neither works', async () => {
    const env = { HIVEMIND_ADMIN_TOKEN: ADMIN_SECRET, HIVEMIND_SERVER: url };
    const lap = laptop('/some/local/path', { env });
    const ok = await lap.run(main, ['webhook', 'my-team', '--repo', 'acme/other']);
    expect(ok.code, ok.err).toBe(0);
    expect(requests[0].body).toEqual({ repo: lap.project.root, fullName: 'acme/other' });
    // A project with no origin remote and no --repo is refused before anything is sent.
    const none = laptop(null, { env });
    requests.length = 0;
    const r = await none.run(main, ['webhook', 'my-team']);
    expect(r.code).toBe(1);
    expect(r.err).toContain('--repo owner/name');
    expect((await none.run(main, ['webhook', 'my-team', '--repo', 'not a repo'])).code).toBe(1);
    expect(requests).toEqual([]);
  });

  it('refuses outside a Git repository', async () => {
    const lap = laptop(undefined, { env: { HIVEMIND_ADMIN_TOKEN: ADMIN_SECRET, HIVEMIND_SERVER: url } });
    const r = await lap.run(main, ['webhook', 'my-team'], { cwd: lap.homedir });
    expect(r.code).toBe(1);
    expect(r.err).toContain('inside the project');
    expect(requests).toEqual([]);
  });

  it('--off needs no repository, reads the admin secret from the environment, and prints no secret', async () => {
    const lap = makeLaptop(base, { env: { HIVEMIND_ADMIN_TOKEN: ADMIN_SECRET, HIVEMIND_SERVER: url } });
    const r = await lap.run(main, ['webhook', 'my-team', '--off'], { cwd: lap.homedir });
    expect(r.code, r.err).toBe(0);
    expect(lap.prompts).toEqual([]);
    expect(r.out).toContain('is off');
    expect(r.out).not.toContain(FAKE_WEBHOOK_SECRET);
    expect(requests[0].body).toEqual({ disable: true });
  });

  it('refuses bad room names and a missing room, and shows a wrong admin secret as the server error', async () => {
    const lap = laptop(undefined, { secrets: ['wrong-secret'] });
    expect((await lap.run(main, ['webhook', 'Bad Room', '--server', url])).code).toBe(1);
    expect((await lap.run(main, ['webhook', '--server', url])).code).toBe(1);
    const r = await lap.run(main, ['webhook', 'my-team', '--server', url]);
    expect(r.code).toBe(1);
    expect(r.err).toContain('invalid admin token');
    expect(r.err).not.toContain('wrong-secret');
  });

  it('is in the help text', async () => {
    const lap = makeLaptop(base);
    const r = await lap.run(main, ['help']);
    expect(r.out).toContain('hivemind webhook <room>');
  });
});
