import { afterEach, describe, expect, it, vi } from 'vitest';
import { fixtureSnapshot, shiftSnapshot } from './fixture';
import { advance, createFakeSource } from './fake';
import { buildViewModel } from '../model';
import { parseMessage } from '../validate';

afterEach(() => vi.useRealTimers());

describe('fake live source', () => {
  it('moves the fixture to the present without changing its states', () => {
    const t = 1_900_000_000_000;
    const moved = shiftSnapshot(fixtureSnapshot, t);
    const a = buildViewModel(fixtureSnapshot, fixtureSnapshot.now).agents.map((x) => x.stateLabel);
    expect(buildViewModel(moved, t).agents.map((x) => x.stateLabel)).toEqual(a);
  });

  it('keeps working agents working and adds scripted edges and activity', () => {
    const t = fixtureSnapshot.now + 120_000;
    const next = advance(fixtureSnapshot, t, 0);
    const vm = buildViewModel(next, t);
    expect(vm.agents.find((x) => x.callsign === 'claude-nico')!.state).toBe('working');
    expect(vm.agents.find((x) => x.callsign === 'codex-sam')!.state).toBe('quiet');
    expect(vm.edges.some((e) => e.kind === 'message' && e.at === t)).toBe(true);
    expect(next.activity[0]!.seq).toBe(fixtureSnapshot.activity[0]!.seq + 1);
  });

  it('delivers valid snapshots and pulses on a timer, and stops', () => {
    vi.useFakeTimers();
    const snaps: unknown[] = [];
    const pulses: unknown[] = [];
    const states: string[] = [];
    const stop = createFakeSource({ room: 'demo', token: null, demo: null }).start({
      onSnapshot: (s) => snaps.push(s),
      onPulse: (p) => pulses.push(p),
      onStatus: (s) => states.push(s),
    });
    vi.advanceTimersByTime(5200);
    expect(states).toEqual(['open']);
    expect(snaps.length).toBeGreaterThanOrEqual(5);
    expect(pulses).toHaveLength(1);
    expect(snaps.every((s) => parseMessage(s) !== null)).toBe(true);
    expect(parseMessage(pulses[0])).not.toBeNull();
    stop();
    const n = snaps.length;
    vi.advanceTimersByTime(3000);
    expect(snaps).toHaveLength(n);
  });

  it('reports a closed connection in offline demo mode', () => {
    const states: string[] = [];
    createFakeSource({ room: 'demo', token: null, demo: 'offline' }).start({ onSnapshot() {}, onPulse() {}, onStatus: (s) => states.push(s) });
    expect(states).toEqual(['closed']);
  });
});

describe('parseMessage', () => {
  it('rejects malformed data', () => {
    expect(parseMessage(null)).toBeNull();
    expect(parseMessage({ type: 'snapshot' })).toBeNull();
    expect(parseMessage({ type: 'pulse', kind: 'nope', from: 'a', at: 1 })).toBeNull();
    expect(parseMessage({ type: 'x' })).toBeNull();
  });
});
