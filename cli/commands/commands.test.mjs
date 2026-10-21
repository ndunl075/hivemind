// @ts-nocheck -- tests use loosely typed fixtures and a fake server; the code under test is type-checked.
/**
 * Command tests. Every test runs against a temporary home and project, a stubbed `claude`/`codex` runner and a fake
 * server on port 8790. This is the only test file that binds 8790, so run files never collide.
 */
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { spawn, spawnSync } from 'node:child_process';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { main } from '../hivemind.mjs';
import { createContext, scrubEnv, shellUnsafe } from './context.mjs';
import { addJsonCommands } from './registrations.mjs';
import { terminalReaders } from './secrets.mjs';
import { writeAtomic } from './files.mjs';
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
    expect(files).toEqual([
      'claude.mjs', 'codex.mjs', 'git.mjs', ...(process.platform === 'win32' ? ['headers-helper.cmd'] : []), 'headers-helper.mjs', 'hook.mjs', 'limits.mjs',
    ]);
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
    expect(mcp.headersHelper).toContain(process.platform === 'win32' ? 'headers-helper.cmd' : 'headers-helper.mjs');
    expect(mcp.headersHelper).not.toContain(AGENT_TOKEN);
    expect(JSON.stringify(mcp)).not.toContain('hm_a.');
  });

  it('the installed hook folder runs on its own: a Codex and a Claude SessionStart print the exact recorded output', async () => {
    const lap = laptop();
    await join_(lap);
    const fixture = (tool, name) => JSON.parse(readFileSync(new URL(`../../shared/fixtures/hooks/${tool}/${name}.json`, import.meta.url), 'utf8'));
    for (const tool of ['codex', 'claude']) {
      const payload = { ...fixture(tool, 'SessionStart'), cwd: lap.project.dir, session_id: `installed-${tool}` };
      const r = await new Promise((resolve) => {
        const child = spawn(process.execPath, [lap.path('.hivemind', 'hook', 'hook.mjs'), tool], {
          env: { ...process.env, HIVEMIND_HOME: lap.path('.hivemind'), TEMP: lap.dir, TMP: lap.dir, TMPDIR: lap.dir },
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (c) => { stdout += c; });
        child.stderr.on('data', (c) => { stderr += c; });
        child.on('close', (status) => resolve({ status, stdout, stderr }));
        child.stdin.end(JSON.stringify(payload));
      });
      expect(r.status).toBe(0);
      expect(r.stdout, r.stderr).toBe(fixture(tool, 'output/SessionStart.additionalContext').stdout);
    }
    expect(srv.requests.filter((q) => q.url === '/hook').map((q) => q.body.agent)).toEqual(['codex', 'claude']);
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

  it('does not read the token from the environment: HIVEMIND_AGENT_TOKEN is ignored', async () => {
    const lap = laptop({ env: { HIVEMIND_AGENT_TOKEN: OTHER_TOKEN } });
    const r = await join_(lap);
    expect(r.code, r.err).toBe(0);
    expect(lap.prompts.some((p) => /token/i.test(p))).toBe(true); // it asked, instead of using the variable
    expect(readJson(lap.path('.hivemind', 'config.json')).token).toBe(AGENT_TOKEN);
  });

  it('--token-stdin reads one piped line, and never prompts', async () => {
    const lap = makeLaptop(base, { stdin: [AGENT_TOKEN] });
    mkdirSync(lap.path('.claude'), { recursive: true });
    const r = await join_(lap, ['--token-stdin']);
    expect(r.code, r.err).toBe(0);
    expect(lap.prompts).toEqual(['<stdin>']);
    expect(readJson(lap.path('.hivemind', 'config.json')).token).toBe(AGENT_TOKEN);
    expect(r.out + r.err).not.toContain(AGENT_TOKEN);
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
    // Root keys first, then our block, then the user's tables untouched.
    const head = '# my codex settings\nmodel = "gpt-5"\n\n';
    expect(toml.startsWith(head)).toBe(true);
    expect(toml.endsWith(EXISTING_TOML.slice(head.length))).toBe(true);
    expect(toml.indexOf('[mcp_servers.hivemind]')).toBeLessThan(toml.indexOf('[mcp_servers.other]'));
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
    await lap.run(main, ['join', '--server', SERVER, '--yes'], { platform: 'linux' });
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
describe('file modes and links', () => {
  const posix = process.platform !== 'win32';

  (posix ? it : it.skip)('config.toml (it holds the token) is owner-only even if it was 0644; other rewritten files keep their mode', async () => {
    const lap = laptop();
    seedExisting(lap);
    chmodSync(lap.path('.codex', 'config.toml'), 0o644);
    chmodSync(lap.path('.claude', 'settings.json'), 0o640);
    chmodSync(lap.path('.codex', 'hooks.json'), 0o664);
    expect((await join_(lap)).code).toBe(0);
    const mode = (...p) => statSync(lap.path(...p)).mode & 0o777;
    expect(mode('.codex', 'config.toml')).toBe(0o600);
    expect(mode('.hivemind', 'config.json')).toBe(0o600);
    expect(mode('.claude', 'settings.json')).toBe(0o640);
    expect(mode('.codex', 'hooks.json')).toBe(0o664);

    // Loosened by hand with nothing else to change: the next join tightens it again.
    chmodSync(lap.path('.codex', 'config.toml'), 0o644);
    chmodSync(lap.path('.hivemind', 'config.json'), 0o644);
    lap.answers.secrets.push(AGENT_TOKEN);
    expect((await join_(lap)).code).toBe(0);
    expect(mode('.codex', 'config.toml')).toBe(0o600);
    expect(mode('.hivemind', 'config.json')).toBe(0o600);
    expect(mode('.claude', 'settings.json')).toBe(0o640);
  });

  (posix ? it : it.skip)('a new config.toml is created owner-only', async () => {
    const lap = laptop();
    await join_(lap);
    expect(statSync(lap.path('.codex', 'config.toml')).mode & 0o777).toBe(0o600);
  });

  it('writeAtomic keeps the mode of the file it replaces unless told otherwise', () => {
    if (!posix) return;
    const f = join(base, `mode-${Date.now()}.txt`);
    writeFileSync(f, 'a');
    chmodSync(f, 0o640);
    writeAtomic(f, 'b');
    expect(statSync(f).mode & 0o777).toBe(0o640);
    writeAtomic(f, 'c', 0o600);
    expect(statSync(f).mode & 0o777).toBe(0o600);
    expect(readFileSync(f, 'utf8')).toBe('c');
  });

  it('rewrites a symlinked dotfile through the link, so the link survives join, update and leave', async (t) => {
    const lap = laptop();
    const real = (n) => join(lap.dir, 'dotfiles', n);
    write(real('settings.json'), `${JSON.stringify({ model: 'x' }, null, 2)}\n`);
    write(real('hooks.json'), `${JSON.stringify({ hooks: { Notification: [{ hooks: [{ type: 'command', command: 'n.sh' }] }] } }, null, 2)}\n`);
    write(real('config.toml'), 'model = "gpt-5"\n\n[tools]\nweb = true\n');
    try {
      symlinkSync(real('settings.json'), lap.path('.claude', 'settings.json'));
      symlinkSync(real('hooks.json'), lap.path('.codex', 'hooks.json'));
      symlinkSync(real('config.toml'), lap.path('.codex', 'config.toml'));
    } catch {
      t.skip(); // no right to create symlinks here
      return;
    }
    const isLink = (...p) => lstatSync(lap.path(...p)).isSymbolicLink();
    const original = ['settings.json', 'hooks.json', 'config.toml'].map((n) => readFileSync(real(n), 'utf8'));

    expect((await join_(lap)).code).toBe(0);
    expect([isLink('.claude', 'settings.json'), isLink('.codex', 'hooks.json'), isLink('.codex', 'config.toml')]).toEqual([true, true, true]);
    expect(readJson(real('settings.json')).hooks.SessionStart).toBeTruthy();
    expect(readJson(real('settings.json')).model).toBe('x');
    expect(readJson(real('hooks.json')).hooks.Notification).toBeTruthy();
    expect(readJson(real('hooks.json')).hooks.Stop).toBeTruthy();
    expect(readFileSync(real('config.toml'), 'utf8')).toContain('[mcp_servers.hivemind]');

    expect((await lap.run(main, ['update'])).code).toBe(0);
    expect(isLink('.claude', 'settings.json')).toBe(true);

    expect((await lap.run(main, ['leave'])).code).toBe(0);
    expect([isLink('.claude', 'settings.json'), isLink('.codex', 'hooks.json'), isLink('.codex', 'config.toml')]).toEqual([true, true, true]);
    expect(['settings.json', 'hooks.json', 'config.toml'].map((n) => readFileSync(real(n), 'utf8')).map((x) => x.replace(/\r\n/g, '\n')))
      .toEqual(original.map((x) => x.replace(/\r\n/g, '\n')));
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('a Claude MCP server the user already has', () => {
  const OWN = { type: 'stdio', command: 'my-hivemind', args: ['--x'] };

  it('is never removed or replaced: join refuses, update refuses, leave leaves it', async () => {
    const lap = laptop();
    write(lap.path('.claude.json'), `${JSON.stringify({ mcpServers: { hivemind: OWN, other: { type: 'stdio', command: 'o' } } }, null, 2)}\n`);
    const r = await join_(lap);
    expect(r.code).toBe(1);
    expect(r.err).toContain('its own MCP server named "hivemind"');
    expect(r.err).toContain('claude mcp remove --scope user hivemind'); // how to move it aside, said, not done
    expect(readJson(lap.path('.claude.json')).mcpServers.hivemind).toEqual(OWN);
    expect(lap.stub.calls.filter((c) => c.args.includes('remove') || c.args.includes('add-json'))).toEqual([]);
    // The rest still went in: Claude hooks, and Codex.
    expect(readJson(lap.path('.claude', 'settings.json')).hooks.SessionStart).toBeTruthy();
    expect(existsSync(lap.path('.codex', 'hooks.json'))).toBe(true);
    expect(readJson(lap.path('.hivemind', 'install.json')).claude.mcp).toBe(false);

    const u = await lap.run(main, ['update']);
    expect(u.code).toBe(1);
    expect(u.err).toContain('its own MCP server');
    expect(lap.stub.calls.filter((c) => c.args.includes('remove') || c.args.includes('add-json'))).toEqual([]);

    const d = await lap.run(main, ['doctor']);
    expect(d.code).toBe(1);
    expect(d.out).toContain('is not the Hivemind one');

    const l = await lap.run(main, ['leave']);
    expect(l.code, l.err).toBe(0);
    expect(l.out).toContain('left alone');
    expect(readJson(lap.path('.claude.json')).mcpServers.hivemind).toEqual(OWN);
    expect(lap.stub.calls.filter((c) => c.args.includes('remove'))).toEqual([]);
  });

  it('an entry that is recognisably ours (our helper path) is replaced, with or without an install record', async () => {
    const lap = laptop();
    const old = { type: 'http', url: 'https://old.example.com/mcp', headersHelper: '"/old/node" "/old/.hivemind/hook/headers-helper.mjs"' };
    write(lap.path('.claude.json'), `${JSON.stringify({ mcpServers: { hivemind: old } }, null, 2)}\n`);
    const r = await join_(lap);
    expect(r.code, r.err).toBe(0);
    expect(readJson(lap.path('.claude.json')).mcpServers.hivemind.url).toBe(`${SERVER}/mcp`);
    expect(lap.stub.calls.some((c) => c.args.includes('remove'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('leave when something cannot be removed', () => {
  it('keeps the hook folder and the install record, says what to fix, and finishes on the next run', async () => {
    const lap = laptop();
    await join_(lap);
    const settings = lap.path('.claude', 'settings.json');
    const good = readFileSync(settings, 'utf8');
    write(settings, '{ "hooks": ');
    const r = await lap.run(main, ['leave']);
    expect(r.code).toBe(1);
    expect(r.err).toContain(settings);
    expect(r.err).toContain('not valid JSON');
    expect(r.err).toContain('hivemind leave again');
    expect(r.out).not.toContain('Left.');
    // Everything needed to try again is still there; the broken file is untouched.
    expect(existsSync(lap.path('.hivemind', 'hook', 'hook.mjs'))).toBe(true);
    expect(existsSync(lap.path('.hivemind', 'install.json'))).toBe(true);
    expect(existsSync(lap.path('.hivemind', 'config.json'))).toBe(true);
    expect(readFileSync(settings, 'utf8')).toBe('{ "hooks": ');
    // The registrations that could be removed were.
    expect(existsSync(lap.path('.codex', 'hooks.json'))).toBe(false);
    expect(readJson(lap.path('.claude.json')).mcpServers ?? {}).toEqual({});

    write(settings, good);
    const again = await lap.run(main, ['leave']);
    expect(again.code, again.err).toBe(0);
    expect(existsSync(lap.path('.hivemind'))).toBe(false);
    expect(existsSync(settings)).toBe(false); // join had created it
  });

  it('a failed "claude mcp remove" also keeps the folder', async () => {
    const lap = laptop();
    await join_(lap);
    const failing = async (cmd, args, opts) => (args.includes('remove') ? { code: 1, stdout: '', stderr: 'boom' } : lap.stub.runner(cmd, args, opts));
    const r = await lap.run(main, ['leave'], { runner: failing });
    expect(r.code).toBe(1);
    expect(r.err).toContain('claude mcp remove --scope user hivemind');
    expect(existsSync(lap.path('.hivemind', 'install.json'))).toBe(true);
    expect(existsSync(lap.path('.hivemind', 'hook', 'hook.mjs'))).toBe(true);
  });

  it('a config.toml whose block was edited is not touched, and the folder stays', async () => {
    const lap = laptop();
    await join_(lap);
    const tomlPath = lap.path('.codex', 'config.toml');
    const edited = readFileSync(tomlPath, 'utf8').replace('tool_timeout_sec = 60', 'tool_timeout_sec = 60\nmy_key = 1');
    write(tomlPath, edited);
    const r = await lap.run(main, ['leave']);
    expect(r.code).toBe(1);
    expect(r.err).toContain('edited');
    expect(readFileSync(tomlPath, 'utf8')).toBe(edited);
    expect(existsSync(lap.path('.hivemind', 'install.json'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('the headersHelper command string, run the way a shell would', () => {
  /** Shells that exist on this machine, each as [name, program, args-for(command), spawn options]. */
  function shells(cmd) {
    if (process.platform !== 'win32') return [['sh', 'sh', ['-c', cmd], {}]];
    const out = [
      ['powershell.exe', 'powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], {}],
      ['cmd.exe', 'cmd.exe', ['/d', '/s', '/c', `"${cmd}"`], { windowsVerbatimArguments: true }],
    ];
    for (const candidate of ['C:/Program Files/Git/bin/bash.exe', 'C:/Program Files (x86)/Git/bin/bash.exe']) {
      if (existsSync(candidate)) { out.push(['git bash', candidate, ['-c', cmd], {}]); break; }
    }
    return out;
  }

  const homes = process.platform === 'win32'
    ? [['a plain folder', 'plain-home'], ['a folder with a space', 'home with space']]
    : [['a plain folder', 'plain-home'], ['a folder with a space', 'home with space'], ['odd characters', 'we ird $x `q` "d"']];

  for (const [label, dirName] of homes) {
    it(`prints the Authorization header under every shell, with ${label}`, async () => {
      const home = join(base, `${dirName}-${Date.now()}`, '.hivemind');
      const lap = laptop({ env: { HIVEMIND_HOME: home } });
      const r = await join_(lap);
      expect(r.code, r.err).toBe(0);
      const cmd = readJson(lap.path('.claude.json')).mcpServers.hivemind.headersHelper;
      expect(cmd).not.toContain(AGENT_TOKEN);
      if (process.platform === 'win32') {
        // One word that needs no shell syntax of its own: the wrapper, with the node path inside it.
        expect(cmd.endsWith('hook/headers-helper.cmd')).toBe(true);
        const wrapper = readFileSync(join(home, 'hook', 'headers-helper.cmd'), 'utf8');
        expect(wrapper).toBe(`@echo off\r\n"${process.execPath}" "%~dp0headers-helper.mjs"\r\n`);
      }
      for (const [name, program, args, opts] of shells(cmd)) {
        const run = spawnSync(program, args, { encoding: 'utf8', timeout: 90000, stdio: ['ignore', 'pipe', 'pipe'], ...opts });
        expect(run.status, `${name}: ${run.stderr}${run.error ?? ''}`).toBe(0);
        expect(JSON.parse(run.stdout), name).toEqual({ Authorization: `Bearer ${AGENT_TOKEN}` });
      }
    }, 180000);
  }

  it('the printed by-hand command reaches `claude` as exactly the JSON, in each shell family', () => {
    // Uses a tiny stand-in for `claude` that prints its last argument, run through the real shells on this machine.
    const script = join(base, `argv-${Date.now()}.mjs`);
    writeFileSync(script, 'process.stdout.write(process.argv[process.argv.length - 1]);\n');
    const helper = process.platform === 'win32' ? 'D:/Ann" "Lee/.hivemind/hook/headers-helper.cmd' : '"/home/me/.hivemind/hook/headers-helper.mjs"';
    const json = JSON.stringify({ type: 'http', url: 'https://hive.example.com/mcp', headersHelper: helper });
    const platform = process.platform === 'win32' ? 'win32' : 'linux';
    const node = process.execPath.replace(/\\/g, '/');
    const prefix = `"${node}" "${script.replace(/\\/g, '/')}" mcp add-json --scope user hivemind`;
    // (These shells quote the program path differently; the stand-in call itself is given in each shell's own form.)
    for (const { shell, command } of addJsonCommands(platform, json, 'NODE_PLACEHOLDER')) {
      const withNode = command.replace('NODE_PLACEHOLDER', shell === 'PowerShell' ? `& ${prefix}` : prefix);
      const [program, args, opts] = shell === 'PowerShell'
        ? ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', withNode], {}]
        : shell === 'Command Prompt'
          ? ['cmd.exe', ['/d', '/s', '/c', `"${withNode}"`], { windowsVerbatimArguments: true }]
          : ['sh', ['-c', withNode], {}];
      const run = spawnSync(program, args, { encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'], ...opts });
      expect(run.status, `${shell}: ${run.stderr}`).toBe(0);
      expect(run.stdout, shell).toBe(json);
    }
  }, 120000);
});

// ---------------------------------------------------------------------------------------------------------------
describe('no secrets in the environment of claude and codex', () => {
  it('scrubEnv drops Hivemind tokens and secrets by name and by value, and keeps the rest', () => {
    const out = scrubEnv({
      HIVEMIND_ADMIN_TOKEN: ADMIN_SECRET, HIVEMIND_AGENT_TOKEN: AGENT_TOKEN, hivemind_secret: 'x', HIVEMIND_SERVER: SERVER, HIVEMIND_HOME: '/h',
      PATH: '/bin', FOO: 'bar', COPIED: AGENT_TOKEN, VIEWER: ` ${VIEWER_TOKEN}`, EMPTY: undefined,
    });
    expect(out).toEqual({ HIVEMIND_SERVER: SERVER, HIVEMIND_HOME: '/h', PATH: '/bin', FOO: 'bar', EMPTY: undefined });
  });

  it('every call to claude or codex gets a scrubbed environment (join, update, doctor, leave)', async () => {
    const lap = laptop({
      env: { HIVEMIND_ADMIN_TOKEN: ADMIN_SECRET, HIVEMIND_AGENT_TOKEN: OTHER_TOKEN, SNEAKY: VIEWER_TOKEN, KEEP_ME: 'yes', HIVEMIND_SERVER: SERVER },
    });
    await join_(lap);
    await lap.run(main, ['update']);
    await lap.run(main, ['doctor']);
    await lap.run(main, ['leave']);
    expect(lap.stub.calls.length).toBeGreaterThan(6);
    for (const call of lap.stub.calls) {
      expect(call.env, JSON.stringify(call.args)).toBeTruthy();
      expect(Object.keys(call.env)).not.toContain('HIVEMIND_ADMIN_TOKEN');
      expect(Object.keys(call.env)).not.toContain('HIVEMIND_AGENT_TOKEN');
      expect(Object.keys(call.env)).not.toContain('SNEAKY');
      expect(call.env.KEEP_ME).toBe('yes');
      expect(JSON.stringify(call)).not.toContain(ADMIN_SECRET);
      expect(JSON.stringify(call)).not.toContain(VIEWER_TOKEN);
      expect(JSON.stringify(call)).not.toContain(OTHER_TOKEN);
    }
  });

  it('the cmd.exe fallback refuses an argument cmd could expand or split', () => {
    expect(shellUnsafe('claude', ['mcp', 'get', 'hivemind'])).toBe(false);
    expect(shellUnsafe('claude', ['mcp', 'add-json', '--scope', 'user', 'hivemind', '{"url":"https://h.example.com/mcp"}'])).toBe(false);
    for (const bad of ['%PATH%', '100%', 'a^b', 'a&calc', 'a|b', 'a<b', 'a>b', 'a\nb']) expect(shellUnsafe('claude', [bad]), bad).toBe(true);
    expect(shellUnsafe('cl%aude', [])).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('secret input', () => {
  const tty = () => {
    const s = new PassThrough();
    s.isTTY = true;
    s.rawModes = [];
    s.setRawMode = (v) => { s.rawModes.push(v); return s; };
    return s;
  };
  const sink = () => ({ text: '', write(x) { this.text += x; return true; } });

  it('refuses to read a secret when stdin is not a terminal, and says what to do', async () => {
    const stdin = new PassThrough();
    const stderr = sink();
    const { readSecret } = terminalReaders({ stdin, stderr });
    stdin.write(`${AGENT_TOKEN}\n`);
    await expect(readSecret('Token')).rejects.toThrow(/real terminal.*--token-stdin/);
    expect(stderr.text).not.toContain(AGENT_TOKEN);
  });

  it('--token-stdin reads exactly one piped line (and not from a terminal)', async () => {
    const stdin = new PassThrough();
    const { readStdin } = terminalReaders({ stdin, stderr: sink() });
    stdin.end(`${AGENT_TOKEN}\r\nsecond line\n`);
    expect(await readStdin()).toBe(AGENT_TOKEN);
    const empty = new PassThrough();
    empty.end('');
    await expect(terminalReaders({ stdin: empty, stderr: sink() }).readStdin()).rejects.toThrow('no value');
    await expect(terminalReaders({ stdin: tty(), stderr: sink() }).readStdin()).rejects.toThrow('piped input');
  });

  it('in a terminal it reads without echo, handles backspace and Enter, and restores the mode', async () => {
    const stdin = tty();
    const stderr = sink();
    const p = terminalReaders({ stdin, stderr }).readSecret('Token');
    stdin.write('ab');
    stdin.write('c\x7fd\r');
    expect(await p).toBe('abd');
    expect(stdin.rawModes).toEqual([true, false]);
    expect(stderr.text).not.toMatch(/abd|abcd/);
  });

  it('input ending in raw mode (end or close) is an error, not a hang, and restores the mode', async () => {
    for (const how of ['end', 'destroy', 'ctrl-d']) {
      const stdin = tty();
      const p = terminalReaders({ stdin, stderr: sink() }).readSecret('Token');
      if (how === 'end') stdin.end();
      else if (how === 'destroy') stdin.destroy();
      else stdin.write('\x04');
      await expect(p, how).rejects.toThrow('input ended');
      expect(stdin.rawModes, how).toEqual([true, false]);
    }
  });

  it('Ctrl-C cancels with exit code 130 and restores the mode', async () => {
    const stdin = tty();
    const p = terminalReaders({ stdin, stderr: sink() }).readSecret('Token');
    stdin.write('ab\x03');
    await expect(p).rejects.toMatchObject({ message: 'cancelled', code: 130 });
    expect(stdin.rawModes).toEqual([true, false]);
  });

  it('the admin commands take the secret from --token-stdin too, and ask for nothing else', async () => {
    const lap = makeLaptop(base, { stdin: [ADMIN_SECRET] });
    const r = await lap.run(main, ['room', 'create', 'hack', '--server', SERVER, '--token-stdin']);
    expect(r.code, r.err).toBe(0);
    expect(lap.prompts).toEqual(['<stdin>']);
    expect(srv.requests[0].auth).toBe(`Bearer ${ADMIN_SECRET}`);
    expect(r.out + r.err).not.toContain(ADMIN_SECRET);
  });

  it('with no terminal and no flag, the real context refuses instead of reading from a pipe', async () => {
    // The default reader of createContext has nobody to ask.
    const bare = createContext({ env: {}, homedir: base, cwd: base, out: () => {}, err: () => {} });
    await expect(bare.readSecret('x')).rejects.toThrow('real terminal');
    await expect(bare.readStdin()).rejects.toThrow('no piped input');
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('messages and checks', () => {
  it('a JSON error names the line and column but never quotes the file', async () => {
    const lap = laptop();
    write(lap.path('.claude', 'settings.json'), '{\n  "env": { "MY_SETTING": "canary-text-visible" "x": 1 }\n}\n');
    const r = await join_(lap);
    expect(r.code).toBe(1);
    expect(r.err).toContain('not valid JSON');
    expect(r.err).toMatch(/line 2, column \d+/);
    expect(r.err).not.toContain("canary-text-visible");
    expect(r.err).not.toContain("MY_SETTING");
  });

  it('without the claude program, the by-hand command is shown per shell: PowerShell and cmd on Windows, sh elsewhere', async () => {
    for (const platform of ['win32', 'linux']) {
      const lap = makeLaptop(base, { secrets: [AGENT_TOKEN], claude: false });
      mkdirSync(lap.path('.claude'), { recursive: true });
      const r = await lap.run(main, ['join', '--server', SERVER, '--yes'], { platform });
      expect(r.code, r.err).toBe(0);
      expect(r.err).toContain('hivemind update');
      expect(r.err).not.toContain(AGENT_TOKEN);
      if (platform === 'win32') {
        expect(r.err).toContain('PowerShell:');
        expect(r.err).toContain('Command Prompt:');
        expect(r.err).not.toContain("'\\''");
        expect(r.err).toContain('\\"type\\"');
      } else {
        expect(r.err).toContain('sh:');
        expect(r.err).toContain("hivemind '{");
      }
    }
  });

  it('a hook of some other hivemind folder is not ours: join adds its own and leave leaves the other alone', async () => {
    const lap = laptop();
    const other = { type: 'command', command: process.execPath, args: [join(base, 'elsewhere', '.hivemind', 'hook', 'hook.mjs'), 'claude'], timeout: 5 };
    write(lap.path('.claude', 'settings.json'), JSON.stringify({ hooks: { SessionStart: [{ hooks: [other] }] } }));
    await join_(lap);
    expect(readJson(lap.path('.claude', 'settings.json')).hooks.SessionStart).toHaveLength(2);
    await lap.run(main, ['leave']);
    expect(readJson(lap.path('.claude', 'settings.json'))).toEqual({ hooks: { SessionStart: [{ hooks: [other] }] } });
  });

  it('update takes our handler out of an event the registrations no longer use, and keeps the user\'s', async () => {
    const lap = laptop();
    await join_(lap);
    const path = lap.path('.claude', 'settings.json');
    const s = readJson(path);
    s.hooks.Notification = [{ hooks: [{ ...s.hooks.Stop[0].hooks[0] }, { type: 'command', command: 'theirs.sh' }] }];
    writeFileSync(path, JSON.stringify(s));
    lap.answers.secrets.push(AGENT_TOKEN);
    expect((await lap.run(main, ['update'])).code).toBe(0);
    expect(readJson(path).hooks.Notification).toEqual([{ hooks: [{ type: 'command', command: 'theirs.sh' }] }]);
    expect(readJson(path).hooks.Stop).toHaveLength(1);
  });

  it('doctor checks the Codex hook paths exist, not only that they are present', async () => {
    const lap = laptop();
    await join_(lap);
    const path = lap.path('.codex', 'hooks.json');
    const hooks = readJson(path);
    const h = hooks.hooks.SessionStart[0].hooks[0];
    h.command = h.command.replace(/^"[^"]*"/, `"${join(base, 'gone', 'node').replace(/\\/g, '/')}"`);
    writeFileSync(path, JSON.stringify(hooks));
    const r = await lap.run(main, ['doctor']);
    expect(r.code).toBe(1);
    expect(r.out).toContain('Codex: hooks with a bad path or command for SessionStart');
  });

  it('doctor accepts the Claude MCP entry join made, and flags one that is not ours', async () => {
    const lap = laptop();
    await join_(lap);
    expect((await lap.run(main, ['doctor'])).out).toContain('MCP server "hivemind" is set up and is ours');
    rmSync(lap.path('.hivemind', 'install.json'));
    write(lap.path('.claude.json'), JSON.stringify({ mcpServers: { hivemind: { type: 'stdio', command: 'x' } } }));
    const r = await lap.run(main, ['doctor']);
    expect(r.code).toBe(1);
    expect(r.out).toContain('is not the Hivemind one');
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
