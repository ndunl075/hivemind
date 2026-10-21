import { describe, expect, it } from 'vitest';
import { LIMITS, type Snapshot } from '../../../../shared/contracts';
import { createSnapshot } from './index';
import { agentToken, connectViewer, editBody, hook, inRoom, REPO, viewerToken } from '../../test-helpers';

const list = (v: unknown): unknown[] => {
  expect(Array.isArray(v)).toBe(true);
  return v as unknown[];
};

describe('snapshot', () => {
  it('matches the contract for a seeded room and pulses for messages, denials and pushes', async () => {
    const room = 'snap-seeded';
    const a = await agentToken(room, 'ana');
    const b = await agentToken(room, 'nico');
    await hook(a, 'sa', { event: 'SessionStart' });
    await hook(b, 'sb', { event: 'SessionStart' });
    const viewer = await connectViewer(room, await viewerToken(room));
    await viewer.next((m) => m.type === 'snapshot');

    // A held file, then a denial: a blocked edge and a denied pulse.
    expect((await hook(a, 'sa', editBody('src/auth/login.ts'))).decision).toBe('allow');
    expect((await hook(b, 'sb', editBody('src/auth/login.ts'))).decision).toBe('deny');
    expect(await viewer.next((m) => m.type === 'pulse' && m.kind === 'denied')).toMatchObject({ from: 'claude-nico', to: 'claude-ana' });

    // A push.
    await hook(a, 'sa', {
      event: 'PostToolUse',
      git: { divergent: [], upstream: 'origin/main', truncated: false, pushed: { branch: 'main', sha: 'abc1234', files: [{ path: 'src/auth/login.ts', blob: 'b1' }] } },
    });
    expect(await viewer.next((m) => m.type === 'pulse' && m.kind === 'push')).toMatchObject({ from: 'claude-ana', path: 'src/auth/login.ts' });

    // Messages are posted by the messages feature; here the room event stands in for an agent post.
    await inRoom(room, (r) => {
      const ctx = (r as unknown as { roomCtx: { emit(e: unknown): void } }).roomCtx;
      ctx.emit({ type: 'message', actor: 'claude-ana', text: 'claude-ana -> claude-nico: hi', pulse: { kind: 'message', from: 'claude-ana', to: 'claude-nico' } });
      ctx.emit({ type: 'message', actor: 'claude-nico', text: 'claude-nico -> everyone: hello', pulse: { kind: 'broadcast', from: 'claude-nico' } });
    });
    expect(await viewer.next((m) => m.type === 'pulse' && m.kind === 'message')).toMatchObject({ from: 'claude-ana', to: 'claude-nico' });
    expect(await viewer.next((m) => m.type === 'pulse' && m.kind === 'broadcast')).toMatchObject({ from: 'claude-nico' });

    const snap = (await viewer.next((m) => m.type === 'snapshot' && list(m.edges).some((e) => (e as { kind: string }).kind === 'broadcast'))) as unknown as Snapshot;
    viewer.socket.close();

    expect(snap).toMatchObject({ type: 'snapshot', room, mode: 'enforce' });
    expect(snap.usage.cap).toBe(LIMITS.dailyRequestCap);
    expect(snap.usage.requests).toBeGreaterThan(0); // supplied by the Room from its request counter
    expect(typeof snap.now).toBe('number');
    expect(snap.agents.map((x) => x.callsign).sort()).toEqual(['claude-ana', 'claude-nico']);
    expect(snap.locks.map((l) => l.path)).toEqual(['src/auth/login.ts']);
    expect(snap.tasks).toEqual([]);
    expect(snap.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'blocked', from: 'claude-nico', to: 'claude-ana', label: 'login.ts' }),
      expect.objectContaining({ kind: 'message', from: 'claude-ana', to: 'claude-nico' }),
      expect.objectContaining({ kind: 'broadcast', from: 'claude-nico' }),
    ]));
    for (const e of snap.edges) {
      expect(['message', 'broadcast', 'blocked', 'waiting', 'nearby']).toContain(e.kind);
      expect(typeof e.from).toBe('string');
      expect(typeof e.at).toBe('number');
    }
    const types = snap.activity.map((x) => x.type);
    expect(types).toEqual(expect.arrayContaining(['agent.joined', 'lock.denied', 'push', 'message']));
    for (const x of snap.activity) {
      expect(x).toEqual({ seq: expect.any(Number), ts: expect.any(Number), type: expect.any(String), actor: x.actor === null ? null : expect.any(String), text: expect.any(String) });
    }
    // Newest first.
    expect(snap.activity.map((x) => x.seq)).toEqual([...snap.activity.map((x) => x.seq)].sort((p, q) => q - p));
  });

  it('expires message edges while keeping the activity line', async () => {
    const room = 'snap-edges';
    const base = Date.now();
    const snap = await inRoom(room, (r) => {
      const ctx = (r as unknown as { roomCtx: { emit(e: unknown): void } }).roomCtx;
      ctx.emit({ type: 'message', actor: 'x', text: 'm', pulse: { kind: 'message', from: 'x', to: 'y' } });
      return r.features.snapshot.build();
    });
    expect(snap.edges.some((e) => e.kind === 'message')).toBe(true);
    // Rewind the stored event past the message window: the edge is gone, the activity line stays.
    const later = await inRoom(room, (r, state) => {
      state.storage.sql.exec('UPDATE events SET ts = ?', base - LIMITS.messageEdgeMs - 1_000).toArray();
      return r.features.snapshot.build();
    });
    expect(later.edges.some((e) => e.kind === 'message')).toBe(false);
    expect(later.activity).toHaveLength(1);
  });

  it('keeps an edge inside its window however many newer events there are', async () => {
    const room = 'snap-many';
    const snap = await inRoom(room, (r) => {
      const ctx = (r as unknown as { roomCtx: { emit(e: unknown): void } }).roomCtx;
      ctx.emit({ type: 'message', actor: 'x', text: 'm', pulse: { kind: 'message', from: 'x', to: 'y' } });
      for (let i = 0; i < 300; i++) ctx.emit({ type: 'note', actor: null, text: `n${i}` });
      return r.features.snapshot.build();
    });
    expect(snap.edges).toEqual([expect.objectContaining({ kind: 'message', from: 'x', to: 'y' })]);
  });

  it('truncates long activity text and caps finished tasks', () => {
    const rows = [{ seq: 1, ts: 1, type: 'n', actor: null, data: JSON.stringify({ text: 'z'.repeat(500) }) }];
    const mk = (id: number, status: string) => ({ id, title: 't', description: null, status, owner: null, createdBy: 'x', dependsOn: [], areas: [], note: null, createdAt: 0, updatedAt: id });
    const tasks = [mk(1000, 'open'), ...Array.from({ length: 80 }, (_, i) => mk(i + 1, 'done'))];
    const ctx = { now: () => 1000, mode: () => 'enforce', agents: () => [], sql: { exec: (q: string) => ({ toArray: () => (q.includes('LIKE') ? [] : rows) }) } };
    const features = { tasks: { list: () => tasks, inProgressFor: () => null }, locks: { list: () => [] } };
    const snap = createSnapshot(ctx as never, features as never).build();
    expect(snap.activity[0]?.text).toHaveLength(200);
    expect(snap.tasks.filter((t) => t.status === 'done')).toHaveLength(50);
    expect(snap.tasks.some((t) => t.id === 1000)).toBe(true);
  });

  it('caps locks at 300', () => {
    const locks = Array.from({ length: 350 }, (_, i) => ({ repo: REPO, path: `f${i}.ts`, kind: 'file', holder: `h${i}`, checkout: 'c', taskId: null, reason: null, acquiredAt: 0 }));
    const ctx = { now: () => 1000, mode: () => 'enforce', agents: () => [], sql: { exec: () => ({ toArray: () => [] }) } };
    const features = { tasks: { list: () => [], inProgressFor: () => null }, locks: { list: () => locks } };
    const snap = createSnapshot(ctx as never, features as never).build();
    expect(snap.locks).toHaveLength(300);
  });

  it('keeps blocked edges with different labels and ignores waiting and nearby kinds from events', () => {
    const row = (seq: number, edge: unknown) => ({ ts: 900, data: JSON.stringify({ text: 't', edge }) });
    const rows = [
      row(4, { kind: 'blocked', from: 'a', to: 'b', label: 'one.ts' }),
      row(3, { kind: 'blocked', from: 'a', to: 'b', label: 'two.ts' }),
      row(2, { kind: 'blocked', from: 'a', to: 'b', label: 'one.ts' }),
      row(1, { kind: 'waiting', from: 'a', to: 'b' }),
      row(0, { kind: 'nearby', from: 'a', to: 'b' }),
    ];
    const ctx = { now: () => 1000, mode: () => 'enforce', agents: () => [], sql: { exec: (q: string) => ({ toArray: () => (q.includes('LIKE') ? rows : []) }) } };
    const features = { tasks: { list: () => [], inProgressFor: () => null }, locks: { list: () => [] } };
    const snap = createSnapshot(ctx as never, features as never).build();
    expect(snap.edges.map((e) => `${e.kind}:${e.label}`)).toEqual(['blocked:one.ts', 'blocked:two.ts']);
  });

  it('caps the activity feed', async () => {
    const room = 'snap-cap';
    const snap = await inRoom(room, (r) => {
      const ctx = (r as unknown as { roomCtx: { emit(e: unknown): void } }).roomCtx;
      for (let i = 0; i < 80; i++) ctx.emit({ type: 'note', actor: null, text: `n${i}` });
      return r.features.snapshot.build();
    });
    expect(snap.activity).toHaveLength(50);
    expect(snap.activity[0]?.text).toBe('n79');
  });
});

describe('derived edges', () => {
  it('draws waiting from the blocker to the waiter, and nearby once per pair of holders in one folder', () => {
    const task = (id: number, owner: string | null, dependsOn: number[], status = 'in_progress') =>
      ({ id, title: `t${id}`, description: null, status, owner, createdBy: 'x', dependsOn, areas: [], note: null, createdAt: 0, updatedAt: 0 });
    const lock = (holder: string, path: string) =>
      ({ repo: REPO, path, kind: path.endsWith('/') ? 'folder' : 'file', holder, checkout: 'c', taskId: null, reason: null, acquiredAt: 0 });
    const ctx = { now: () => 1000, mode: () => 'enforce', agents: () => [], sql: { exec: () => ({ toArray: () => [] }) } };
    const features = {
      tasks: { list: () => [task(4, 'codex-ana', []), task(7, 'claude-nico', [4]), task(8, null, [4], 'open')], inProgressFor: () => null },
      locks: { list: () => [lock('codex-ana', 'src/auth/'), lock('claude-nico', 'src/auth/x.ts'), lock('claude-nico', 'src/auth/y.ts'), lock('codex-sam', 'infra/a.toml')] },
    };
    const snap = createSnapshot(ctx as never, features as never).build();
    expect(snap.edges).toEqual([
      { kind: 'waiting', from: 'codex-ana', to: 'claude-nico', at: 1000 },
      { kind: 'nearby', from: 'claude-nico', to: 'codex-ana', at: 1000 },
    ]);
  });
});
