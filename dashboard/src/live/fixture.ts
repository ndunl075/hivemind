import raw from '../../../shared/fixtures/snapshot.json';
import type { Snapshot } from '../../../shared/contracts';

export const fixtureSnapshot = raw as unknown as Snapshot;

const shiftNum = (v: number | null, by: number): number | null => (v === null ? null : v + by);

/** A copy of the fixture with every timestamp moved so its `now` is `toNow`. */
export function shiftSnapshot(s: Snapshot, toNow: number): Snapshot {
  const by = toNow - s.now;
  return {
    ...s,
    now: toNow,
    agents: s.agents.map((a) => ({
      ...a,
      startedAt: a.startedAt + by,
      lastEvent: a.lastEvent + by,
      idleSince: shiftNum(a.idleSince, by),
      endedAt: shiftNum(a.endedAt, by),
      outageAt: shiftNum(a.outageAt, by),
    })),
    tasks: s.tasks.map((t) => ({ ...t, createdAt: t.createdAt + by, updatedAt: t.updatedAt + by })),
    locks: s.locks.map((l) => ({ ...l, acquiredAt: l.acquiredAt + by })),
    edges: s.edges.map((e) => ({ ...e, at: e.at + by })),
    activity: s.activity.map((a) => ({ ...a, ts: a.ts + by })),
  };
}
