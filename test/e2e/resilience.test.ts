/**
 * End to end: what happens when things go wrong or run out (fail-open, circuit breaker, outage notice), and the
 * states that would otherwise take hours or ~95,000 requests to reach (takeover of a quiet holder, the budget guard).
 * Those are reached by stopping wrangler dev, writing the Room's SQLite file, and starting it again, so the server
 * code that reacts is the real one.
 */
import { createServer, type Server } from 'node:http';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LIMITS } from '../../shared/contracts';
import {
  Agent, SERVER, Team, makeTemp, removeTemp, runHook, seedRoom, sessionStatePath, startServer, writeHookConfig, type RunningServer,
} from '../harness';

let persist: string;
let server: RunningServer;
const teams: Team[] = [];
const stubs: Server[] = [];

async function team(room: string, settings: object | null = { requireTask: false }): Promise<Team> {
  const t = await new Team(room).open(undefined, settings);
  teams.push(t);
  return t;
}

/** A TCP port nothing listens on. */
async function closedPort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const port = (s.address() as { port: number }).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

/** A server that accepts connections and never answers. */
async function silentServer(): Promise<string> {
  const s = createServer(() => undefined);
  stubs.push(s);
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(s.address() as { port: number }).port}`;
}

const today = () => new Date().toISOString().slice(0, 10);

beforeAll(async () => {
  persist = makeTemp('hm-e2e-state-');
  server = await startServer(persist);
});

afterAll(async () => {
  await server?.stop();
  for (const s of stubs) s.close();
  for (const t of teams) t.dispose();
  removeTemp(persist);
});

// ------------------------------------------------------------------------------------------------ fail-open

describe('fail-open', () => {
  it('allows the edit and prints nothing when the server is unreachable, then says so once when the breaker opens', async () => {
    const t = await team('outage');
    const dead = `http://127.0.0.1:${await closedPort()}`;
    const dave = await t.agent('dave', 'claude', false, dead);

    // Failures 1 and 2: the edit goes ahead, silently, exit 0.
    for (const call of [() => dave.fire('SessionStart'), () => dave.preEdit('a.txt')]) {
      const r = await call();
      expect(r.code).toBe(0);
      expect(r.denied).toBe(false);
      expect(r.stdout).toBe('');
    }
    expect(dave.state().failures).toBe(2);

    // Failure 3 opens the breaker; the edit still goes ahead, with one notice for the agent.
    const third = await dave.preEdit('a.txt');
    expect(third.denied).toBe(false);
    expect(third.context).toContain("[Hivemind] Can't reach the server (3 failed attempts).");
    expect(third.context).toContain('edits aren\'t being checked');
    expect(dave.state().failures).toBe(3);
    const attemptedAt = dave.state().lastAttemptAt as number;

    // With the breaker open there is no network attempt, no repeat of the notice, and no delay.
    for (let i = 0; i < 3; i++) {
      const r = await dave.preEdit('b.txt');
      expect(r.code).toBe(0);
      expect(r.denied).toBe(false);
      expect(r.stdout).toBe('');
    }
    expect(dave.state().lastAttemptAt).toBe(attemptedAt);
    expect(dave.state().failures).toBe(3);

    // A SessionEnd during the outage is fine, too.
    expect((await dave.end()).code).toBe(0);
  });

  it('recovers after the breaker window: the next event reaches the server and reports the outage length', async () => {
    const t = await team('recover');
    const dead = `http://127.0.0.1:${await closedPort()}`;
    const eve = await t.agent('eve', 'claude', false, dead);
    for (let i = 0; i < 3; i++) await eve.preEdit('a.txt');
    const st = eve.state();
    expect(st.failures).toBe(3);

    // Time passes (the breaker stays open for 60 s) and the server is back.
    writeFileSync(sessionStatePath(eve.home, eve.session), JSON.stringify({ ...st, lastAttemptAt: Date.now() - LIMITS.breakerOpenMs - 1000, outageSince: Date.now() - 90_000 }));
    writeHookConfig(eve.home, { server: SERVER, room: t.room, person: 'eve', token: eve.token, repos: [t.repoId] });
    const back = await eve.fire('SessionStart');
    expect(back.code).toBe(0);
    expect(back.context).toContain('[Hivemind] You are claude-eve');
    expect(eve.state().failures).toBe(0);
    eve.callsign = eve.state().callsign;
    const you = (await eve.mcp('status')).value.you;
    expect(you.outageMs).toBeGreaterThan(60_000);

    // And the notice can be given again in a later outage.
    expect(eve.state().outageNotified).toBe(false);
  });

  it('gives up on a server that never answers within the hook budget, and allows the edit', async () => {
    const t = await team('slow');
    const frank = await t.agent('frank', 'codex', false, await silentServer());
    const r = await frank.preEdit('a.txt');
    expect(r.code).toBe(0);
    expect(r.denied).toBe(false);
    expect(r.ms).toBeLessThan(4500); // the tools kill a hook at 5 s
    expect(frank.state().failures).toBe(1);
  });

  it('treats a refused token as "not an outage" and allows the edit', async () => {
    const t = await team('refused');
    const gina = await t.agent('gina', 'claude', false);
    writeHookConfig(gina.home, { server: SERVER, room: t.room, person: 'gina', token: 'hm_a.test.nobody.1.AAAA', repos: [t.repoId] });
    const r = await gina.preEdit('a.txt');
    expect(r.code).toBe(0);
    expect(r.denied).toBe(false);
    expect(r.stdout).toBe('');
    expect(gina.state()?.failures ?? 0).toBe(0);
  });

  it('does nothing for broken input, a missing config, a paused laptop, or a folder that is not a Git repo', async () => {
    const t = await team('quiet');
    const hank = await t.agent('hank', 'claude', false);
    const none = makeTemp('hm-e2e-empty-');
    teams.push({ dispose: () => removeTemp(none) } as Team);

    // Broken JSON, and JSON that is not a hook payload.
    for (const stdin of ['{not json', '[]', '{"hook_event_name":"PreToolUse"}']) {
      const r = await runHook('claude', hank.home, stdin);
      expect(r.code).toBe(0);
      expect(r.stdout).toBe('');
    }
    // No config at all.
    const nothing = await runHook('claude', join(none, 'no-home'), hank.payload('SessionStart'));
    expect(nothing.code).toBe(0);
    expect(nothing.stdout).toBe('');
    // A server URL that is not https and not loopback is refused before any network call.
    mkdirSync(join(none, 'h2'), { recursive: true });
    writeHookConfig(join(none, 'h2'), { server: 'http://example.invalid', room: t.room, person: 'hank', token: hank.token, repos: [t.repoId] });
    expect((await runHook('claude', join(none, 'h2'), hank.payload('SessionStart'))).stdout).toBe('');
    // A folder that is not a repository.
    const outside = await runHook('claude', hank.home, hank.payload('PreToolUse.Edit', (p) => { p.cwd = none; p.tool_input.file_path = join(none, 'x.txt'); }));
    expect(outside.stdout).toBe('');
    // `hivemind off` creates this file; the hook then stays out of the way even though the server is up.
    const ok = await hank.fire('SessionStart');
    expect(ok.context).toContain('[Hivemind] You are claude-hank');
    writeFileSync(join(hank.home, 'off'), '');
    const paused = await hank.fire('UserPromptSubmit');
    expect(paused.stdout).toBe('');
    const stateAfter = JSON.parse(readFileSync(sessionStatePath(hank.home, hank.session), 'utf8'));
    expect(stateAfter.failures).toBe(0);
  });
});

// ------------------------------------------------------------------------------------------------ seeded states

describe('takeover and the budget guard', () => {
  let tk: Team;
  let ana: Agent;
  let nico: Agent;
  const budgets: Record<string, { team: Team; a: Agent; b: Agent }> = {};

  beforeAll(async () => {
    // --- takeover: ana holds a lock and a task; a different file is held by someone fresh.
    tk = await team('takeover');
    ana = await tk.agent('ana', 'claude');
    nico = await tk.agent('nico', 'codex');
    await ana.mcp('task_add', { tasks: [{ title: 'Own the app' }], claim: true });
    await ana.edit('a.txt', 'ana\n');
    await nico.edit('b.txt', 'nico\n');
    // A holder who is working cannot be taken from.
    const early = await ana.mcp('take', { path: 'b.txt', reason: 'I want it' });
    expect(early.value.ok).toBe(false);
    expect(early.value.error).toContain('not takeable');

    // --- budget: one room per threshold (the counter is per room).
    for (const level of ['b60', 'b80', 'b95', 'bnew']) {
      const bt = await team(level);
      budgets[level] = { team: bt, a: await bt.agent('ana', 'claude'), b: await bt.agent('nico', 'codex') };
      await budgets[level].a.edit('a.txt');
    }

    // Stop the server, change what a 20-minute silence and a busy day would have changed, start it again.
    await server.stop();
    const cap = LIMITS.dailyRequestCap;
    const twentyMinutesAgo = Date.now() - 20 * 60_000;
    seedRoom(persist, 'takeover', (db) => {
      db.prepare('UPDATE agents SET last_event = ? WHERE callsign = ?').run(twentyMinutesAgo, 'claude-ana');
    });
    const seedCount = (room: string, requests: number) => seedRoom(persist, room, (db) => {
      db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(`budget:${today()}`, String(requests));
    });
    seedCount('b60', Math.ceil(cap * LIMITS.guardSlowAt) - 1);
    seedCount('b80', Math.ceil(cap * LIMITS.guardSlowerAt) - 1);
    seedCount('b95', Math.ceil(cap * LIMITS.guardWarnAt) - 1);
    // The guard switched this room to warn yesterday; the first request of a new day puts it back.
    seedRoom(persist, 'bnew', (db) => {
      const put = db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)');
      put.run('mode', 'warn');
      put.run('mode_by_guard', 'enforce');
      put.run('guard_switch_date', '2000-01-01');
    });
    server = await startServer(persist);
  });

  it('lets an agent take over a quiet owner\'s task', async () => {
    const board = (await nico.mcp('status')).value.tasks as { id: number; owner: string }[];
    const task = board.find((x) => x.owner === 'claude-ana');
    expect(task).toBeDefined();
    const without = await nico.mcp('task_claim', { id: task!.id });
    expect(without.value.result).toBe('taken');
    expect(without.value.takeable).toBe(true);
    const took = await nico.mcp('task_claim', { id: task!.id, take: true, reason: 'ana is away' });
    expect(took.value.result).toBe('ok');
    expect(took.value.task.owner).toBe('codex-nico');
  });

  it('lets an agent take a lock from a holder who has been quiet for 15 minutes, and tells the holder', async () => {
    const blocked = await nico.preEdit('a.txt');
    expect(blocked.denied).toBe(true);
    expect(blocked.reason).toContain('claude-ana');
    expect(blocked.reason).toMatch(/quiet 20m\. You may `take` this file with a reason\./);

    expect((await nico.mcp('take', { path: 'a.txt', reason: '' })).isError).toBe(true);
    const took = await nico.mcp('take', { path: 'a.txt', reason: 'ana has been gone a while' });
    expect(took.value.ok).toBe(true);
    expect(took.value.lock.holder).toBe('codex-nico');

    expect((await nico.preEdit('a.txt')).denied).toBe(false);
    // The old holder is told, and is now the one who is blocked.
    const told = await ana.heartbeat();
    expect(told.context).toContain('codex-nico took your file lock on a.txt (reason: ana has been gone a while). Pull and reconcile');
    expect((await ana.preEdit('a.txt')).denied).toBe(true);
  });

  it('slows heartbeats at 60% of the daily budget', async () => {
    const { a } = budgets.b60!;
    const r = await a.heartbeat();
    expect(r.code).toBe(0);
    expect(a.state().heartbeatMs).toBe(LIMITS.guardSlowHeartbeatMs);
  });

  it('slows them more at 80%', async () => {
    const { a } = budgets.b80!;
    await a.heartbeat();
    expect(a.state().heartbeatMs).toBe(LIMITS.guardSlowerHeartbeatMs);
  });

  it('at 95% turns heartbeats off, switches the room to warn, and tells everyone', async () => {
    const { team: bt, a, b } = budgets.b95!;
    await a.heartbeat(); // crosses the line
    const again = await b.heartbeat();
    expect(a.state().heartbeatMs).toBe(0);
    expect(b.state().heartbeatMs).toBe(0);
    expect(again.context).toContain('Heartbeats are off and the room switched to warn mode');

    // Locks are only heads-up now (warn), and PostToolUse no longer calls the server at all.
    const warned = await b.preEdit('a.txt');
    expect(warned.denied).toBe(false);
    expect(warned.context).toContain('Heads-up: a.txt is held by claude-ana');
    const before = b.state().lastAttemptAt as number;
    const quiet = await b.postEdit('b.txt');
    expect(quiet.stdout).toBe('');
    expect(b.state().lastAttemptAt).toBe(before);

    const status = (await a.mcp('status')).value;
    expect(status.mode).toBe('warn');
    // A teammate setting the mode wins over the guard.
    await bt.mode(a, 'enforce');
    expect((await b.preEdit('a.txt')).denied).toBe(true);
  });

  it('restores the mode the guard changed when a new day starts', async () => {
    const { a, b } = budgets.bnew!;
    const first = await a.heartbeat();
    expect(first.code).toBe(0);
    expect((await a.mcp('status')).value.mode).toBe('enforce');
    expect((await b.heartbeat()).context).toContain('The daily request budget has reset. Room mode is back to enforce.');
    expect((await b.preEdit('a.txt')).denied).toBe(true);
  });
});
