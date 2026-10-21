/**
 * End to end: the real hook (cli/hook/hook.mjs, claude and codex) against the real server (wrangler dev, port 8788),
 * with payloads built from the recorded fixtures. Each scenario has its own room and its own Git clones.
 * Covers blocked edits, release by push, the push notice, shell-edit conflicts, task claim races, message delivery,
 * the task gate, room modes, emergency unlock and the dashboard socket.
 */
import { writeFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { SERVER, Team, admin, git, makeTemp, removeTemp, sleep, startServer, mcpCall, type RunningServer } from '../harness';

let persist: string;
let server: RunningServer;
const teams: Team[] = [];

async function team(room: string, files?: Record<string, string>, settings?: object | null): Promise<Team> {
  const t = await new Team(room).open(files, settings);
  teams.push(t);
  return t;
}

beforeAll(async () => {
  persist = makeTemp('hm-e2e-state-');
  server = await startServer(persist);
});

afterAll(async () => {
  await server?.stop();
  for (const t of teams) t.dispose();
  removeTemp(persist);
});

describe('blocked edit', () => {
  it('denies a second agent on the same file, for both tools, and leaves the file alone', async () => {
    const t = await team('blocked');
    const ana = await t.agent('ana', 'claude');
    const nico = await t.agent('nico', 'codex');

    const first = await ana.edit('a.txt', 'ana was here\n');
    expect(first.denied).toBe(false);
    expect(first.code).toBe(0);

    // Codex: apply_patch is denied with the §9 text, in the shape Codex accepts.
    const blocked = await nico.preEdit('a.txt');
    expect(blocked.denied).toBe(true);
    expect(blocked.code).toBe(0);
    expect(blocked.reason).toContain('[Hivemind] Edit blocked: a.txt is held by claude-ana');
    expect(blocked.reason).toContain('`wait` with for: "release:a.txt"');
    expect(Object.keys(blocked.json)).toEqual(['hookSpecificOutput']);

    // A free file is fine for nico, and ana may keep editing her own file.
    expect((await nico.edit('b.txt')).denied).toBe(false);
    expect((await ana.edit('a.txt', 'again\n')).denied).toBe(false);

    // The same collision the other way round, with Claude's tool being the blocked one.
    const second = await t.agent('mia', 'claude');
    const viaClaude = await second.preEdit('b.txt');
    expect(viaClaude.denied).toBe(true);
    expect(viaClaude.reason).toContain('held by codex-nico');

    // The status tool agrees about who holds what.
    const status = await second.mcp('status');
    const held = (status.value.heldByOthers as { path: string; holder: string }[]).map((l) => `${l.path}:${l.holder}`).sort();
    expect(held).toEqual(['a.txt:claude-ana', 'b.txt:codex-nico']);
  });

  it('blocks a file inside a reserved folder, all or nothing', async () => {
    const t = await team('reserve');
    const ana = await t.agent('ana');
    const nico = await t.agent('nico', 'codex');
    const got = await ana.mcp('reserve', { folders: ['src/'], reason: 'refactor' });
    expect(got.value.granted).toBe(true);
    const blocked = await nico.preEdit('src/app.ts');
    expect(blocked.denied).toBe(true);
    expect(blocked.reason).toContain('src/');
    const refused = await nico.mcp('reserve', { folders: ['docs/', 'src/'] });
    expect(refused.value.granted).toBe(false);
    expect((await nico.preEdit('docs/new.md')).denied).toBe(false);
  });

  it('never denies advisory paths such as package.json', async () => {
    const t = await team('advisory', { 'a.txt': 'x\n', 'package.json': '{}\n' });
    const ana = await t.agent('ana');
    const nico = await t.agent('nico', 'codex');
    expect((await ana.edit('package.json', '{"a":1}\n')).denied).toBe(false);
    expect((await nico.preEdit('package.json')).denied).toBe(false);
  });
});

describe('release by push', () => {
  it('releases the lock when the file is pushed, tells the other agent, and warns about a stale copy', async () => {
    const t = await team('push');
    const ana = await t.agent('ana', 'claude');
    const nico = await t.agent('nico', 'codex');

    expect((await ana.edit('a.txt', 'pushed by ana\n')).denied).toBe(false);
    const lockedAt = Date.now();
    expect((await nico.preEdit('a.txt')).denied).toBe(true);

    // nico waits for the release (the wait tool resolves on the lock being freed, not on a timer).
    const waiting = nico.mcp('wait', { seconds: 40, for: 'release:a.txt' });

    // A heartbeat while the file is dirty is what lets the hook recognise the later push (it remembers the divergent
    // list from its last Git report; see the evidence file for the edit-then-push-within-15-s gap).
    await ana.heartbeat();

    // ana publishes. The push is noticed at once, and the other agent is told on its next event.
    await ana.shell('git push', () => ana.commitAndPush('ana changes a.txt'));
    const notice = await nico.heartbeat();
    expect(notice.context).toMatch(/claude-ana pushed main \(1 file: a\.txt\)\. Pull before editing that file\./);
    // A lock younger than one heartbeat interval survives a report (rule 3, covered by the server tests); once it is older,
    // the next report releases it. On a slow machine the push report may already be late enough, so nothing is asserted in between.
    await sleep(Math.max(0, lockedAt + 16_500 - Date.now()));
    await ana.heartbeat();

    const woke = await waiting;
    expect(woke.value.event).toBe('release');

    // The lock is gone: nico may edit, but his clone is behind, so the hook warns him first.
    const pre = await nico.preEdit('a.txt');
    expect(pre.denied).toBe(false);
    expect(pre.context).toContain('[Hivemind] Before you edit:');
    expect(pre.context).toMatch(/claude-ana pushed changes to a\.txt .*(Pull|pull) first\./);

    // After pulling there is nothing to warn about.
    git(nico.dir, 'pull', '-q', 'origin', 'main');
    const after = await nico.preEdit('a.txt');
    expect(after.denied).toBe(false);
    expect(after.context).not.toContain('Before you edit');
  });

  it('releases when a file is reverted instead of pushed', async () => {
    const t = await team('revert');
    const ana = await t.agent('ana');
    const nico = await t.agent('nico', 'codex');
    await ana.edit('b.txt', 'oops\n');
    const lockedAt = Date.now();
    expect((await nico.preEdit('b.txt')).denied).toBe(true);
    await ana.shell('git checkout -- b.txt', () => git(ana.dir, 'checkout', '--', 'b.txt'));
    await sleep(Math.max(0, lockedAt + 16_500 - Date.now()));
    await ana.heartbeat();
    expect((await nico.preEdit('b.txt')).denied).toBe(false);
  });

  it('frees every lock when the agent ends', async () => {
    const t = await team('ends');
    const ana = await t.agent('ana');
    const nico = await t.agent('nico', 'codex');
    await ana.edit('a.txt');
    expect((await nico.preEdit('a.txt')).denied).toBe(true);
    await ana.end();
    expect((await nico.preEdit('a.txt')).denied).toBe(false);
    // A message to an agent that has ended bounces.
    const bounced = await nico.mcp('post', { to: ana.callsign, text: 'are you there?' });
    expect(JSON.stringify(bounced.value)).toMatch(/ended|bounce/i);
  });
});

describe('shell edits', () => {
  it('locks a file a shell command changed, and blocks the other agent from it', async () => {
    const t = await team('shell-lock');
    const ana = await t.agent('ana', 'claude');
    const nico = await t.agent('nico', 'codex');
    await ana.shell('echo changed > b.txt', () => { writeFileSync(ana.abs('b.txt'), 'changed by a shell\n'); });
    // The shell command is noticed afterwards (rule 4): from now on b.txt is ana's.
    const blocked = await nico.preEdit('b.txt');
    expect(blocked.denied).toBe(true);
    expect(blocked.reason).toContain('held by claude-ana');
  });

  it('announces a conflict to both agents when two checkouts change the same file', async () => {
    const t = await team('shell-conflict');
    const ana = await t.agent('ana', 'claude');
    const nico = await t.agent('nico', 'codex');
    await ana.edit('a.txt', 'ana\n');
    // nico dodges the hook and changes the same file with a shell command in his own checkout.
    const reported = await nico.shell('sed -i s/x/y/ a.txt', () => { writeFileSync(nico.abs('a.txt'), 'nico by shell\n'); });
    // Nothing is blocked (the edit already happened), but both sides are told.
    const seen = reported.context + (await nico.heartbeat()).context;
    expect(seen).toMatch(/Conflict: a\.txt is also changed by claude-ana in another checkout/);
    const theirs = (await ana.heartbeat()).context;
    expect(theirs).toMatch(/Conflict: codex-nico changed a\.txt, which you hold, in another checkout/);
    // ... and the dashboard has a blocked edge between them.
    const edges = await snapshotOf(t);
    expect(edges.edges.some((e: any) => e.kind === 'blocked')).toBe(true);
  });
});

describe('tasks', () => {
  it('denies edits without a task, then allows them after a claim (the task gate)', async () => {
    const t = await team('gate', undefined, null); // no .hivemind/project.json: defaults, requireTask on
    const ana = await t.agent('ana');
    const denied = await ana.preEdit('a.txt');
    expect(denied.denied).toBe(true);
    expect(denied.reason).toMatch(/task/i);
    const added = await ana.mcp('task_add', { tasks: [{ title: 'Fix a.txt' }], claim: true });
    expect(added.value.claim.result).toBe('ok');
    expect((await ana.edit('a.txt')).denied).toBe(false);
  });

  it('lets exactly one of 40 simultaneous claims win', async () => {
    const t = await team('claim-race');
    const room = t.room;
    // Twenty people (ten Claude, ten Codex) register without hooks: tokens from the admin API, callsigns from `register`.
    const people = await Promise.all(Array.from({ length: 20 }, async (_, i) => {
      const person = `p${i}`;
      const { agentToken } = await admin(`/admin/rooms/${room}/invite`, { person });
      const reg = await mcpCall(SERVER, agentToken as string, 'register', { kind: i % 2 === 0 ? 'claude' : 'codex' });
      return { token: agentToken as string, cs: (reg.value.callsign ?? reg.value.you?.callsign) as string };
    }));
    expect(people.every((p) => typeof p.cs === 'string' && p.cs.length > 0)).toBe(true);
    const first = people[0]!;
    const added = await mcpCall(SERVER, first.token, 'task_add', { me: first.cs, tasks: [{ title: 'The contested task' }], claim: false });
    const id = added.value.created[0].id as number;

    const results = await Promise.all(people.flatMap((p) => [0, 1].map(async () => ({
      cs: p.cs, r: (await mcpCall(SERVER, p.token, 'task_claim', { me: p.cs, id })).value,
    }))));
    expect(results).toHaveLength(40);
    const winners = new Set(results.filter((x) => x.r.result === 'ok').map((x) => x.cs));
    expect(winners.size).toBe(1);
    for (const x of results.filter((y) => y.r.result !== 'ok')) {
      expect(x.r.result).toBe('taken');
      expect(x.r.owner).toBe([...winners][0]);
    }
    const board = await mcpCall(SERVER, first.token, 'status', { me: first.cs });
    const task = (board.value.tasks as { id: number; owner: string; status: string }[]).find((x) => x.id === id);
    expect(task).toMatchObject({ status: 'in_progress', owner: [...winners][0] });
  });
});

describe('messages', () => {
  it('delivers a direct message and a broadcast through the hooks, once each', async () => {
    const t = await team('messages');
    const ana = await t.agent('ana', 'claude');
    const nico = await t.agent('nico', 'codex');
    const mia = await t.agent('mia', 'claude');

    expect((await ana.mcp('post', { to: nico.callsign, text: 'please leave login.ts to me' })).isError).toBe(false);
    expect((await ana.mcp('post', { to: 'all', text: 'lunch at noon' })).isError).toBe(false);

    const first = await nico.heartbeat();
    expect(first.context).toContain('message from claude-ana');
    expect(first.context).toContain('please leave login.ts to me');
    expect(first.context).toContain('lunch at noon');
    // Delivered once: the next event is quiet, and the inbox has nothing unread.
    expect((await nico.heartbeat()).context).not.toContain('lunch at noon');
    expect((await nico.mcp('inbox')).value.unread).toEqual([]);

    // mia got the broadcast but not the direct message.
    const miaGot = (await mia.heartbeat()).context;
    expect(miaGot).toContain('lunch at noon');
    expect(miaGot).not.toContain('login.ts');

    // An agent that did not read its hooks can still pull its mail with the inbox tool.
    await ana.mcp('post', { to: mia.callsign, text: 'pull before you push' });
    const inbox = await mia.mcp('inbox');
    expect(JSON.stringify(inbox.value.unread)).toContain('pull before you push');
  });

  it('wakes a waiting agent when a message arrives', async () => {
    const t = await team('wait-message');
    const ana = await t.agent('ana');
    const nico = await t.agent('nico', 'codex');
    const waiting = nico.mcp('wait', { seconds: 30, for: 'message' });
    // If the post lands before the wait is parked, `wait` returns at once because the message is already there; if
    // after, it wakes. Either way the event is 'message', so no fixed sleep is needed.
    await ana.mcp('post', { to: nico.callsign, text: 'ping' });
    const woke = await waiting;
    expect(woke.value.event).toBe('message');
  });
});

describe('room modes and emergency unlock', () => {
  it('warn turns a denial into a heads-up, off checks nothing, enforce denies again', async () => {
    const t = await team('modes');
    const ana = await t.agent('ana');
    const nico = await t.agent('nico', 'codex');
    await ana.edit('a.txt');
    expect((await nico.preEdit('a.txt')).denied).toBe(true);

    await t.mode(ana, 'warn');
    const warned = await nico.preEdit('a.txt');
    expect(warned.denied).toBe(false);
    expect(warned.context).toContain('Heads-up: a.txt is held by claude-ana');
    expect(warned.context).toContain('Room mode is warn');
    // The room told everyone about the change.
    expect((await ana.heartbeat()).context + (await nico.heartbeat()).context).toContain('Room mode is now warn');

    await t.mode(ana, 'off');
    const off = await nico.preEdit('a.txt');
    expect(off.denied).toBe(false);
    expect(off.context).not.toContain('Heads-up');
    // The mode reaches the hook state, which is what the briefing and later hooks use.
    expect(nico.state().mode).toBe('off');

    await t.mode(ana, 'enforce');
    expect((await nico.preEdit('a.txt')).denied).toBe(true);
  });

  it('emergency unlock releases a path, or everything an agent holds, and tells the room', async () => {
    const t = await team('unlock');
    const ana = await t.agent('ana');
    const nico = await t.agent('nico', 'codex');
    await ana.edit('a.txt');
    await ana.edit('b.txt');
    expect((await nico.preEdit('a.txt')).denied).toBe(true);

    const one = await t.unlock(nico, { path: { repo: t.repoId, path: 'a.txt' } });
    expect(one.released).toHaveLength(1);
    expect((await nico.preEdit('a.txt')).denied).toBe(false);
    expect((await nico.preEdit('b.txt')).denied).toBe(true);
    expect((await ana.heartbeat()).context).toContain('Emergency unlock by nico: a.txt');

    const all = await t.unlock(nico, { agent: ana.callsign });
    expect(all.released).toHaveLength(1);
    expect((await nico.preEdit('b.txt')).denied).toBe(false);

    const bad = await fetch(`${SERVER}/unlock`, {
      method: 'POST', headers: { authorization: `Bearer ${nico.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ path: { repo: t.repoId, path: 'a.txt' }, agent: ana.callsign }),
    });
    expect(bad.status).toBe(400);
  });

  it('rejects an invalid mode', async () => {
    const t = await team('badmode');
    const ana = await t.agent('ana');
    const res = await fetch(`${SERVER}/mode`, {
      method: 'POST', headers: { authorization: `Bearer ${ana.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'chaos' }),
    });
    expect(res.status).toBe(400);
  });
});

describe('dashboard socket', () => {
  it('sends a snapshot on connect that shows agents, locks and the mode; a bad token is refused', async () => {
    const t = await team('dash');
    const ana = await t.agent('ana');
    await ana.edit('a.txt');
    const snap = await snapshotOf(t);
    expect(snap.type).toBe('snapshot');
    expect(snap.room).toBe('dash');
    expect(snap.mode).toBe('enforce');
    expect(snap.agents.map((a: any) => a.callsign)).toContain('claude-ana');
    expect(snap.locks.map((l: any) => l.path)).toContain('a.txt');

    const refused = await new Promise<string>((resolve) => {
      const ws = new WebSocket(`${SERVER.replace('http', 'ws')}/r/dash/ws`, ['hivemind', 'hm_v.test.1.forged-signature-not-real']);
      ws.on('unexpected-response', (_req, res) => resolve(`http ${res.statusCode}`));
      ws.on('open', () => resolve('open'));
      ws.on('error', () => undefined);
    });
    expect(refused).toBe('http 401');
  });
});

/** The first message on a dashboard socket for the team's room. */
function snapshotOf(t: Team): Promise<any> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${SERVER.replace('http', 'ws')}/r/${t.room}/ws`, ['hivemind', t.viewerToken]);
    const timer = setTimeout(() => { ws.terminate(); reject(new Error('no snapshot in 10 s')); }, 10_000);
    ws.on('message', (d) => {
      clearTimeout(timer);
      ws.close();
      resolve(JSON.parse(String(d)));
    });
    ws.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

