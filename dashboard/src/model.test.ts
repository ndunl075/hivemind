import { describe, expect, it } from 'vitest';
import fixture from '../../shared/fixtures/snapshot.json';
import { LIMITS, type Snapshot } from '../../shared/contracts';
import { buildViewModel, showReconnectBanner, stateLabel } from './model';

const snap = fixture as unknown as Snapshot;
const now = snap.now;
const vm = buildViewModel(snap, now);
const agent = (name: string) => vm.agents.find((a) => a.callsign === name)!;

describe('agent state display', () => {
  it('shows each fixture agent in its state, using shared/state.ts', () => {
    expect(agent('claude-nico').state).toBe('working');
    expect(agent('claude-nico').stateLabel).toBe('4s ago');
    expect(agent('codex-ana').stateLabel).toBe('12s ago');
    expect(agent('claude-nico-2').state).toBe('idle');
    expect(agent('claude-nico-2').stateLabel).toBe('idle · 3m');
    expect(agent('codex-sam').state).toBe('quiet');
    expect(agent('codex-sam').stateLabel).toBe('quiet 14m');
    expect(agent('claude-sam').state).toBe('idle');
    expect(agent('claude-sam').takeable).toBe(true);
    expect(agent('claude-nico-2').takeable).toBe(false);
  });

  it('labels every state', () => {
    expect(stateLabel('working', 4000)).toBe('4s ago');
    expect(stateLabel('quiet', 14 * 60_000)).toBe('quiet 14m');
    expect(stateLabel('idle', 60_000)).toBe('idle · 1m');
    expect(stateLabel('ended', 1)).toBe('ended');
  });

  it('moves on as the clock moves', () => {
    expect(buildViewModel(snap, now + 11 * 60_000).agents.find((a) => a.callsign === 'claude-nico')!.state).toBe('quiet');
    expect(buildViewModel(snap, now + LIMITS.endedAfterMs).agents.find((a) => a.callsign === 'claude-nico')!.state).toBe('ended');
  });

  it('hides agents 24 hours after they ended', () => {
    const swap = (endedAt: number): Snapshot => ({ ...snap, agents: snap.agents.map((a) => (a.callsign === 'claude-sam' ? { ...a, endedAt } : a)) });
    expect(buildViewModel(swap(now - LIMITS.deleteEndedAfterMs), now).agents.map((a) => a.callsign)).not.toContain('claude-sam');
    expect(buildViewModel(swap(now - 1000), now).agents.find((a) => a.callsign === 'claude-sam')!.state).toBe('ended');
  });

  it('carries task labels, lock counts and enforcement', () => {
    expect(agent('codex-ana').taskLabel).toBe('#4 Login page');
    expect(agent('codex-ana').lockCount).toBe(2);
    expect(agent('claude-sam').enforced).toBe(false);
    expect(agent('claude-nico').activityLine).toBe('Edit src/app/page.tsx · 4s');
    expect(agent('claude-nico-2').activityLine).toBe('Waiting for input · 3m');
  });
});

describe('banners', () => {
  it('flags agents that are not enforced', () => {
    expect(vm.banners.map((b) => b.id)).toEqual(['enforcement']);
    expect(vm.banners[0]!.text).toContain('claude-sam');
  });
  it('flags a room that is not enforcing', () => {
    expect(buildViewModel({ ...snap, mode: 'warn' }, now).banners[0]!.id).toBe('mode');
    expect(buildViewModel({ ...snap, mode: 'off' }, now).banners[0]!.tone).toBe('danger');
  });
  it('flags a recent outage and drops it after ten minutes', () => {
    const outage: Snapshot = { ...snap, agents: snap.agents.map((a) => (a.callsign === 'codex-ana' ? { ...a, outageAt: now - 60_000, outageMs: 5000 } : a)) };
    expect(buildViewModel(outage, now).banners.map((b) => b.id)).toContain('outage');
    expect(buildViewModel(outage, now + 11 * 60_000).banners.map((b) => b.id)).not.toContain('outage');
  });
});

describe('edges', () => {
  it('keeps the five kinds, once each', () => {
    expect(vm.edges.map((e) => e.kind).sort()).toEqual(['blocked', 'broadcast', 'message', 'nearby', 'waiting']);
  });
  it('expires message edges after 60 s and blocked edges after 2 min', () => {
    const t = buildViewModel(snap, now + 50_000);
    expect(t.edges.map((e) => e.kind)).not.toContain('message');
    expect(t.edges.map((e) => e.kind)).toContain('blocked');
    expect(buildViewModel(snap, now + 3 * 60_000).edges.map((e) => e.kind)).not.toContain('blocked');
  });
  describe('blocked edge (claude-nico-2 denied login.ts held by codex-ana)', () => {
    const hasBlocked = (s: Snapshot, at = now) => buildViewModel(s, at).edges.some((e) => e.kind === 'blocked');
    const withLocks = (f: (l: Snapshot['locks']) => Snapshot['locks']): Snapshot => ({ ...snap, locks: f(snap.locks) });
    const isLogin = (l: Snapshot['locks'][number]) => l.path === 'src/auth/login.ts';
    const noFolder = (l: Snapshot['locks'][number]) => l.kind !== 'folder';
    it('is shown while the holder still holds the file', () => {
      expect(hasBlocked(snap)).toBe(true);
    });
    it('goes when the lock is released', () => {
      expect(hasBlocked(withLocks((l) => l.filter((x) => !isLogin(x) && noFolder(x))))).toBe(false);
    });
    it('goes when someone else took the lock', () => {
      expect(hasBlocked(withLocks((l) => l.filter(noFolder).map((x) => (isLogin(x) ? { ...x, holder: 'codex-sam' } : x))))).toBe(false);
    });
    it('goes when the blocked agent now holds the file', () => {
      expect(hasBlocked(withLocks((l) => l.filter(noFolder).map((x) => (isLogin(x) ? { ...x, holder: 'claude-nico-2' } : x))))).toBe(false);
    });
    it('goes when either agent has ended', () => {
      const end = (who: string): Snapshot => ({ ...snap, agents: snap.agents.map((a) => (a.callsign === who ? { ...a, endedAt: now - 1000 } : a)) });
      expect(hasBlocked(end('claude-nico-2'))).toBe(false);
      expect(hasBlocked(end('codex-ana'))).toBe(false);
    });
    it('does not come back when the lock was re-taken after the edge', () => {
      expect(hasBlocked(withLocks((l) => l.filter(noFolder).map((y) => (isLogin(y) ? { ...y, acquiredAt: snap.edges.find((q) => q.kind === 'blocked')!.at + 1000 } : y))))).toBe(false);
    });
    it('keeps the edge for a folder denial and for a folder that contains the file', () => {
      expect(hasBlocked(withLocks((l) => l.filter((y) => !isLogin(y))))).toBe(false); // folder src/auth/ has no matching file lock any more
      const folder = { ...snap.locks.find((y) => y.kind === 'folder')!, path: 'src/Login.ts/' };
      expect(hasBlocked(withLocks((l) => [...l.filter((y) => !isLogin(y) && noFolder(y)), folder]))).toBe(true);
    });
    it('removes the edge when B only holds an unrelated folder', () => {
      const folder = { ...snap.locks.find((y) => y.kind === 'folder')!, path: 'infra/' };
      expect(hasBlocked(withLocks((l) => [...l.filter((y) => !isLogin(y) && noFolder(y)), folder]))).toBe(false);
    });
    it('matches names case-insensitively', () => {
      expect(hasBlocked(withLocks((l) => l.filter(noFolder).map((y) => (isLogin(y) ? { ...y, path: 'SRC/Auth/LOGIN.ts' } : y))))).toBe(true);
    });
    it('goes after LIMITS.blockedEdgeMs', () => {
      expect(hasBlocked(snap, now + LIMITS.blockedEdgeMs - 61_000)).toBe(true);
      expect(hasBlocked(snap, now + LIMITS.blockedEdgeMs)).toBe(false);
    });
  });
  it('drops edges to agents that are gone', () => {
    const lonely = { ...snap, agents: snap.agents.filter((a) => a.callsign !== 'codex-ana') };
    expect(buildViewModel(lonely, now).edges.every((e) => e.from !== 'codex-ana' && e.to !== 'codex-ana')).toBe(true);
  });
});

describe('panels', () => {
  it('counts tasks and orders them', () => {
    expect(vm.tasks.inProgress).toBe(4);
    expect(vm.tasks.items[0]!.status).toBe('in_progress');
    expect(vm.tasks.items.find((t) => t.id === 7)!.waitingOn).toEqual([4]);
  });
  it('lists locks with the holder state', () => {
    expect(vm.locks).toHaveLength(snap.locks.length);
    expect(vm.locks.find((l) => l.holder === 'codex-sam')!.holderState).toBe('quiet');
    expect(vm.counts.locks).toBe(5);
  });
  it('lists activity newest first', () => {
    expect(vm.activity[0]!.seq).toBe(118);
    expect(vm.activity.find((a) => a.type === 'lock.denied')!.tone).toBe('danger');
    expect(vm.activity[0]!.age).toBe('12s ago');
  });
  it('reports usage', () => {
    expect(vm.usage).toMatchObject({ requests: 12840, cap: 100000, level: 'ok' });
    expect(buildViewModel({ ...snap, usage: { requests: 70000, cap: 100000 } }, now).usage.level).toBe('slow');
    expect(buildViewModel({ ...snap, usage: { requests: 96000, cap: 100000 } }, now).usage.level).toBe('high');
  });
});

describe('reconnect banner', () => {
  it('appears after 10 seconds without a connection', () => {
    expect(showReconnectBanner('open', 0, 99_000)).toBe(false);
    expect(showReconnectBanner('closed', 1000, 5000)).toBe(false);
    expect(showReconnectBanner('closed', 1000, 11_000)).toBe(true);
    expect(showReconnectBanner('connecting', 0, 10_000)).toBe(true);
  });
});
