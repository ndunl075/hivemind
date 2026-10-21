// @ts-nocheck -- tests use loosely typed fixtures; the code under test is type-checked.
/**
 * One laptop in several rooms (ARCHITECTURE.md §6.1): join adds a room per project, leave removes one, the helper
 * and the registrations are per room, and files written by an older version still read. Every test runs against a
 * temporary home and projects, the stubbed `claude`/`codex` runner, and a stubbed fetch (no port is bound).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { main } from '../hivemind.mjs';
import { readRooms } from './install.mjs';
import { allocateMcp, configJson, roomForRepo, roomsFromJson, slug } from './rooms.mjs';
import { headersHelperCommand } from './registrations.mjs';
import { blockNames, codexMcpBlock, hasOurBlock, readBlock, removeBlock, setBlock } from './codex-config.mjs';
import { AGENT_TOKEN, OTHER_TOKEN, cleanup, makeLaptop, makeProject, snapshot, tempBase } from './testkit.mjs';

const SERVER_1 = 'http://127.0.0.1:18791';
const SERVER_2 = 'http://127.0.0.1:18792';
const TOKEN_3 = 'hm_a.test.cat.1.CCCCCCCCCCCCCCCC';

// Who each fake token is. Nothing is listening: the stubbed fetch answers /whoami.
const WHO = {
  [AGENT_TOKEN]: { room: 'my-team', person: 'ana', mode: 'enforce' },
  [OTHER_TOKEN]: { room: 'platform', person: 'ana', mode: 'warn' },
  [TOKEN_3]: { room: 'my-team', person: 'ana', mode: 'enforce' },
};
const fetchStub = async (url, init) => {
  const token = String(init.headers.authorization).replace('Bearer ', '');
  const who = WHO[token];
  const body = who && String(url).endsWith('/whoami') ? who : { error: 'no' };
  return { ok: Boolean(who), status: who ? 200 : 401, json: async () => body };
};

let base;
beforeAll(() => { base = tempBase('hm-rooms-'); });
afterAll(() => cleanup(base));

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

/** A laptop with Claude and Codex present and a second project next to the first. */
function laptop(opts = {}) {
  const lap = makeLaptop(base, opts);
  mkdirSync(lap.path('.claude'), { recursive: true });
  mkdirSync(lap.path('.codex'), { recursive: true });
  lap.second = makeProject(lap.dir, 'proj2');
  lap.third = makeProject(lap.dir, 'proj3');
  return lap;
}
/** join from `project` ('project' | 'second' | 'third') to `server` as the holder of `token`. */
function joinFrom(lap, project, server, token) {
  lap.answers.secrets.push(token);
  const dir = lap[project].dir;
  return lap.run(main, ['join', '--server', server, '--yes'], { cwd: dir, fetch: fetchStub });
}
const run = (lap, argv, project = 'project') => lap.run(main, argv, { cwd: lap[project].dir, fetch: fetchStub });
const config = (lap) => readJson(lap.path('.hivemind', 'config.json'));
const claudeServers = (lap) => readJson(lap.path('.claude.json')).mcpServers ?? {};
const allow = (lap) => (existsSync(lap.path('.claude', 'settings.json')) ? readJson(lap.path('.claude', 'settings.json')).permissions?.allow ?? [] : []);
const toml = (lap) => readFileSync(lap.path('.codex', 'config.toml'), 'utf8');

describe('rooms.mjs', () => {
  it('reads the old single-room format as one room named hivemind', () => {
    const rooms = roomsFromJson({ server: SERVER_1, room: 'r', person: 'p', token: AGENT_TOKEN, repos: ['a'] });
    expect(rooms).toEqual([{ server: SERVER_1, room: 'r', person: 'p', token: AGENT_TOKEN, repos: ['a'], mcp: 'hivemind' }]);
  });

  it('reads the new format, names unnamed or clashing entries, and skips broken ones', () => {
    const e = (room, mcp) => ({ server: SERVER_1, room, person: 'p', token: AGENT_TOKEN, repos: [], ...(mcp ? { mcp } : {}) });
    const rooms = roomsFromJson({ rooms: [e('a'), e('b', 'hivemind'), e('c', 'bad name'), 7, { room: 'no token' }] });
    expect(rooms.map((r) => [r.room, r.mcp])).toEqual([['a', 'hivemind-a'], ['b', 'hivemind'], ['c', 'hivemind-c']]);
    expect(roomsFromJson({ rooms: [] })).toBeNull();
    expect(roomsFromJson(null)).toBeNull();
    expect(roomsFromJson({ server: 1 })).toBeNull();
  });

  it('writes the primary room at the top level and every room in the list', () => {
    const a = { server: SERVER_1, room: 'a', person: 'p', token: AGENT_TOKEN, repos: ['x'], mcp: 'hivemind' };
    const b = { server: SERVER_2, room: 'b', person: 'q', token: OTHER_TOKEN, repos: ['y'], mcp: 'hivemind-b' };
    expect(configJson([a, b])).toEqual({ server: SERVER_1, room: 'a', person: 'p', token: AGENT_TOKEN, repos: ['x'], rooms: [a, b] });
    // when the plain "hivemind" room is not first, it is still the one older readers see
    expect(configJson([b, a]).room).toBe('a');
    expect(roomForRepo([a, b], 'y')).toBe(b);
    expect(roomForRepo([a, b], 'z')).toBeUndefined();
  });

  it('names servers hivemind, hivemind-<room>, and numbers a repeat', () => {
    const r = (mcp) => ({ mcp });
    expect(allocateMcp([], 'My Team!')).toBe('hivemind');
    expect(allocateMcp([r('hivemind')], 'My Team!')).toBe('hivemind-my-team');
    expect(allocateMcp([r('hivemind'), r('hivemind-my-team')], 'my-team')).toBe('hivemind-my-team-2');
    expect(slug('  ÜBER__room  ')).toBe('ber-room');
    expect(slug('!!!')).toBe('room');
    expect(slug('a'.repeat(80)).length).toBe(30);
  });

  it('the helper command carries the server name, except for the plain one', () => {
    const args = ['linux', '/n/node', '/h/hook/headers-helper.mjs', '/h/hook/headers-helper.cmd'];
    expect(headersHelperCommand(...args)).toBe('"/n/node" "/h/hook/headers-helper.mjs"');
    expect(headersHelperCommand(...args, 'hivemind')).toBe('"/n/node" "/h/hook/headers-helper.mjs"');
    expect(headersHelperCommand(...args, 'hivemind-plat')).toBe('"/n/node" "/h/hook/headers-helper.mjs" hivemind-plat');
    expect(headersHelperCommand('win32', 'n', 's', 'C:\\h\\hook\\headers-helper.cmd', 'hivemind-plat')).toBe('C:/h/hook/headers-helper.cmd hivemind-plat');
    expect(() => headersHelperCommand(...args, 'x; rm -rf /')).toThrow();
  });
});

describe('codex blocks for several servers', () => {
  const t = (n) => `hm_a.test.${n}.1.${n.repeat(16).toUpperCase()}`;
  const one = codexMcpBlock('https://a.example.com', t('a'));
  const two = codexMcpBlock('https://b.example.com', t('b'), 'hivemind-plat');
  const original = '# mine\nmodel = "x"\n\n[tools]\nweb = true\n';

  it('holds two blocks side by side, reads each, and removes one at a time', () => {
    const a = setBlock(original, one, 'f');
    const both = setBlock(a, two, 'f', 'hivemind-plat');
    expect(blockNames(both)).toEqual(['hivemind', 'hivemind-plat']);
    expect(readBlock(both).url).toBe('https://a.example.com/mcp');
    expect(readBlock(both, 'hivemind-plat').url).toBe('https://b.example.com/mcp');
    expect(hasOurBlock(both, 'hivemind-plat')).toBe(true);
    expect(removeBlock(both, 'f', 'hivemind-plat')).toBe(a);
    expect(removeBlock(removeBlock(both, 'f', 'hivemind-plat'), 'f')).toBe(original);
    expect(removeBlock(removeBlock(both, 'f'), 'f', 'hivemind-plat')).toBe(original);
  });

  it('adds the second block in either order without disturbing the first, and refreshing is a no-op', () => {
    const bFirst = setBlock(original, two, 'f', 'hivemind-plat');
    const both = setBlock(bFirst, one, 'f');
    expect(blockNames(both).sort()).toEqual(['hivemind', 'hivemind-plat']);
    expect(setBlock(both, one, 'f')).toBe(both);
    expect(setBlock(both, two, 'f', 'hivemind-plat')).toBe(both);
    expect(removeBlock(removeBlock(both, 'f'), 'f', 'hivemind-plat')).toBe(original);
  });

  it('refuses a user table of the same name, and an edited block', () => {
    expect(() => setBlock('[mcp_servers.hivemind-plat]\nurl = "x"\n', two, 'f', 'hivemind-plat')).toThrow('its own');
    const both = setBlock(setBlock(original, one, 'f'), two, 'f', 'hivemind-plat');
    expect(() => removeBlock(both.replace('tool_timeout_sec = 60', 'tool_timeout_sec = 61\nfoo = 1'), 'f', 'hivemind-plat')).not.toThrow(); // other block's text is not looked at
    expect(() => removeBlock(both.replace(/(hivemind-plat\]\n.*\n.*\n.*\n)tool_timeout_sec = 60/, '$1tool_timeout_sec = 60\nfoo = 1'), 'f', 'hivemind-plat')).toThrow('edited');
  });

  it('works with a file that has no tables, and with CRLF endings', () => {
    const crlf = 'model = "x"\r\n';
    const both = setBlock(setBlock(crlf, one, 'f'), two, 'f', 'hivemind-plat');
    expect(both).not.toMatch(/[^\r]\n/);
    expect(removeBlock(removeBlock(both, 'f'), 'f', 'hivemind-plat')).toBe(crlf);
    const fresh = setBlock(setBlock(null, one, 'f'), two, 'f', 'hivemind-plat');
    expect(removeBlock(removeBlock(fresh, 'f', 'hivemind-plat'), 'f').trim()).toBe('');
  });

  it('rejects names that are not Hivemind server names', () => {
    expect(() => codexMcpBlock('https://a.example.com', t('a'), 'other')).toThrow();
    expect(() => setBlock('', one, 'f', 'x"y')).toThrow();
  });
});

describe('join with several rooms', () => {
  it('adds a second room for another project and leaves the first untouched', async () => {
    const lap = laptop();
    expect((await joinFrom(lap, 'project', SERVER_1, AGENT_TOKEN)).code).toBe(0);
    const first = config(lap).rooms[0];
    const claudeBefore = claudeServers(lap).hivemind;

    const r = await joinFrom(lap, 'second', SERVER_2, OTHER_TOKEN);
    expect(r.code, r.err).toBe(0);
    const c = config(lap);
    expect(c.rooms).toHaveLength(2);
    expect(c.rooms[0]).toEqual(first); // byte-for-byte the same entry
    expect(c.rooms[1]).toEqual({ server: SERVER_2, room: 'platform', person: 'ana', token: OTHER_TOKEN, repos: [lap.second.root], mcp: 'hivemind-platform' });
    // the top level is still the first room, for older hooks
    expect(c).toMatchObject({ server: SERVER_1, room: 'my-team', token: AGENT_TOKEN, repos: [lap.project.root] });

    // Claude: two servers, the first as it was; each helper is told its server's name
    const servers = claudeServers(lap);
    expect(servers.hivemind).toEqual(claudeBefore);
    expect(servers['hivemind-platform'].url).toBe(`${SERVER_2}/mcp`);
    expect(servers['hivemind-platform'].headersHelper.endsWith(' hivemind-platform')).toBe(true);
    expect(servers.hivemind.headersHelper).not.toContain('hivemind-platform');
    expect(JSON.stringify(servers)).not.toContain(OTHER_TOKEN);
    expect(allow(lap)).toEqual(expect.arrayContaining(['mcp__hivemind', 'mcp__hivemind-platform']));
    // Codex: two blocks with their own token
    expect(readBlock(toml(lap)).url).toBe(`${SERVER_1}/mcp`);
    expect(readBlock(toml(lap), 'hivemind-platform').url).toBe(`${SERVER_2}/mcp`);
    expect(toml(lap)).toContain(OTHER_TOKEN);
    expect(r.out).toContain('2 rooms');
    expect(r.out).toContain('hivemind-platform');
    // hook registrations exist once, not once per room
    const hooks = readJson(lap.path('.claude', 'settings.json')).hooks;
    expect(hooks.Stop).toHaveLength(1);
  });

  it('a second repo for the same room joins that room instead of making another', async () => {
    const lap = laptop();
    await joinFrom(lap, 'project', SERVER_1, AGENT_TOKEN);
    await joinFrom(lap, 'second', SERVER_1, TOKEN_3); // same server, same room "my-team", a fresh token
    const c = config(lap);
    expect(c.rooms).toHaveLength(1);
    expect(c.rooms[0].repos).toEqual([lap.project.root, lap.second.root]);
    expect(c.rooms[0].token).toBe(TOKEN_3);
    expect(Object.keys(claudeServers(lap))).toEqual(['hivemind']);
  });

  it('joining the same project again changes nothing', async () => {
    const lap = laptop();
    await joinFrom(lap, 'project', SERVER_1, AGENT_TOKEN);
    await joinFrom(lap, 'second', SERVER_2, OTHER_TOKEN);
    const before = snapshot(lap.homedir);
    const r = await joinFrom(lap, 'second', SERVER_2, OTHER_TOKEN);
    expect(r.code).toBe(0);
    expect(snapshot(lap.homedir)).toEqual(before);
  });

  it('moving a project to another room takes it out of the old one, and an emptied room goes away', async () => {
    const lap = laptop();
    await joinFrom(lap, 'project', SERVER_1, AGENT_TOKEN);
    await joinFrom(lap, 'second', SERVER_2, OTHER_TOKEN);
    const r = await joinFrom(lap, 'project', SERVER_2, OTHER_TOKEN); // proj1 moves to "platform"
    expect(r.out).toContain('now belongs to "platform"');
    expect(r.out).toContain('no repositories left');
    const c = config(lap);
    expect(c.rooms).toHaveLength(1);
    expect(c.rooms[0].room).toBe('platform');
    expect(c.rooms[0].repos.sort()).toEqual([lap.project.root, lap.second.root].sort());
    // the emptied room's registrations are gone and the platform room has its own name; nothing dangling
    expect(Object.keys(claudeServers(lap))).toEqual(['hivemind-platform']);
    expect(allow(lap)).not.toContain('mcp__hivemind');
    expect(blockNames(toml(lap))).toEqual(['hivemind-platform']);
  });

  it('a room that is not the first keeps its name when the first leaves', async () => {
    const lap = laptop();
    await joinFrom(lap, 'project', SERVER_1, AGENT_TOKEN);
    await joinFrom(lap, 'second', SERVER_2, OTHER_TOKEN);
    await run(lap, ['leave']); // from the first project
    expect(config(lap).rooms.map((x) => x.mcp)).toEqual(['hivemind-platform']);
    // a new room can take the free plain name
    await joinFrom(lap, 'third', SERVER_1, AGENT_TOKEN);
    expect(config(lap).rooms.map((x) => x.mcp)).toEqual(['hivemind-platform', 'hivemind']);
    expect(config(lap).room).toBe('my-team'); // the top level is the plain "hivemind" room
  });

  it('config.json is owner-only and the Codex file keeps its other settings', async () => {
    const lap = laptop();
    writeFileSync(lap.path('.codex', 'config.toml'), 'model = "gpt-5"\n\n[mcp_servers.other]\ncommand = "npx"\n');
    await joinFrom(lap, 'project', SERVER_1, AGENT_TOKEN);
    await joinFrom(lap, 'second', SERVER_2, OTHER_TOKEN);
    if (process.platform !== 'win32') {
      expect(statSync(lap.path('.hivemind', 'config.json')).mode & 0o077).toBe(0);
      expect(statSync(lap.path('.codex', 'config.toml')).mode & 0o077).toBe(0);
    }
    expect(toml(lap)).toContain('model = "gpt-5"');
    expect(toml(lap)).toContain('[mcp_servers.other]');
  });

  it('refuses to take over a Claude server of the user\'s own with the same name', async () => {
    const lap = laptop();
    await joinFrom(lap, 'project', SERVER_1, AGENT_TOKEN);
    const j = lap.path('.claude.json');
    const o = readJson(j);
    o.mcpServers['hivemind-platform'] = { type: 'stdio', command: 'mine' };
    writeFileSync(j, JSON.stringify(o));
    const r = await joinFrom(lap, 'second', SERVER_2, OTHER_TOKEN);
    expect(r.code).toBe(1);
    expect(r.err).toContain('already has its own MCP server named "hivemind-platform"');
    expect(readJson(j).mcpServers['hivemind-platform']).toEqual({ type: 'stdio', command: 'mine' });
    expect(claudeServers(lap).hivemind.url).toBe(`${SERVER_1}/mcp`); // the first room is still fine
  });
});

describe('leave with several rooms', () => {
  async function two() {
    const lap = laptop();
    await joinFrom(lap, 'project', SERVER_1, AGENT_TOKEN);
    await joinFrom(lap, 'second', SERVER_2, OTHER_TOKEN);
    return lap;
  }

  it('removes only the current project\'s room and its registrations', async () => {
    const lap = await two();
    const r = await run(lap, ['leave'], 'second');
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain('Left room "platform"');
    expect(r.out).toContain('still in 1 room');
    expect(config(lap).rooms.map((x) => x.room)).toEqual(['my-team']);
    expect(Object.keys(claudeServers(lap))).toEqual(['hivemind']);
    expect(allow(lap)).toContain('mcp__hivemind');
    expect(allow(lap)).not.toContain('mcp__hivemind-platform');
    expect(blockNames(toml(lap))).toEqual(['hivemind']);
    expect(toml(lap)).not.toContain(OTHER_TOKEN);
    // the hook stays: the other room needs it
    expect(existsSync(lap.path('.hivemind', 'hook', 'hook.mjs'))).toBe(true);
    expect(readJson(lap.path('.claude', 'settings.json')).hooks.Stop).toHaveLength(1);
  });

  it('removes everything when the last room goes', async () => {
    const lap = await two();
    await run(lap, ['leave'], 'second');
    const r = await run(lap, ['leave']);
    expect(r.code, r.err).toBe(0);
    expect(existsSync(lap.path('.hivemind'))).toBe(false);
    expect(claudeServers(lap)).toEqual({});
    expect(allow(lap)).toEqual([]);
  });

  it('only drops this project from a room that other projects here still use', async () => {
    const lap = laptop();
    await joinFrom(lap, 'project', SERVER_1, AGENT_TOKEN);
    await joinFrom(lap, 'second', SERVER_1, TOKEN_3);
    const r = await run(lap, ['leave'], 'second');
    expect(r.out).toContain('no longer mapped');
    expect(config(lap).rooms[0].repos).toEqual([lap.project.root]);
    expect(claudeServers(lap).hivemind).toBeDefined();
  });

  it('--room drops a whole room by name, whatever folder it runs in', async () => {
    const lap = await two();
    const r = await run(lap, ['leave', '--room', 'my-team'], 'third');
    expect(r.code, r.err).toBe(0);
    expect(config(lap).rooms.map((x) => x.room)).toEqual(['platform']);
    expect(Object.keys(claudeServers(lap))).toEqual(['hivemind-platform']);
    const bad = await run(lap, ['leave', '--room', 'nope']);
    expect(bad.code).toBe(1);
    expect(bad.err).toContain('not in a room called "nope"');
  });

  it('--all removes every room', async () => {
    const lap = await two();
    const r = await run(lap, ['leave', '--all'], 'third');
    expect(r.code, r.err).toBe(0);
    expect(existsSync(lap.path('.hivemind'))).toBe(false);
    expect(claudeServers(lap)).toEqual({});
    expect(existsSync(lap.path('.codex', 'config.toml')) ? toml(lap) : '').not.toContain('hivemind');
  });

  it('from a project that is in no room it asks which, when there are several', async () => {
    const lap = await two();
    const before = snapshot(lap.homedir);
    const r = await run(lap, ['leave'], 'third');
    expect(r.code).toBe(1);
    expect(r.err).toContain('--room <name>');
    expect(snapshot(lap.homedir)).toEqual(before);
    expect((await run(lap, ['leave', '--all', '--room', 'x'])).code).toBe(1);
  });

  it('with one room, leave works from any folder, as it always did', async () => {
    const lap = laptop();
    await joinFrom(lap, 'project', SERVER_1, AGENT_TOKEN);
    const r = await run(lap, ['leave'], 'third');
    expect(r.code, r.err).toBe(0);
    expect(existsSync(lap.path('.hivemind'))).toBe(false);
  });
});

describe('update, doctor and room commands with several rooms', () => {
  it('update refreshes every room and repairs a missing registration', async () => {
    const lap = laptop();
    await joinFrom(lap, 'project', SERVER_1, AGENT_TOKEN);
    await joinFrom(lap, 'second', SERVER_2, OTHER_TOKEN);
    const j = lap.path('.claude.json');
    const o = readJson(j);
    delete o.mcpServers['hivemind-platform'];
    writeFileSync(j, JSON.stringify(o));
    const r = await run(lap, ['update']);
    expect(r.code, r.err).toBe(0);
    expect(Object.keys(claudeServers(lap)).sort()).toEqual(['hivemind', 'hivemind-platform']);
    expect(config(lap).rooms).toHaveLength(2);
  });

  it('doctor lists every room, checks each, and says which one this project is in', async () => {
    const lap = laptop();
    await joinFrom(lap, 'project', SERVER_1, AGENT_TOKEN);
    await joinFrom(lap, 'second', SERVER_2, OTHER_TOKEN);
    const r = await run(lap, ['doctor'], 'second');
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain('config: 2 rooms');
    expect(r.out).toContain('room "my-team" as "ana"');
    expect(r.out).toContain('room "platform" as "ana"');
    expect(r.out).toContain('this repository is mapped to room "platform"');
    expect(r.out).toContain('MCP server "hivemind-platform" (room "platform") is set up and is ours');
    expect(r.out).toContain('Codex: MCP server "hivemind-platform" URL matches');
    expect(r.out).toContain('permission rule "mcp__hivemind-platform" present');
    expect(r.out).not.toContain(OTHER_TOKEN);
    // break the second room's Claude entry only
    const j = lap.path('.claude.json');
    const o = readJson(j);
    delete o.mcpServers['hivemind-platform'];
    writeFileSync(j, JSON.stringify(o));
    const bad = await run(lap, ['doctor'], 'second');
    expect(bad.code).toBe(1);
    expect(bad.out).toContain('MCP server "hivemind-platform" (room "platform") is missing');
    expect(bad.out).toContain('Claude Code: MCP server "hivemind" (room "my-team") is set up and is ours');
    const unmapped = await run(lap, ['doctor'], 'third');
    expect(unmapped.out).toContain('NOT mapped to any room');
  });

  it('mode and unlock go to the room of the project they run in', async () => {
    const lap = laptop();
    await joinFrom(lap, 'project', SERVER_1, AGENT_TOKEN);
    await joinFrom(lap, 'second', SERVER_2, OTHER_TOKEN);
    const seen = [];
    const rec = async (url, init) => { seen.push([String(url), init.headers.authorization]); return { ok: true, status: 200, json: async () => ({ mode: 'warn' }) }; };
    const r1 = await lap.run(main, ['mode', 'warn'], { cwd: lap.second.dir, fetch: rec });
    expect(r1.out).toContain('Room "platform"');
    await lap.run(main, ['mode', 'warn'], { cwd: lap.project.dir, fetch: rec });
    expect(seen).toEqual([[`${SERVER_2}/mode`, `Bearer ${OTHER_TOKEN}`], [`${SERVER_1}/mode`, `Bearer ${AGENT_TOKEN}`]]);
    const lost = await lap.run(main, ['mode', 'warn'], { cwd: lap.third.dir, fetch: rec });
    expect(lost.code).toBe(1);
    expect(lost.err).toContain('2 rooms');
    expect(seen).toHaveLength(2);
  });
});

describe('headers helper', () => {
  /** Run the installed helper the way Claude would: a child process in the hook folder, with an optional argument. */
  const helper = (lap, ...args) => spawnSync(process.execPath, [lap.path('.hivemind', 'hook', 'headers-helper.mjs'), ...args], { encoding: 'utf8' });

  it('prints the token of the server it is told, and the first room\'s with no argument', async () => {
    const lap = laptop();
    await joinFrom(lap, 'project', SERVER_1, AGENT_TOKEN);
    await joinFrom(lap, 'second', SERVER_2, OTHER_TOKEN);
    const plain = helper(lap);
    expect(plain.status).toBe(0);
    expect(JSON.parse(plain.stdout)).toEqual({ Authorization: `Bearer ${AGENT_TOKEN}` });
    expect(JSON.parse(helper(lap, 'hivemind').stdout)).toEqual({ Authorization: `Bearer ${AGENT_TOKEN}` });
    expect(JSON.parse(helper(lap, 'hivemind-platform').stdout)).toEqual({ Authorization: `Bearer ${OTHER_TOKEN}` });
    const unknown = helper(lap, 'hivemind-nope');
    expect(unknown.status).toBe(1);
    expect(unknown.stdout).toBe('');
    expect(unknown.stderr).toContain('no token found');
  });

  it('the command written to ~/.claude.json runs the right helper, per room', async () => {
    const lap = laptop();
    await joinFrom(lap, 'project', SERVER_1, AGENT_TOKEN);
    await joinFrom(lap, 'second', SERVER_2, OTHER_TOKEN);
    const servers = claudeServers(lap);
    for (const [name, token] of [['hivemind', AGENT_TOKEN], ['hivemind-platform', OTHER_TOKEN]]) {
      const cmd = servers[name].headersHelper;
      const run_ = spawnSync(cmd, { shell: true, encoding: 'utf8' });
      expect(run_.status, `${name}: ${run_.stderr}`).toBe(0);
      expect(JSON.parse(run_.stdout)).toEqual({ Authorization: `Bearer ${token}` });
    }
  });

  it('an older config.json (one room, no list) is served to the plain server', async () => {
    const lap = laptop();
    await joinFrom(lap, 'project', SERVER_1, AGENT_TOKEN);
    const old = config(lap);
    delete old.rooms;
    writeFileSync(lap.path('.hivemind', 'config.json'), JSON.stringify(old));
    expect(JSON.parse(helper(lap).stdout)).toEqual({ Authorization: `Bearer ${AGENT_TOKEN}` });
    expect(helper(lap, 'hivemind-platform').status).toBe(1);
  });
});

describe('version skew', () => {
  it('a config.json written by the old CLI (one room) is read, kept by update, and rewritten in the new shape', async () => {
    const lap = laptop();
    mkdirSync(dirname(lap.path('.hivemind', 'config.json')), { recursive: true });
    const old = { server: SERVER_1, room: 'my-team', person: 'ana', token: AGENT_TOKEN, repos: [lap.project.root] };
    writeFileSync(lap.path('.hivemind', 'config.json'), JSON.stringify(old));
    expect(readRooms(lap.ctx())).toEqual([{ ...old, mcp: 'hivemind' }]);
    const r = await run(lap, ['update']);
    expect(r.code, r.err).toBe(0);
    expect(config(lap)).toEqual({ ...old, rooms: [{ ...old, mcp: 'hivemind' }] });
    // joining a second room on top of the old file keeps the first as it was
    await joinFrom(lap, 'second', SERVER_2, OTHER_TOKEN);
    expect(config(lap).rooms[0]).toEqual({ ...old, mcp: 'hivemind' });
    expect(config(lap).rooms).toHaveLength(2);
  });

  it('an install.json from before several rooms (mcp: true, allowAdded) is understood by leave', async () => {
    const lap = laptop();
    await joinFrom(lap, 'project', SERVER_1, AGENT_TOKEN);
    const mPath = lap.path('.hivemind', 'install.json');
    const m = readJson(mPath);
    delete m.claude.mcpServers;
    delete m.claude.allowRules;
    writeFileSync(mPath, JSON.stringify(m));
    const r = await run(lap, ['leave']);
    expect(r.code, r.err).toBe(0);
    expect(claudeServers(lap)).toEqual({});
    expect(allow(lap)).toEqual([]);
    expect(existsSync(lap.path('.hivemind'))).toBe(false);
  });

  it('a registration made before several rooms is exactly what is written now for the first room', async () => {
    const lap = laptop();
    await joinFrom(lap, 'project', SERVER_1, AGENT_TOKEN);
    const before = snapshot(lap.homedir);
    // update must not touch the Claude entry: the old string equals the new one
    const calls = lap.stub.calls.length;
    await run(lap, ['update']);
    expect(lap.stub.calls.slice(calls).some((c) => c.args.includes('add-json') || c.args.includes('remove'))).toBe(false);
    expect(snapshot(lap.homedir)).toEqual(before);
  });

  it('the Windows wrapper passes the server name on', () => {
    // headersHelperCommand puts the name after the wrapper; the wrapper forwards %* to the helper (merge.test.mjs).
    expect(headersHelperCommand('win32', 'n', 's', 'C:\\h\\hook\\headers-helper.cmd', 'hivemind-a')).toBe('C:/h/hook/headers-helper.cmd hivemind-a');
  });
});
