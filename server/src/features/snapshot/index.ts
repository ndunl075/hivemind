/**
 * The full dashboard snapshot (ARCHITECTURE.md §14): roster, tasks, locks, edges and the activity feed.
 * The Room overwrites `room`, `mode`, `now` and `usage` after build(), so they are authoritative whatever this returns.
 * Activity and the recent message and blocked edges are rebuilt from the `events` table (read only, through ctx.sql);
 * waiting and nearby edges are derived from the current tasks and locks.
 */
import {
  LIMITS, type ActivityView, type Callsign, type EdgeKind, type EdgeView, type FeatureFactory, type LockView,
  type Millis, type Snapshot, type TaskView,
} from '../../../../shared/contracts';

/** Newest events shown in the activity feed. */
export const ACTIVITY_LIMIT = 50;
/** Hard cap on edge-carrying events scanned (only events inside the edge windows are read). */
const EDGE_SCAN_LIMIT = 1000;
/** Size caps, so a busy room can't make a snapshot grow without bound. */
export const ACTIVITY_TEXT_MAX = 200;
export const DONE_TASKS_MAX = 50;
export const LOCKS_MAX = 300;

/** Only these come from events; waiting and nearby are derived from tasks and locks. */
const EVENT_EDGE_KINDS: readonly EdgeKind[] = ['message', 'broadcast', 'blocked'];

interface EventData {
  text?: unknown;
  pulse?: { kind?: unknown; from?: unknown; to?: unknown };
  edge?: { kind?: unknown; from?: unknown; to?: unknown; label?: unknown };
}

function parseData(raw: unknown): EventData {
  try {
    const v: unknown = typeof raw === 'string' ? JSON.parse(raw) : null;
    return v !== null && typeof v === 'object' ? (v as EventData) : {};
  } catch {
    return {};
  }
}

const edgeWindow = (kind: EdgeKind): Millis =>
  kind === 'message' || kind === 'broadcast' ? LIMITS.messageEdgeMs : LIMITS.blockedEdgeMs;

function edgeFromEvent(data: EventData, ts: Millis): EdgeView | null {
  const e = data.edge;
  if (e && typeof e.from === 'string' && EVENT_EDGE_KINDS.includes(e.kind as EdgeKind)) {
    return {
      kind: e.kind as EdgeKind, from: e.from, ...(typeof e.to === 'string' ? { to: e.to } : {}),
      ...(typeof e.label === 'string' ? { label: e.label } : {}), at: ts,
    };
  }
  const p = data.pulse;
  if (p && typeof p.from === 'string') {
    if (p.kind === 'message' && typeof p.to === 'string') return { kind: 'message', from: p.from, to: p.to, at: ts };
    if (p.kind === 'broadcast') return { kind: 'broadcast', from: p.from, at: ts };
  }
  return null;
}

const dirOf = (path: string): string => {
  if (path.endsWith('/')) return path;
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i + 1);
};

function waitingEdges(tasks: TaskView[], now: Millis): EdgeView[] {
  const byId = new Map(tasks.map((t) => [t.id, t] as const));
  const out = new Map<string, EdgeView>();
  for (const t of tasks) {
    if (t.status !== 'in_progress' || !t.owner) continue;
    for (const id of t.dependsOn) {
      const dep = byId.get(id);
      if (dep?.status === 'in_progress' && dep.owner && dep.owner !== t.owner) {
        out.set(`${dep.owner}>${t.owner}`, { kind: 'waiting', from: dep.owner, to: t.owner, at: now });
      }
    }
  }
  return [...out.values()];
}

function nearbyEdges(locks: LockView[], now: Millis): EdgeView[] {
  const holders = new Map<string, Set<Callsign>>();
  for (const l of locks) {
    const key = `${l.repo}\u0000${dirOf(l.path)}`;
    const set = holders.get(key) ?? new Set<Callsign>();
    set.add(l.holder);
    holders.set(key, set);
  }
  const out = new Map<string, EdgeView>();
  for (const set of holders.values()) {
    const names = [...set].sort();
    for (let i = 0; i < names.length; i++) {
      for (let j = i + 1; j < names.length; j++) {
        out.set(`${names[i]}~${names[j]}`, { kind: 'nearby', from: names[i] as string, to: names[j] as string, at: now });
      }
    }
  }
  return [...out.values()];
}

export const createSnapshot: FeatureFactory<'snapshot'> = (ctx, features) => {
  const activity = (): ActivityView[] =>
    ctx.sql.exec('SELECT seq, ts, type, actor, data FROM events ORDER BY seq DESC LIMIT ?', ACTIVITY_LIMIT).toArray().map((r) => ({
      seq: Number(r.seq),
      ts: Number(r.ts),
      type: String(r.type),
      actor: typeof r.actor === 'string' ? r.actor : null,
      text: String(parseData(r.data).text ?? r.type).slice(0, ACTIVITY_TEXT_MAX),
    }));

  const recentEdges = (now: Millis): EdgeView[] => {
    const seen = new Map<string, EdgeView>();
    const rows = ctx.sql.exec(
      `SELECT ts, data FROM events WHERE ts >= ? AND (data LIKE '%"edge":%' OR data LIKE '%"pulse":%') ORDER BY seq DESC LIMIT ?`,
      now - Math.max(LIMITS.messageEdgeMs, LIMITS.blockedEdgeMs), EDGE_SCAN_LIMIT).toArray();
    for (const r of rows) {
      const ts = Number(r.ts);
      const edge = edgeFromEvent(parseData(r.data), ts);
      if (!edge || now - ts >= edgeWindow(edge.kind)) continue;
      const key = `${edge.kind}|${edge.from}|${edge.to ?? ''}|${edge.label ?? ''}`; // one blocked edge per file
      if (!seen.has(key)) seen.set(key, edge); // newest first, so the first one seen is the latest
    }
    return [...seen.values()];
  };

  return {
    build(): Snapshot {
      const now = ctx.now();
      const all = features.tasks.list();
      const finished = (t: TaskView): boolean => t.status === 'done' || t.status === 'dropped';
      const recentDone = new Set(all.filter(finished).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, DONE_TASKS_MAX));
      const tasks = all.filter((t) => !finished(t) || recentDone.has(t));
      const locks = features.locks.list().slice(0, LOCKS_MAX);
      return {
        type: 'snapshot',
        room: '',
        mode: ctx.mode(),
        now,
        usage: { requests: 0, cap: LIMITS.dailyRequestCap },
        agents: ctx.agents().map(({ session: _session, ...view }) => ({
          ...view,
          taskId: features.tasks.inProgressFor(view.callsign)?.id ?? null,
        })),
        tasks,
        locks,
        edges: [...recentEdges(now), ...waitingEdges(tasks, now), ...nearbyEdges(locks, now)],
        activity: activity(),
      };
    },
  };
};
