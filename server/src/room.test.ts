import { evictDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LIMITS, type Actor } from '../../shared/contracts';
import {
  agentToken, connectViewer, editBody, get, hook, inRoom, post, REPO, roomStub, viewerToken,
} from './test-helpers';

afterEach(() => {
  vi.useRealTimers();
});

const actor = (callsign: string, person = 'x'): Actor => ({ callsign, person, kind: 'claude', repo: REPO, checkout: 'checkout-1' });

type Meta = { meta: Map<string, string> };

describe('locks through /hook', () => {
  it('100 concurrent edit checks on one path leave exactly one holder', async () => {
    const room = 'conc';
    const people = Array.from({ length: 50 }, (_, i) => `p${i}`);
    const tokens = await Promise.all(people.map((p) => agentToken(room, p)));
    await Promise.all(people.map((p, i) => hook(tokens[i] as string, `s-${p}`, { event: 'SessionStart' })));
    const results = await Promise.all(
      people.flatMap((p, i) => [0, 1].map(() => hook(tokens[i] as string, `s-${p}`, editBody('src/shared.ts')))),
    );
    expect(results).toHaveLength(100);
    const allowedBy = new Set(results.filter((r) => r.decision === 'allow').map((r) => r.callsign));
    expect(allowedBy.size).toBe(1);
    expect(results.filter((r) => r.decision === 'deny')).toHaveLength(98);
    const locks = await inRoom(room, (r) => r.features.locks.list());
    expect(locks).toHaveLength(1);
    expect(locks[0]?.holder).toBe([...allowedBy][0]);
  });

  it('denies with the §9 text and delivers the holder name', async () => {
    const room = 'deny';
    const a = await agentToken(room, 'ana');
    const b = await agentToken(room, 'nico');
    await hook(a, 'sa', { event: 'SessionStart' });
    await hook(b, 'sb', { event: 'SessionStart' });
    expect((await hook(a, 'sa', editBody('src/auth/login.ts'))).decision).toBe('allow');
    const denied = await hook(b, 'sb', editBody('SRC/auth/Login.ts'));
    expect(denied.decision).toBe('deny');
    expect(denied.reason).toContain('SRC/auth/Login.ts is held by claude-ana');
    expect(denied.reason).toContain('`wait` with for: "release:src/auth/login.ts"');
  });

  it('a multi-file edit is all or nothing', async () => {
    const room = 'allornothing';
    const a = await agentToken(room, 'ana');
    const b = await agentToken(room, 'nico');
    await hook(a, 'sa', editBody('one.ts'));
    const res = await hook(b, 'sb', { event: 'PreToolUse', tool: 'apply_patch', agent: 'codex', paths: ['free.ts', 'one.ts'] });
    expect(res.decision).toBe('deny');
    const locks = await inRoom(room, (r) => r.features.locks.list());
    expect(locks.map((l) => l.path)).toEqual(['one.ts']);
  });

  it('releases a lock when the divergent list drops the file, never on a truncated list', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.parse('2026-10-21T10:00:00Z'));
    const room = 'diverge';
    const a = await agentToken(room, 'ana');
    await hook(a, 'sa', editBody('x.ts'));
    await hook(a, 'sa', editBody('y.ts'));
    const held = () => inRoom(room, (r) => r.features.locks.list().map((l) => l.path).sort());
    expect(await held()).toEqual(['x.ts', 'y.ts']);
    vi.setSystemTime(Date.parse('2026-10-21T10:00:20Z')); // past the heartbeat grace for new locks
    // Truncated: nothing is released, even though x.ts is missing.
    await hook(a, 'sa', { git: { divergent: ['y.ts'], upstream: 'origin/main', truncated: true, pushed: null } });
    expect(await held()).toEqual(['x.ts', 'y.ts']);
    // Complete list without x.ts: x.ts is released.
    await hook(a, 'sa', { git: { divergent: ['Y.ts'], upstream: 'origin/main', truncated: false, pushed: null } });
    expect(await held()).toEqual(['y.ts']);
    // The release wakes waiters and the file is free for others.
    const b = await agentToken(room, 'nico');
    expect((await hook(b, 'sb', editBody('x.ts'))).decision).toBe('allow');
  });

  it('folder reservations conflict with files and folders in both directions', async () => {
    const room = 'folders';
    await hook(await agentToken(room, 'ana'), 'sa', { event: 'SessionStart' });
    await hook(await agentToken(room, 'nico'), 'sb', { event: 'SessionStart' });
    const r = await inRoom(room, (inst) => {
      const locks = inst.features.locks;
      const ana = actor('claude-ana', 'ana');
      const nico = actor('claude-nico', 'nico');
      const first = locks.reserve(ana, [{ repo: REPO, folder: 'src/auth' }], 'login work', null);
      const file = locks.checkEdit(nico, REPO, ['src/auth/login.ts']);
      const parent = locks.reserve(nico, [{ repo: REPO, folder: 'src/' }], null, null);
      const child = locks.reserve(nico, [{ repo: REPO, folder: 'src/auth/deep/' }], null, null);
      const other = locks.reserve(nico, [{ repo: REPO, folder: 'docs/' }], null, null);
      const own = locks.checkEdit(ana, REPO, ['src/auth/login.ts']);
      const stolen = locks.take(nico, REPO, 'src/auth/', 'need it');
      locks.release(ana, [{ repo: REPO, path: 'src/auth/' }]);
      return { first, file, parent, child, other, own, stolen, after: locks.checkEdit(nico, REPO, ['src/auth/login.ts']).allow };
    });
    expect(r.first.granted).toBe(true);
    expect(r.file.allow).toBe(false);
    expect(r.file.conflicts[0]).toMatchObject({ holder: 'claude-ana', kind: 'folder', path: 'src/auth/' });
    expect(r.parent.granted).toBe(false);
    expect(r.child.granted).toBe(false);
    expect(r.other.granted).toBe(true);
    expect(r.own.allow).toBe(true);
    expect(r.stolen).toEqual({ ok: false, error: expect.stringContaining('not takeable') });
    expect(r.after).toBe(false); // rule 1: ana's edit under her own reservation took a file lock too
  });

  it('reserving is all or nothing', async () => {
    const room = 'reserve-all';
    await hook(await agentToken(room, 'ana'), 'sa', { event: 'SessionStart' });
    await hook(await agentToken(room, 'nico'), 'sb', { event: 'SessionStart' });
    const r = await inRoom(room, (inst) => {
      const locks = inst.features.locks;
      locks.reserve(actor('claude-ana', 'ana'), [{ repo: REPO, folder: 'b/' }], null, null);
      const res = locks.reserve(actor('claude-nico', 'nico'), [{ repo: REPO, folder: 'a/' }, { repo: REPO, folder: 'b/' }], null, null);
      return { res, held: locks.holdings('claude-nico') };
    });
    expect(r.res.granted).toBe(false);
    expect(r.held).toEqual([]);
  });

  it('lets a takeable holder be taken from, and loses locks of ended holders', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.parse('2026-10-21T10:00:00Z'));
    const room = 'takeover';
    const a = await agentToken(room, 'ana');
    const b = await agentToken(room, 'nico');
    await hook(a, 'sa', { event: 'SessionStart' });
    await hook(b, 'sb', { event: 'SessionStart' });
    await hook(a, 'sa', editBody('f.ts'));
    await hook(a, 'sa', { event: 'Stop' });

    vi.setSystemTime(Date.parse('2026-10-21T10:10:00Z'));
    const early = await hook(b, 'sb', editBody('f.ts'));
    expect(early.decision).toBe('deny');
    expect(early.reason).toContain('`wait`');
    const tooSoon = await inRoom(room, (r) => r.features.locks.take(actor('claude-nico', 'nico'), REPO, 'f.ts', 'x'));
    expect(tooSoon.ok).toBe(false);

    vi.setSystemTime(Date.parse('2026-10-21T10:20:00Z'));
    const late = await hook(b, 'sb', editBody('f.ts'));
    expect(late.reason).toContain('claude-ana has been idle 20m. You may `take` this file with a reason.');
    const taken = await inRoom(room, (r) => r.features.locks.take(actor('claude-nico', 'nico'), REPO, 'f.ts', 'urgent fix'));
    expect(taken).toEqual({ ok: true });
    const lock = (await inRoom(room, (r) => r.features.locks.list()))[0];
    expect(lock).toMatchObject({ holder: 'claude-nico', reason: 'urgent fix' });
    // The former holder is told on its next event.
    const notice = await hook(a, 'sa', { event: 'PostToolUse' });
    expect(notice.context).toContain('claude-nico took your file lock on f.ts');
    expect(notice.context).toContain('Pull and reconcile');

    // Ended holders lose everything (rule 8): nico goes silent for 12 hours.
    vi.setSystemTime(Date.parse('2026-10-22T00:00:00Z') + 0);
    const c = await agentToken(room, 'sam');
    const res = await hook(c, 'sc', editBody('f.ts'));
    expect(res.decision).toBe('allow');
    const holders = (await inRoom(room, (r) => r.features.locks.list())).map((l) => l.holder);
    expect(holders).toEqual(['claude-sam']);
  });

  it('a SessionEnd with an exit reason releases everything; clear and resume do not', async () => {
    const room = 'ending';
    const a = await agentToken(room, 'ana');
    await hook(a, 'sa', editBody('f.ts'));
    await hook(a, 'sa', { event: 'SessionEnd', endReason: 'clear' });
    expect(await inRoom(room, (r) => r.features.locks.list().length)).toBe(1);
    await hook(a, 'sa', { event: 'SessionEnd', endReason: 'prompt_input_exit' });
    expect(await inRoom(room, (r) => r.features.locks.list().length)).toBe(0);
    // A resumed session gets its callsign back.
    const back = await hook(a, 'sa', { event: 'SessionStart' });
    expect(back.callsign).toBe('claude-ana');
  });

  it('assigns numbered callsigns and reuses the numbers of ended agents', async () => {
    const room = 'callsigns';
    const a = await agentToken(room, 'ana');
    expect((await hook(a, 's1', { event: 'SessionStart' })).callsign).toBe('claude-ana');
    expect((await hook(a, 's2', { event: 'SessionStart' })).callsign).toBe('claude-ana-2');
    expect((await hook(a, 's3', { event: 'SessionStart', agent: 'codex' })).callsign).toBe('codex-ana');
    await hook(a, 's1', { event: 'SessionEnd', endReason: 'logout' });
    expect((await hook(a, 's4', { event: 'SessionStart' })).callsign).toBe('claude-ana');
  });

  it('modes: warn turns denials into heads-ups, off skips checks, and a team-set mode is announced', async () => {
    const room = 'modes';
    const a = await agentToken(room, 'ana');
    const b = await agentToken(room, 'nico');
    await hook(a, 'sa', editBody('f.ts'));
    expect((await hook(b, 'sb', editBody('f.ts'))).decision).toBe('deny');
    const warn = await post('/mode', b, { mode: 'warn' });
    expect(await warn.json()).toEqual({ mode: 'warn' });
    const proceed = await hook(b, 'sb', editBody('f.ts'));
    expect(proceed.decision).toBe('allow');
    expect(proceed.mode).toBe('warn');
    expect(proceed.context).toContain('Heads-up');
    await post('/mode', b, { mode: 'off' });
    const off = await hook(b, 'sb', editBody('g.ts'));
    expect(off.decision).toBe('allow');
    expect(off.context).toBeNull();
    expect(await inRoom(room, (r) => r.features.locks.list().map((l) => l.path))).toEqual(['f.ts']);
    // Announced to every agent.
    const note = await hook(a, 'sa', { event: 'PostToolUse' });
    expect(note.context).toContain('Room mode is now off (set by nico)');
    expect((await post('/mode', b, { mode: 'loud' })).status).toBe(400);
  });

  it('emergency unlock releases a path or an agent and announces it', async () => {
    const room = 'unlock';
    const a = await agentToken(room, 'ana');
    const b = await agentToken(room, 'nico');
    await hook(a, 'sa', editBody('x.ts'));
    await hook(a, 'sa', editBody('y.ts'));
    await hook(b, 'sb', { event: 'SessionStart' });
    const byPath = await (await post('/unlock', b, { path: { repo: REPO, path: 'x.ts' } })).json() as { released: unknown[] };
    expect(byPath.released).toHaveLength(1);
    const byAgent = await (await post('/unlock', b, { agent: 'claude-ana' })).json() as { released: unknown[] };
    expect(byAgent.released).toHaveLength(1);
    expect((await post('/unlock', b, { agent: 'x', path: { repo: REPO, path: 'y' } })).status).toBe(400);
    const note = await hook(a, 'sa', { event: 'PostToolUse' });
    expect(note.context).toContain('Emergency unlock by nico');
  });
});

describe('messages and the briefing', () => {
  it('SessionStart returns the briefing; notices arrive on heartbeats; direct notices block Stop once', async () => {
    const room = 'brief';
    const a = await agentToken(room, 'ana');
    const b = await agentToken(room, 'nico');
    const start = await hook(a, 'sa', { event: 'SessionStart', repoName: 'demo' });
    expect(start.decision).toBe('none');
    expect(start.context).toContain('[Hivemind] You are claude-ana. Room "brief", mode: enforce. 0 other agents.');
    expect(start.heartbeatMs).toBe(LIMITS.heartbeatMs);
    const second = await hook(b, 'sb', { event: 'SessionStart' });
    expect(second.context).toContain('1 other agent.');
    expect(second.context).toContain('claude-ana');

    await inRoom(room, (r) => r.features.messages.notify('claude-ana', 'Hello there'));
    const beat = await hook(a, 'sa', { event: 'PostToolUse' });
    expect(beat.context).toContain('[Hivemind] notice');
    expect(beat.context).toContain('> Hello there');
    expect((await hook(a, 'sa', { event: 'PostToolUse' })).context).toBeNull();

    await inRoom(room, (r) => r.features.messages.notify('claude-ana', 'Second'));
    const stop = await hook(a, 'sa', { event: 'Stop' });
    expect(stop.decision).toBe('block');
    expect(stop.reason).toContain('> Second');
    expect((await hook(a, 'sa', { event: 'Stop' })).decision).toBe('none');
    await inRoom(room, (r) => r.features.messages.notify('claude-ana', 'Third'));
    expect((await hook(a, 'sa', { event: 'Stop', stopActive: true })).decision).toBe('none');
  });

  it('broadcast notices skip excluded agents and other repos', async () => {
    const room = 'bcast';
    const a = await agentToken(room, 'ana');
    const b = await agentToken(room, 'nico');
    const c = await agentToken(room, 'sam');
    await hook(a, 'sa', { event: 'SessionStart' });
    await hook(b, 'sb', { event: 'SessionStart' });
    await hook(c, 'sc', { event: 'SessionStart', repo: 'b'.repeat(40) });
    await inRoom(room, (r) => r.features.messages.notify('*', 'pushed', { repo: REPO, exclude: ['claude-ana'] }));
    expect((await hook(a, 'sa', {})).context).toBeNull();
    expect((await hook(b, 'sb', {})).context).toContain('pushed');
    expect((await hook(c, 'sc', { repo: 'b'.repeat(40) })).context).toBeNull();
  });
});

describe('pushes', () => {
  it('records the latest push per file and answers lastPush for other agents', async () => {
    const room = 'pushes';
    const a = await agentToken(room, 'ana');
    const b = await agentToken(room, 'nico');
    await hook(a, 'sa', {
      git: { divergent: [], upstream: 'origin/main', truncated: false, pushed: { branch: 'main', sha: 'c1', files: [{ path: 'src/a.ts', blob: 'b1' }] } },
    });
    await hook(a, 'sa', {
      git: { divergent: [], upstream: 'origin/main', truncated: false, pushed: { branch: 'main', sha: 'c2', files: [{ path: 'src/A.ts', blob: 'b2' }] } },
    });
    const res = await hook(b, 'sb', editBody('src/a.ts'));
    expect(res.lastPush).toEqual([{ path: 'src/A.ts', sha: 'c2', blob: 'b2', by: 'claude-ana', branch: 'main', at: expect.any(Number) }]);
    expect((await hook(a, 'sa', editBody('src/a.ts'))).lastPush).toBeUndefined();
  });
});

describe('per-repo settings', () => {
  it('stores settings received on /hook in meta and reads them through the context', async () => {
    const room = 'settings';
    const a = await agentToken(room, 'ana');
    await hook(a, 'sa', { event: 'SessionStart', settings: { requireTask: false, advisory: ['x.lock'], ignore: ['dist/**'] } });
    const r = await inRoom(room, (inst, state) => ({
      stored: state.storage.sql.exec('SELECT value FROM meta WHERE key = ?', `settings:${REPO}`).toArray()[0]?.value,
      resolved: (inst as unknown as { roomCtx: { settings(r: string | null): unknown } }).roomCtx.settings(REPO),
      other: (inst as unknown as { roomCtx: { settings(r: string | null): unknown } }).roomCtx.settings('c'.repeat(40)),
    }));
    expect(JSON.parse(r.stored as string)).toEqual({ requireTask: false, advisory: ['x.lock'], ignore: ['dist/**'] });
    expect(r.resolved).toEqual({ requireTask: false, advisory: ['x.lock'], ignore: ['dist/**'] });
    expect(r.other).toMatchObject({ requireTask: true });
    // They survive a restart.
    await evictDurableObject(roomStub(room));
    const again = await inRoom(room, (inst) => (inst as unknown as { roomCtx: { settings(r: string): unknown } }).roomCtx.settings(REPO));
    expect(again).toMatchObject({ requireTask: false });
  });
});

describe('persistence', () => {
  it('state survives a Room restart', async () => {
    const room = 'restart';
    const a = await agentToken(room, 'ana');
    await hook(a, 'sa', { event: 'SessionStart' });
    await hook(a, 'sa', editBody('keep.ts'));
    await hook(a, 'sa', { event: 'Stop' });
    await inRoom(room, (r) => r.features.locks.reserve(actor('claude-ana', 'ana'), [{ repo: REPO, folder: 'docs/' }], 'writing', null));
    await (await post('/mode', a, { mode: 'warn' })).text(); // unread bodies keep a request in flight and stall eviction
    await evictDurableObject(roomStub(room));
    const after = await inRoom(room, (r) => ({
      locks: r.features.locks.list().map((l) => `${l.kind}:${l.path}:${l.holder}`),
      agents: r.agents.all().map((x) => ({ cs: x.callsign, idle: x.idleSince !== null })),
      mode: r.mode(),
    }));
    expect(after.locks).toEqual(['file:keep.ts:claude-ana', 'folder:docs/:claude-ana']);
    expect(after.agents).toEqual([{ cs: 'claude-ana', idle: true }]);
    expect(after.mode).toBe('warn');
    // The same session continues with the same callsign, and the lock still blocks others.
    expect((await hook(a, 'sa', editBody('keep.ts'))).callsign).toBe('claude-ana');
    expect((await hook(await agentToken(room, 'nico'), 'sb', editBody('keep.ts'))).context).toContain('Heads-up');
  });
});

describe('wait registry', () => {
  it('resolves on notify() and times out at 45 s', async () => {
    const room = 'waits';
    await hook(await agentToken(room, 'ana'), 'sa', { event: 'SessionStart' });
    const woke = await inRoom(room, async (r) => {
      const p = r.waits.park('claude-ana', ['message:claude-ana'], 45);
      r.features.messages.notify('claude-ana', 'wake up');
      return p;
    });
    expect(woke).toEqual({ event: 'message', key: 'message:claude-ana' });

    const timeline = await inRoom(room, async (r) => {
      vi.useFakeTimers();
      try {
        let settled: unknown = null;
        const p = r.waits.park('claude-ana', ['message:claude-ana'], 500).then((x) => { settled = x; });
        await vi.advanceTimersByTimeAsync(44_999);
        const before = settled;
        await vi.advanceTimersByTimeAsync(1);
        await p;
        return { before, after: settled };
      } finally {
        vi.useRealTimers();
      }
    });
    expect(timeline).toEqual({ before: null, after: { event: 'timeout' } });
  });

  it('a lock release wakes a waiter on that path', async () => {
    const room = 'wait-release';
    const a = await agentToken(room, 'ana');
    await hook(a, 'sa', editBody('w.ts'));
    const res = await inRoom(room, async (r) => {
      const p = r.waits.park('claude-nico', [`release:${REPO}:w.ts`], 45);
      r.features.locks.releaseAll('claude-ana');
      return p;
    });
    expect(res).toEqual({ event: 'release', key: `release:${REPO}:w.ts` });
  });
});

describe('budget guard', () => {
  const T0 = Date.parse('2026-10-21T12:00:00Z');

  it('raises the heartbeat interval at 60% and 80%', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
    const room = 'guard-steps';
    const a = await agentToken(room, 'ana');
    expect((await hook(a, 'sa', {})).heartbeatMs).toBe(15_000);
    await inRoom(room, (r) => { r.budget.requests = 59_990; });
    expect((await hook(a, 'sa', {})).heartbeatMs).toBe(15_000);
    await inRoom(room, (r) => { r.budget.requests = 59_999; });
    expect((await hook(a, 'sa', {})).heartbeatMs).toBe(30_000);
    await inRoom(room, (r) => { r.budget.requests = 79_999; });
    expect((await hook(a, 'sa', {})).heartbeatMs).toBe(60_000);
    expect((await hook(a, 'sa', {})).mode).toBe('enforce');
  });

  it('switches to warn at 95%, turns heartbeats off, and restores after 00:00 UTC', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
    const room = 'guard-warn';
    const a = await agentToken(room, 'ana');
    const b = await agentToken(room, 'nico');
    await hook(a, 'sa', editBody('f.ts'));
    await hook(b, 'sb', {});
    await inRoom(room, (r) => { r.budget.requests = 94_998; });
    const before = await hook(a, 'sa', {});
    expect(before.heartbeatMs).toBe(60_000);
    expect(before.mode).toBe('enforce');
    const crossed = await hook(a, 'sa', {});
    expect(crossed.heartbeatMs).toBe(0);
    expect(crossed.mode).toBe('warn');
    expect(await inRoom(room, (r) => (r as unknown as Meta).meta.get('mode_by_guard'))).toBe('enforce');
    // Announced to every agent, and denials are now heads-up.
    expect((await hook(b, 'sb', {})).context).toContain('daily request budget');
    expect((await hook(b, 'sb', editBody('f.ts'))).decision).toBe('allow');

    // Next UTC day: the counter resets and the mode comes back.
    vi.setSystemTime(Date.parse('2026-10-22T00:00:05Z'));
    const next = await hook(a, 'sa', {});
    expect(next.mode).toBe('enforce');
    expect(next.heartbeatMs).toBe(15_000);
    expect(await inRoom(room, (r) => (r as unknown as Meta).meta.has('mode_by_guard'))).toBe(false);
    expect(next.context).toContain('Room mode is back to enforce');
  });

  it('a team-set mode clears mode_by_guard and is not restored at midnight', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
    const room = 'guard-team';
    const a = await agentToken(room, 'ana');
    await hook(a, 'sa', {});
    await inRoom(room, (r) => { r.budget.requests = 95_000; });
    expect((await hook(a, 'sa', {})).mode).toBe('warn');
    expect(await inRoom(room, (r) => (r as unknown as Meta).meta.has('mode_by_guard'))).toBe(true);
    expect((await (await post('/mode', a, { mode: 'off' })).json())).toEqual({ mode: 'off' });
    expect(await inRoom(room, (r) => (r as unknown as Meta).meta.has('mode_by_guard'))).toBe(false);
    // The guard does not fight the team on the same day...
    expect((await hook(a, 'sa', {})).mode).toBe('off');
    // ...and nothing is restored the next day.
    vi.setSystemTime(Date.parse('2026-10-22T00:00:05Z'));
    expect((await hook(a, 'sa', {})).mode).toBe('off');
  });

  it('flushes the counter and reloads it after a restart', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
    const room = 'guard-flush';
    const a = await agentToken(room, 'ana');
    await hook(a, 'sa', {});
    await inRoom(room, (r) => { r.budget.requests = 1000; });
    vi.setSystemTime(T0 + 61_000);
    await hook(a, 'sa', {});
    await evictDurableObject(roomStub(room));
    expect(await inRoom(room, (r) => r.budget.requests)).toBe(1001);
  });
});

describe('dashboard socket', () => {
  it('sends a snapshot on connect and after a change, and pulses for denials', async () => {
    const room = 'dash';
    const a = await agentToken(room, 'ana');
    const b = await agentToken(room, 'nico');
    await hook(a, 'sa', { event: 'SessionStart' });
    const viewer = await connectViewer(room, await viewerToken(room));
    const first = await viewer.next((m) => m.type === 'snapshot');
    expect(first).toMatchObject({ type: 'snapshot', room: 'dash', mode: 'enforce' });
    expect((first.agents as unknown[]).length).toBe(1);

    await hook(b, 'sb', { event: 'SessionStart' });
    const changed = await viewer.next((m) => m.type === 'snapshot' && (m.agents as unknown[]).length === 2);
    expect((changed.usage as { cap: number }).cap).toBe(LIMITS.dailyRequestCap);

    await hook(a, 'sa', editBody('p.ts'));
    await hook(b, 'sb', editBody('p.ts'));
    const pulse = await viewer.next((m) => m.type === 'pulse');
    expect(pulse).toMatchObject({ type: 'pulse', kind: 'denied', from: 'claude-nico', to: 'claude-ana', path: 'p.ts' });
    const withLock = await viewer.next((m) => m.type === 'snapshot' && (m.locks as unknown[]).length === 1);
    expect(withLock).toBeTruthy();
    viewer.socket.close();
  });

  it('closes viewers when the viewer token is rotated', async () => {
    const room = 'dash-rotate';
    const viewer = await connectViewer(room, await viewerToken(room));
    await viewer.next((m) => m.type === 'snapshot');
    const closed = new Promise<number>((resolve) => viewer.socket.addEventListener('close', (e) => resolve(e.code)));
    const res = await get('/whoami', await agentToken(room, 'ana'));
    expect(res.status).toBe(200);
    await inRoom(room, async (r) => {
      await r.fetch(new Request('https://room.internal/admin/revoke', {
        method: 'POST', headers: { 'x-hm-claims': JSON.stringify({ kind: 'admin', room }) }, body: JSON.stringify({ rotate: 'viewer' }),
      }));
    });
    expect(await closed).toBe(1008);
  });
});
