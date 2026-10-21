/**
 * Minimal snapshot (Wave 1): agents, locks and mode. W7 (dashboard-live) completes it (tasks, edges, activity).
 * The Room overwrites `room`, `mode`, `now` and `usage` after build(), so they are authoritative whatever this returns.
 */
import type { FeatureFactory, Snapshot } from '../../../../shared/contracts';

export const createSnapshot: FeatureFactory<'snapshot'> = (ctx, features) => ({
  build(): Snapshot {
    return {
      type: 'snapshot',
      room: '',
      mode: ctx.mode(),
      now: ctx.now(),
      usage: { requests: 0, cap: 0 },
      agents: ctx.agents().map(({ session: _session, ...view }) => ({
        ...view,
        taskId: features.tasks.inProgressFor(view.callsign)?.id ?? null,
      })),
      tasks: features.tasks.list(),
      locks: features.locks.list(),
      edges: [],
      activity: [],
    };
  },
});
