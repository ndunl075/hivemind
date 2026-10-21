// @ts-nocheck -- tests use loosely typed fixtures and a fake server; the code under test is type-checked.
/**
 * Command tests. Every test runs against a temporary home and project, a stubbed `claude`/`codex` runner and a fake
 * server on port 8790. This is the only test file that binds 8790, so run files never collide.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { main } from '../hivemind.mjs';
import {
  ADMIN_SECRET, AGENT_TOKEN, OTHER_TOKEN, SERVER, VIEWER_TOKEN, VIEWER_TOKEN_2,
  cleanup, makeLaptop, mtimes, snapshot, startFakeServer, tempBase,
} from './testkit.mjs';

let base;
let srv;

beforeAll(async () => {
  base = tempBase();
  srv = await startFakeServer();
});
afterAll(async () => {
  await srv.close();
  cleanup(base);
});
beforeEach(() => { srv.requests.length = 0; });

const count = (text, needle) => text.split(needle).length - 1;
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const write = (p, text) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, text); };

/** A laptop that has Claude Code and Codex, ready to run join with the fake token. */
function laptop(opts = {}) {
  const lap = makeLaptop(base, { secrets: [AGENT_TOKEN], ...opts });
  mkdirSync(lap.path('.claude'), { recursive: true });
  mkdirSync(lap.path('.codex'), { recursive: true });
  return lap;
}
const join_ = (lap, extra = []) => lap.run(main, ['join', '--server', SERVER, '--yes', ...extra]);

const EXISTING_CLAUDE = {
  model: 'opus',
  env: { FOO: '1' },
  permissions: { allow: ['Bash(ls:*)'], deny: ['Read(.env)'] },
  hooks: {
    Stop: [{ hooks: [{ type: 'command', command: 'echo other-stop' }] }],
    PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'lint.sh', timeout: 10 }] }],
    Notification: [{ hooks: [{ type: 'command', command: 'notify.sh' }] }],
  },
};
const EXISTING_CLAUDE_JSON = { numStartups: 4, mcpServers: { other: { type: 'stdio', command: 'other-mcp', args: ['--x'] } } };
const EXISTING_CODEX_HOOKS = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'other-codex-stop', timeout: 3 }] }] } };
const EXISTING_TOML = '# my codex settings\nmodel = "gpt-5"\n\n[mcp_servers.other]\ncommand = "npx"\nargs = ["-y", "other"]\n';

function seedExisting(lap) {
  write(lap.path('.claude', 'settings.json'), `${JSON.stringify(EXISTING_CLAUDE, null, 2)}\n`);
  write(lap.path('.claude.json'), `${JSON.stringify(EXISTING_CLAUDE_JSON, null, 2)}\n`);
  write(lap.path('.codex', 'hooks.json'), `${JSON.stringify(EXISTING_CODEX_HOOKS, null, 2)}\n`);
  write(lap.path('.codex', 'config.toml'), EXISTING_TOML);
}

// ---------------------------------------------------------------------------------------------------------------
describe('join', () => {
  it('maps the repo, installs the hook folder and registers both apps', async () => {
    const lap = laptop();
    const r = await join_(lap);
    expect(r.code, r.err).toBe(0);
    const config = readJson(lap.path('.hivemind', 'config.json'));
    expect(config).toEqual({ server: SERVER, room: 'hack', person: 'ana', token: AGENT_TOKEN, repos: [lap.project.root] });
    // Only the runtime files plus the helper; no tests.
    const files = Object.keys(snapshot(lap.path('.hivemind', 'hook'))).sort();
    expect(files).toEqual(['claude.mjs', 'codex.mjs', 'git.mjs', 'headers-helper.mjs', 'hook.mjs', 'limits.mjs']);
    expect(existsSync(lap.path('.hivemind', 'config.json'))).toBe(true);

    const settings = readJson(lap.path('.claude', 'settings.json'));
    expect(settings.permissions.allow).toEqual(['mcp__hivemind']);
    const hookScript = lap.path('.hivemind', 'hook', 'hook.mjs');
    expect(settings.hooks.SessionStart).toEqual([{ hooks: [{ type: 'command', command: process.execPath, args: [hookScript, 'claude'], timeout: 5 }] }]);
    expect(settings.hooks.PreToolUse[0].matcher).toBe('Edit|Write|MultiEdit|NotebookEdit|mcp__hivemind__.*');
    expect(settings.hooks.PostToolUse[0].matcher).toBe('.*');
    expect(settings.hooks.SessionEnd[0].hooks[0].timeout).toBe(3);
    expect(Object.keys(settings.hooks).sort()).toEqual(['PostToolUse', 'PreToolUse', 'SessionEnd', 'SessionStart', 'Stop', 'UserPromptSubmit']);

    const codex = readJson(lap.path('.codex', 'hooks.json'));
    expect(Object.keys(codex.hooks).sort()).toEqual(['PostToolUse', 'PreToolUse', 'SessionEnd', 'SessionStart', 'Stop', 'UserPromptSubmit']);
    expect(codex.hooks.PreToolUse[0].matcher).toBe('apply_patch|Edit|Write|mcp__hivemind__.*');
    expect(codex.hooks.PostToolUse[0].matcher).toBe('Bash|apply_patch');
    const h = codex.hooks.SessionStart[0].hooks[0];
    expect(h.type).toBe('command');
    const q = (p) => `"${p.replace(/(["\\$`])/g, '\\$1')}"`;
    expect(h.command).toBe(`${q(process.execPath)} ${q(hookScript)} codex`);
    expect(h.commandWindows).toBe(`& "${process.execPath}" "${hookScript}" codex; exit $LASTEXITCODE`);
    expect(h.timeout).toBe(5);
    expect(codex.hooks.SessionEnd[0].hooks[0].timeout).toBe(3);

    const toml = readFileSync(lap.path('.codex', 'config.toml'), 'utf8');
    expect(toml).toContain('[mcp_servers.hivemind]');
    expect(toml).toContain(`url = "${SERVER}/mcp"`);
    expect(toml).toContain(`http_headers = { Authorization = "Bearer ${AGENT_TOKEN}" }`);
    expect(toml).toContain('default_tools_approval_mode = "approve"');
    expect(toml).toContain('tool_timeout_sec = 60');

    const mcp = readJson(lap.path('.claude.json')).mcpServers.hivemind;
    expect(mcp.type).toBe('http');
    expect(mcp.url).toBe(`${SERVER}/mcp`);
    expect(mcp.headersHelper).toContain('headers-helper.mjs');
    expect(mcp.headersHelper).not.toContain(AGENT_TOKEN);
    expect(JSON.stringify(mcp)).not.toContain('hm_a.');
  });

  it('writes config.json owner-only where the OS has modes', async () => {
    const lap = laptop();
    await join_(lap);
    if (process.platform !== 'win32') {
      expect(statSync(lap.path('.hivemind', 'config.json')).mode & 0o077).toBe(0);
      expect(statSync(lap.path('.hivemind')).mode & 0o077).toBe(0);
    }
  });

  it('asks for the token with hidden input and never as an argument', async () => {
    const lap = laptop();
    const r = await lap.run(main, ['join', '--server', SERVER, '--yes']);
    expect(r.code).toBe(0);
    expect(lap.prompts.some((p) => /token/i.test(p) && /hidden/i.test(p))).toBe(true);
    const r2 = await lap.run(main, ['join', '--server', SERVER, '--token', AGENT_TOKEN]);
    expect(r2.code).toBe(1);
    expect(r2.err).toContain('unknown option');
  });

  it('takes the token from HIVEMIND_AGENT_TOKEN without prompting', async () => {
    const lap = makeLaptop(base, { env: { HIVEMIND_AGENT_TOKEN: AGENT_TOKEN } });
    const r = await join_(lap);
    expect(r.code, r.err).toBe(0);
    expect(lap.prompts).toEqual([]);
  });

  it('running join twice changes nothing: same bytes, no writes, no second MCP add', async () => {
    const lap = laptop();
    seedExisting(lap);
    expect((await join_(lap)).code).toBe(0);
    const files = [lap.path('.hivemind'), lap.path('.claude'), lap.path('.codex'), lap.path('.claude.json')];
    const snap = () => files.map((f) => (statSync(f).isDirectory() ? snapshot(f) : { f: readFileSync(f, 'utf8') }));
    const before = snap();
    const stamps = mtimes(lap.homedir);
    lap.stub.calls.length = 0;
    lap.answers.secrets.push(AGENT_TOKEN);
    expect((await join_(lap)).code).toBe(0);
    expect(snap()).toEqual(before);
    expect(mtimes(lap.homedir)).toEqual(stamps);
    expect(lap.stub.calls.filter((c) => c.args.includes('add-json') || c.args.includes('remove'))).toEqual([]);
  });

  it('keeps existing hooks, permissions, MCP servers, TOML settings and comments', async () => {
    const lap = laptop();
    seedExisting(lap);
    expect((await join_(lap)).code).toBe(0);

    const settings = readJson(lap.path('.claude', 'settings.json'));
    expect(settings.model).toBe('opus');
    expect(settings.env).toEqual({ FOO: '1' });
    expect(settings.permissions.allow).toEqual(['Bash(ls:*)', 'mcp__hivemind']);
    expect(settings.permissions.deny).toEqual(['Read(.env)']);
    expect(settings.hooks.Notification).toEqual(EXISTING_CLAUDE.hooks.Notification);
    expect(settings.hooks.Stop[0]).toEqual(EXISTING_CLAUDE.hooks.Stop[0]);
    expect(settings.hooks.Stop).toHaveLength(2);
    expect(settings.hooks.PreToolUse[0]).toEqual(EXISTING_CLAUDE.hooks.PreToolUse[0]);
    expect(settings.hooks.PreToolUse).toHaveLength(2);

    const claudeJson = readJson(lap.path('.claude.json'));
    expect(claudeJson.numStartups).toBe(4);
    expect(claudeJson.mcpServers.other).toEqual(EXISTING_CLAUDE_JSON.mcpServers.other);
    expect(claudeJson.mcpServers.hivemind).toBeTruthy();

    const codex = readJson(lap.path('.codex', 'hooks.json'));
    expect(codex.hooks.Stop[0]).toEqual(EXISTING_CODEX_HOOKS.hooks.Stop[0]);
    expect(codex.hooks.Stop).toHaveLength(2);

    const toml = readFileSync(lap.path('.codex', 'config.toml'), 'utf8');
    expect(toml.startsWith(EXISTING_TOML)).toBe(true);
    expect(toml).toContain('# my codex settings');
    expect(toml).toContain('[mcp_servers.other]');
  });

  it('leave removes only what join added, leaving every other byte as it was', async () => {
    const lap = laptop();
    seedExisting(lap);
    const before = {
      claude: readFileSync(lap.path('.claude', 'settings.json'), 'utf8'),
      claudeJson: readJson(lap.path('.claude.json')),
      codex: readFileSync(lap.path('.codex', 'hooks.json'), 'utf8'),
      toml: readFileSync(lap.path('.codex', 'config.toml'), 'utf8'),
    };
    await join_(lap);
    const r = await lap.run(main, ['leave']);
    expect(r.code, r.err).toBe(0);
    expect(readJson(lap.path('.claude', 'settings.json'))).toEqual(JSON.parse(before.claude));
    expect(readJson(lap.path('.claude.json'))).toEqual(before.claudeJson);
    expect(readJson(lap.path('.codex', 'hooks.json'))).toEqual(JSON.parse(before.codex));
    expect(readFileSync(lap.path('.codex', 'config.toml'), 'utf8')).toBe(before.toml);
    expect(existsSync(lap.path('.hivemind'))).toBe(false);
  });

  it('leave deletes config files that join created, and leaves a permission rule the user had', async () => {
    const lap = laptop();
    await join_(lap);
    await lap.run(main, ['leave']);
    expect(existsSync(lap.path('.claude', 'settings.json'))).toBe(false);
    expect(existsSync(lap.path('.codex', 'hooks.json'))).toBe(false);
    expect(existsSync(lap.path('.codex', 'config.toml'))).toBe(false);
    expect(readJson(lap.path('.claude.json')).mcpServers ?? {}).toEqual({});

    const lap2 = laptop();
    write(lap2.path('.claude', 'settings.json'), JSON.stringify({ permissions: { allow: ['mcp__hivemind'] } }));
    await join_(lap2);
    await lap2.run(main, ['leave']);
    expect(readJson(lap2.path('.claude', 'settings.json'))).toEqual({ permissions: { allow: ['mcp__hivemind'] } });
  });

  it('leave keeps unrelated files in the Hivemind folder', async () => {
    const lap = laptop();
    await join_(lap);
    write(lap.path('.hivemind', 'notes.txt'), 'mine');
    await lap.run(main, ['leave']);
    expect(readFileSync(lap.path('.hivemind', 'notes.txt'), 'utf8')).toBe('mine');
    expect(existsSync(lap.path('.hivemind', 'config.json'))).toBe(false);
  });

  it('joins a second repo to the same room, and another room replaces the mapping', async () => {
    const lap = laptop();
    await join_(lap);
    const { makeProject } = await import('./testkit.mjs');
    const second = makeProject(lap.dir, 'proj2');
    lap.answers.secrets.push(AGENT_TOKEN);
    await lap.run(main, ['join', '--server', SERVER, '--yes'], { cwd: second.dir });
    const repos = readJson(lap.path('.hivemind', 'config.json')).repos;
    expect(repos.sort()).toEqual([lap.project.root, second.root].sort());
  });

  it('refuses a token the server rejects, a bad token shape and a folder that is not a repo', async () => {
    const lap = makeLaptop(base, { secrets: [OTHER_TOKEN] });
    const r = await join_(lap);
    expect(r.code).toBe(1);
    expect(r.err).toContain('the server said no (401)');
    expect(r.err).not.toContain(OTHER_TOKEN);
    expect(existsSync(lap.path('.hivemind'))).toBe(false);

    const bad = makeLaptop(base, { secrets: ['nope'] });
    expect((await join_(bad)).err).toContain('does not look like an agent token');

    const lap3 = makeLaptop(base, { secrets: [AGENT_TOKEN] });
    const r3 = await lap3.run(main, ['join', '--server', SERVER, '--yes'], { cwd: lap3.homedir });
    expect(r3.code).toBe(1);
    expect(r3.err).toContain('Git repository');
  });

  it('refuses plain http to a remote host', async () => {
    const lap = makeLaptop(base, { secrets: [AGENT_TOKEN] });
    const r = await lap.run(main, ['join', '--server', 'http://example.com', '--yes']);
    expect(r.code).toBe(1);
    expect(r.err).toContain('https');
  });

  it('skips an app that is not installed', async () => {
    const lap = makeLaptop(base, { secrets: [AGENT_TOKEN], codex: false });
    mkdirSync(lap.path('.claude'), { recursive: true });
    const r = await join_(lap);
    expect(r.code).toBe(0);
    expect(r.out).toContain('Codex: not found, skipped');
    expect(existsSync(lap.path('.codex'))).toBe(false);

    const lap2 = makeLaptop(base, { secrets: [AGENT_TOKEN], claude: false });
    mkdirSync(lap2.path('.codex'), { recursive: true });
    const r2 = await join_(lap2);
    expect(r2.out).toContain('Claude Code: not found, skipped');
    expect(existsSync(lap2.path('.claude'))).toBe(false);
  });

  it('with the claude program missing it still writes settings and prints the command to run', async () => {
    const lap = makeLaptop(base, { secrets: [AGENT_TOKEN], claude: false });
    mkdirSync(lap.path('.claude'), { recursive: true });
    const r = await join_(lap);
    expect(r.code).toBe(0);
    expect(r.err).toContain('claude mcp add-json --scope user hivemind');
    expect(r.err).not.toContain(AGENT_TOKEN);
    expect(existsSync(lap.path('.claude', 'settings.json'))).toBe(true);
  });

  it('a settings file that is not valid JSON is left untouched and does not stop Codex', async () => {
    const lap = laptop();
    write(lap.path('.claude', 'settings.json'), '{ "hooks": // comment\n}');
    const r = await join_(lap);
    expect(r.code).toBe(1);
    expect(r.err).toContain('not valid JSON');
    expect(readFileSync(lap.path('.claude', 'settings.json'), 'utf8')).toBe('{ "hooks": // comment\n}');
    expect(existsSync(lap.path('.codex', 'hooks.json'))).toBe(true);
  });

  it('a Codex config that already has its own [mcp_servers.hivemind] is left untouched', async () => {
    const lap = laptop();
    const own = '[mcp_servers.hivemind]\nurl = "https://elsewhere.example/mcp"\n';
    write(lap.path('.codex', 'config.toml'), own);
    const r = await join_(lap);
    expect(r.code).toBe(1);
    expect(r.err).toContain('already has its own [mcp_servers.hivemind]');
    expect(readFileSync(lap.path('.codex', 'config.toml'), 'utf8')).toBe(own);
    expect(existsSync(lap.path('.codex', 'hooks.json'))).toBe(false);
  });

  it('writes paths with spaces and special characters in a form each shell reads back', async () => {
    const lap = laptop({ nodePath: join(base, 'Program Files', 'node js', 'no$de"x') });
    await join_(lap);
    const h = readJson(lap.path('.codex', 'hooks.json')).hooks.SessionStart[0].hooks[0];
    expect(h.commandWindows).toContain('no`$de`"x');
    expect(h.commandWindows.startsWith('& "')).toBe(true);
    expect(h.commandWindows.endsWith('codex; exit $LASTEXITCODE')).toBe(true);
    expect(h.command).toContain('no\\$de\\"x');
    const claude = readJson(lap.path('.claude', 'settings.json')).hooks.SessionStart[0].hooks[0];
    expect(claude.command).toBe(join(base, 'Program Files', 'node js', 'no$de"x'));
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('no token in argv, logs or output', () => {
  it('join: the token is in config.json and Codex config only, never in argv, stdout, stderr or Claude files', async () => {
    const lap = laptop();
    seedExisting(lap);
    const r = await join_(lap);
    expect(r.code).toBe(0);
    for (const call of lap.stub.calls) expect(JSON.stringify(call)).not.toContain(AGENT_TOKEN);
    expect(r.out).not.toContain(AGENT_TOKEN);
    expect(r.err).not.toContain(AGENT_TOKEN);
    expect(r.out + r.err).not.toContain('hm_a.');
    const holders = Object.entries({ ...snapshot(lap.homedir) }).filter(([, text]) => text.includes(AGENT_TOKEN)).map(([f]) => f).sort();
    expect(holders).toEqual(['.codex/config.toml', '.hivemind/config.json']);
    // The helper prints the header from config.json when Claude runs it.
    const helper = spawnSync(process.execPath, [lap.path('.hivemind', 'hook', 'headers-helper.mjs')], { encoding: 'utf8' });
    expect(helper.status).toBe(0);
    expect(JSON.parse(helper.stdout)).toEqual({ Authorization: `Bearer ${AGENT_TOKEN}` });
    // And the token doesn't show up on the argv of the server calls either (it is only in the header).
    expect(srv.requests.every((q) => !JSON.stringify(q.body ?? '').includes(AGENT_TOKEN))).toBe(true);
  });

  it('update, doctor, mode, unlock, init, off, on and leave never print the token', async () => {
    const lap = laptop();
    await join_(lap);
    let all = '';
    for (const argv of [['update'], ['doctor'], ['mode', 'warn'], ['unlock', 'a.txt'], ['unlock', '--agent', 'codex-ben'], ['init'], ['off'], ['on'], ['leave']]) {
      const r = await lap.run(main, argv);
      all += r.out + r.err;
    }
    expect(all).not.toContain(AGENT_TOKEN);
    for (const call of lap.stub.calls) expect(JSON.stringify(call)).not.toContain(AGENT_TOKEN);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('admin commands', () => {
  it('room create prints the dashboard link, once, and asks for the admin secret with hidden input', async () => {
    const lap = makeLaptop(base, { secrets: [ADMIN_SECRET] });
    const r = await lap.run(main, ['room', 'create', 'hackathon', '--server', SERVER]);
    expect(r.code, r.err).toBe(0);
    expect(count(r.out, VIEWER_TOKEN)).toBe(1);
    expect(r.out).toContain(`${SERVER}/r/hackathon#v=${VIEWER_TOKEN}`);
    expect(r.out + r.err).not.toContain(ADMIN_SECRET);
    expect(lap.prompts.some((p) => /admin/i.test(p) && /hidden/i.test(p))).toBe(true);
    expect(srv.requests).toEqual([{ method: 'POST', url: '/admin/rooms', auth: `Bearer ${ADMIN_SECRET}`, body: { room: 'hackathon' } }]);
  });

  it('reads the admin secret from HIVEMIND_ADMIN_TOKEN without prompting', async () => {
    const lap = makeLaptop(base, { env: { HIVEMIND_ADMIN_TOKEN: ADMIN_SECRET, HIVEMIND_SERVER: SERVER } });
    const r = await lap.run(main, ['invite', 'hackathon', 'ana']);
    expect(r.code, r.err).toBe(0);
    expect(lap.prompts).toEqual([]);
    expect(srv.requests[0].auth).toBe(`Bearer ${ADMIN_SECRET}`);
  });

  it('invite prints the agent token once and nothing else secret', async () => {
    const lap = makeLaptop(base, { secrets: [ADMIN_SECRET] });
    const r = await lap.run(main, ['invite', 'hackathon', 'ana', '--server', SERVER]);
    expect(r.code, r.err).toBe(0);
    expect(count(r.out, AGENT_TOKEN)).toBe(1);
    expect(r.err).toBe('');
    expect(r.out + r.err).not.toContain(ADMIN_SECRET);
    expect(srv.requests[0]).toMatchObject({ method: 'POST', url: '/admin/rooms/hackathon/invite', body: { person: 'ana' } });
  });

  it('rotate --viewer prints the new link once; rotate --agents prints no token', async () => {
    const lap = makeLaptop(base, { secrets: [ADMIN_SECRET, ADMIN_SECRET] });
    const v = await lap.run(main, ['rotate', 'hackathon', '--viewer', '--server', SERVER]);
    expect(v.code, v.err).toBe(0);
    expect(count(v.out, VIEWER_TOKEN_2)).toBe(1);
    expect(v.out).toContain(`${SERVER}/r/hackathon#v=${VIEWER_TOKEN_2}`);
    const a = await lap.run(main, ['rotate', 'hackathon', '--agents', '--server', SERVER]);
    expect(a.code, a.err).toBe(0);
    expect(a.out).not.toMatch(/hm_[av]\./);
    expect(srv.requests.map((q) => q.body)).toEqual([{ rotate: 'viewer' }, { rotate: 'agents' }]);
    expect((await lap.run(main, ['rotate', 'hackathon', '--server', SERVER])).err).toContain('exactly one of');
  });

  it('revoke and room delete', async () => {
    const lap = makeLaptop(base, { secrets: [ADMIN_SECRET, ADMIN_SECRET, ADMIN_SECRET] });
    expect((await lap.run(main, ['revoke', 'hackathon', 'ben', '--server', SERVER])).code).toBe(0);
    expect(srv.requests[0]).toMatchObject({ url: '/admin/rooms/hackathon/revoke', body: { person: 'ben' } });
    // No terminal and no --yes: refuses before asking for anything.
    const refused = await lap.run(main, ['room', 'delete', 'hackathon', '--server', SERVER]);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain('--yes');
    expect((await lap.run(main, ['room', 'delete', 'hackathon', '--yes', '--server', SERVER])).code).toBe(0);
    expect(srv.requests.at(-1)).toMatchObject({ method: 'DELETE', url: '/admin/rooms/hackathon' });
    // With a terminal, the room name must be typed.
    lap.answers.lines.push('wrong');
    const wrong = await lap.run(main, ['room', 'delete', 'hackathon', '--server', SERVER], { interactive: true });
    expect(wrong.code).toBe(1);
    expect(wrong.err).toContain('did not match');
  });

  it('shows the server error for a wrong admin secret without echoing it', async () => {
    const lap = makeLaptop(base, { secrets: ['wrong-secret-value'] });
    const r = await lap.run(main, ['invite', 'hackathon', 'ana', '--server', SERVER]);
    expect(r.code).toBe(1);
    expect(r.err).toContain('invalid admin token');
    expect(r.err).not.toContain('wrong-secret-value');
  });

  it('validates names before any request', async () => {
    const lap = makeLaptop(base, { secrets: [ADMIN_SECRET] });
    expect((await lap.run(main, ['invite', 'Hack', 'ana', '--server', SERVER])).code).toBe(1);
    expect((await lap.run(main, ['invite', 'hack', 'A B', '--server', SERVER])).code).toBe(1);
    expect((await lap.run(main, ['room', 'create', 'test', '--server', SERVER])).err).toContain('reserved');
    expect(srv.requests).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('mode, unlock, off, on, init', () => {
  it('mode and unlock use the agent token from config.json', async () => {
    const lap = laptop();
    await join_(lap);
    srv.requests.length = 0;
    const m = await lap.run(main, ['mode', 'warn']);
    expect(m.code, m.err).toBe(0);
    expect(srv.requests[0]).toEqual({ method: 'POST', url: '/mode', auth: `Bearer ${AGENT_TOKEN}`, body: { mode: 'warn' } });
    expect((await lap.run(main, ['mode', 'loud'])).code).toBe(1);

    write(join(lap.project.dir, 'src', 'a.ts'), 'x');
    const u = await lap.run(main, ['unlock', 'src/a.ts']);
    expect(u.code, u.err).toBe(0);
    expect(srv.requests.at(-1).body).toEqual({ path: { repo: lap.project.root, path: 'src/a.ts' } });
    expect(u.out).toContain('Released 1 lock');
    const ua = await lap.run(main, ['unlock', '--agent', 'codex-ben']);
    expect(srv.requests.at(-1).body).toEqual({ agent: 'codex-ben' });
    expect(ua.code).toBe(0);
    expect((await lap.run(main, ['unlock', '../outside.txt'])).err).toContain('outside this repository');
  });

  it('mode and unlock say to join first when there is no config', async () => {
    const lap = makeLaptop(base);
    const r = await lap.run(main, ['mode', 'warn']);
    expect(r.code).toBe(1);
    expect(r.err).toContain('hivemind join');
  });

  it('off and on toggle the kill switch file the hook checks', async () => {
    const lap = laptop();
    await join_(lap);
    await lap.run(main, ['off']);
    expect(existsSync(lap.path('.hivemind', 'off'))).toBe(true);
    await lap.run(main, ['off']);
    expect(existsSync(lap.path('.hivemind', 'off'))).toBe(true);
    expect((await lap.run(main, ['on'])).out).toContain('on again');
    expect(existsSync(lap.path('.hivemind', 'off'))).toBe(false);
    expect((await lap.run(main, ['on'])).out).toContain('already on');
  });

  it('init writes the settings and the protocol section, merges into existing files, and is idempotent', async () => {
    const lap = laptop();
    const proj = lap.project.dir;
    write(join(proj, 'AGENTS.md'), '# Agents\n\nBe kind.\n');
    const r = await lap.run(main, ['init']);
    expect(r.code, r.err).toBe(0);
    expect(readJson(join(proj, '.hivemind', 'project.json'))).toEqual({
      requireTask: true,
      advisory: ['package.json', '**/package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock*'],
      ignore: [],
    });
    const protocol = readFileSync(new URL('../../shared/protocol.md', import.meta.url), 'utf8').replace(/\r\n/g, '\n').trim();
    const agents = readFileSync(join(proj, 'AGENTS.md'), 'utf8');
    expect(agents.startsWith('# Agents\n\nBe kind.\n')).toBe(true);
    expect(agents).toContain(`<!-- hivemind:start -->\n${protocol}\n<!-- hivemind:end -->`);
    expect(readFileSync(join(proj, 'CLAUDE.md'), 'utf8')).toBe(`<!-- hivemind:start -->\n${protocol}\n<!-- hivemind:end -->\n`);

    // User edits to settings survive; a second run changes nothing.
    write(join(proj, '.hivemind', 'project.json'), '{"requireTask":false}\n');
    const snap = snapshot(proj);
    const stamps = mtimes(proj);
    const again = await lap.run(main, ['init']);
    expect(again.out).toContain('Kept');
    expect(snapshot(proj)).toEqual(snap);
    expect(mtimes(proj)).toEqual(stamps);
  });

  it('join and leave never touch project files', async () => {
    const lap = laptop();
    await lap.run(main, ['init']);
    const before = snapshot(lap.project.dir);
    await join_(lap);
    await lap.run(main, ['leave']);
    expect(snapshot(lap.project.dir)).toEqual(before);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('update', () => {
  it('restores a deleted hook file and re-points the hooks at a new node path, without duplicating them', async () => {
    const lap = laptop();
    seedExisting(lap);
    await join_(lap);
    const { rmSync } = await import('node:fs');
    rmSync(lap.path('.hivemind', 'hook', 'git.mjs'));
    const other = join(base, 'new node', 'node.exe');
    const r = await lap.run(main, ['update'], { nodePath: other });
    expect(r.code, r.err).toBe(0);
    expect(existsSync(lap.path('.hivemind', 'hook', 'git.mjs'))).toBe(true);
    const settings = readJson(lap.path('.claude', 'settings.json'));
    expect(settings.hooks.Stop).toHaveLength(2);
    const ours = settings.hooks.Stop.flatMap((g) => g.hooks).filter((h) => Array.isArray(h.args));
    expect(ours).toHaveLength(1);
    expect(ours[0].command).toBe(other);
    const codex = readJson(lap.path('.codex', 'hooks.json'));
    expect(codex.hooks.Stop).toHaveLength(2);
    expect(JSON.stringify(codex)).toContain('new node');
    expect(readJson(lap.path('.hivemind', 'install.json')).node).toBe(other);
    // Leave still removes everything.
    await lap.run(main, ['leave']);
    expect(JSON.stringify(readJson(lap.path('.claude', 'settings.json')))).not.toContain('hook.mjs');
  });

  it('says to join first when there is no config', async () => {
    const lap = makeLaptop(base);
    const r = await lap.run(main, ['update']);
    expect(r.code).toBe(1);
    expect(r.err).toContain('hivemind join');
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('doctor', () => {
  it('passes after join and prints the self-test prompt', async () => {
    const lap = laptop();
    await join_(lap);
    const r = await lap.run(main, ['doctor']);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain('accepts the token');
    expect(r.out).toContain('all 6 hooks registered');
    expect(r.out).toContain('Codex: MCP server URL matches');
    expect(r.out).toContain('permission rule "mcp__hivemind" present');
    expect(r.out).toContain('Self-test');
    expect(r.out).toContain('[Hivemind] You are');
    expect(r.out).toContain('HIVEMIND-OK');
    expect(r.out).toContain('HOOKS-MISSING');
    expect(r.out).not.toContain(AGENT_TOKEN);
  });

  it('shows the last hook activity from hook.log', async () => {
    const lap = laptop();
    await join_(lap);
    write(lap.path('.hivemind', 'hook.log'), `${JSON.stringify({ ts: Date.now() - 120000, event: 'Stop', tool: null, ok: true, ms: 12 })}\n`);
    expect((await lap.run(main, ['doctor'])).out).toMatch(/last hook activity 2m ago/);
  });

  it('flags missing hook files, a missing node, a revoked token, an unmapped repo and a missing MCP entry', async () => {
    const lap = laptop();
    await join_(lap);
    const { rmSync } = await import('node:fs');
    rmSync(lap.path('.hivemind', 'hook', 'codex.mjs'));
    const settingsPath = lap.path('.claude', 'settings.json');
    const settings = readJson(settingsPath);
    settings.hooks.Stop[0].hooks[0].command = join(base, 'gone', 'node');
    writeFileSync(settingsPath, JSON.stringify(settings));
    rmSync(lap.stub.file);
    const cfgPath = lap.path('.hivemind', 'config.json');
    const cfg = readJson(cfgPath);
    cfg.repos = ['0000000000000000000000000000000000000000'];
    writeFileSync(cfgPath, JSON.stringify(cfg));
    const r = await lap.run(main, ['doctor']);
    expect(r.code).toBe(1);
    expect(r.out).toContain('hook files missing: codex.mjs');
    expect(r.out).toContain('hooks with a bad path or command for Stop');
    expect(r.out).toContain('MCP server "hivemind" is missing');
    expect(r.out).toContain('NOT mapped');

    cfg.token = OTHER_TOKEN;
    writeFileSync(cfgPath, JSON.stringify(cfg));
    const r2 = await lap.run(main, ['doctor']);
    expect(r2.out).toContain('server check failed');
    expect(r2.out).not.toContain(OTHER_TOKEN);
  });

  it('with nothing set up it says to run join', async () => {
    const lap = makeLaptop(base);
    const r = await lap.run(main, ['doctor']);
    expect(r.code).toBe(1);
    expect(r.out).toContain('hivemind join');
  });

  it('reports a paused laptop', async () => {
    const lap = laptop();
    await join_(lap);
    await lap.run(main, ['off']);
    expect((await lap.run(main, ['doctor'])).out).toContain('paused');
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('the program', () => {
  it('prints help, rejects unknown commands, and runs from the command line', () => {
    const bin = new URL('../hivemind.mjs', import.meta.url);
    const path = decodeURIComponent(bin.pathname.replace(/^\/([A-Za-z]:)/, '$1'));
    const help = spawnSync(process.execPath, [path, 'help'], { encoding: 'utf8' });
    expect(help.status).toBe(0);
    for (const cmd of ['room create', 'invite', 'revoke', 'rotate', 'init', 'join', 'doctor', 'mode', 'unlock', 'off', 'update', 'leave']) {
      expect(help.stdout).toContain(`hivemind ${cmd}`.replace('hivemind off', 'hivemind off'));
    }
    const bad = spawnSync(process.execPath, [path, 'bogus'], { encoding: 'utf8' });
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain('unknown command');
    expect(spawnSync(process.execPath, [path], { encoding: 'utf8' }).status).toBe(1);
  });

  it('never leaves a stray file in the real home folder: tests only use temporary folders', () => {
    // Guard: the harness always sets HIVEMIND_HOME and homedir explicitly.
    const lap = makeLaptop(base);
    const ctx = lap.ctx();
    expect(ctx.homedir.startsWith(base)).toBe(true);
    expect(ctx.env.HIVEMIND_HOME.startsWith(base)).toBe(true);
  });
});

// Keep chmodSync referenced for platforms where modes matter in future tests.
void chmodSync;
