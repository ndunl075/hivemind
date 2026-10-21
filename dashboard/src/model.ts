/**
 * Pure view-model: turns a Snapshot plus "now" into exactly what the views draw (ARCHITECTURE.md §14).
 * Agent states come from shared/state.ts so the dashboard and the server never disagree.
 */
import {
  LIMITS,
  type AgentKind,
  type AgentState,
  type AgentView,
  type EdgeKind,
  type EdgeView,
  type LockView,
  type LockKind,
  type Millis,
  type RoomMode,
  type Snapshot,
  type TaskStatus,
} from '../../shared/contracts';
import { deriveState } from '../../shared/state';
import { ago, plural, shortDuration } from './format';

/** How long an outage report keeps the banner up (§14.1). */
export const OUTAGE_BANNER_MS = 10 * 60_000;

export interface AgentVM {
  callsign: string;
  kind: AgentKind;
  person: string;
  branch: string | null;
  state: AgentState;
  takeable: boolean;
  /** "4s ago", "idle · 3m", "quiet 14m", "ended". */
  stateLabel: string;
  enforced: boolean;
  /** Live activity in monospace, e.g. "Edit src/auth/login.ts · 4s". */
  activityLine: string;
  /** "#4 Login page", or null. */
  taskLabel: string | null;
  lockCount: number;
}

export interface EdgeVM {
  key: string;
  kind: EdgeKind;
  from: string;
  to: string | null;
  label: string | null;
  at: Millis;
}

export interface Banner {
  id: 'mode' | 'enforcement' | 'outage';
  tone: 'warn' | 'danger';
  text: string;
}

export interface TaskItemVM {
  id: number;
  title: string;
  status: TaskStatus;
  owner: string | null;
  ownerState: AgentState | null;
  note: string | null;
  /** Unfinished tasks this one depends on. */
  waitingOn: number[];
}

export interface LockItemVM {
  key: string;
  path: string;
  kind: LockKind;
  holder: string;
  holderState: AgentState;
  takeable: boolean;
}

export type ActivityTone = 'neutral' | 'accent' | 'danger' | 'warn';

export interface ActivityItemVM {
  seq: number;
  type: string;
  tone: ActivityTone;
  age: string;
  text: string;
}

export interface UsageVM {
  requests: number;
  cap: number;
  fraction: number;
  level: 'ok' | 'slow' | 'warn' | 'high';
}

export interface ViewModel {
  room: string;
  mode: RoomMode;
  counts: { agents: number; tasks: number; locks: number };
  banners: Banner[];
  agents: AgentVM[];
  edges: EdgeVM[];
  tasks: { open: number; inProgress: number; done: number; items: TaskItemVM[] };
  locks: LockItemVM[];
  activity: ActivityItemVM[];
  usage: UsageVM;
}

/** Ended agents disappear 24 hours after they ended (§5). */
export function isHidden(agent: AgentView, now: Millis): boolean {
  const d = deriveState(agent, now);
  if (d.state !== 'ended') return false;
  const endedAt = agent.endedAt ?? agent.lastEvent + LIMITS.endedAfterMs;
  return now - endedAt >= LIMITS.deleteEndedAfterMs;
}

export function stateLabel(state: AgentState, silenceMs: number): string {
  switch (state) {
    case 'working':
      return ago(silenceMs);
    case 'idle':
      return `idle · ${shortDuration(silenceMs)}`;
    case 'quiet':
      return `quiet ${shortDuration(silenceMs)}`;
    case 'ended':
      return 'ended';
  }
}

function activityLine(agent: AgentView, state: AgentState, silenceMs: number): string {
  if (state === 'ended') return 'Session ended';
  if (state === 'idle') return `Waiting for input · ${shortDuration(silenceMs)}`;
  if (!agent.activity) return 'No activity yet';
  return `${agent.activity} · ${shortDuration(silenceMs)}`;
}

function edgeIsLive(kind: EdgeKind, at: Millis, now: Millis): boolean {
  switch (kind) {
    case 'message':
    case 'broadcast':
      return now - at < LIMITS.messageEdgeMs;
    case 'blocked':
      return now - at < LIMITS.blockedEdgeMs;
    default:
      return true;
  }
}

/**
 * A blocked edge (A denied a file B holds) is drawn only while it still applies (§14.2): both agents are
 * still alive, B holds the lock that caused the denial (acquired no later than the edge, so a release and
 * re-take doesn't bring it back), and A has not since taken the file. Names compare case-insensitively.
 * A folder lock held by B counts when its name is the label (folder denials) or it contains a file lock
 * matching the label.
 * Accepted limitations: edges carry only a base name, so same-basename files can collide (fixing that needs
 * a server change), and locks beyond the snapshot cap make an edge disappear.
 */
function blockedStillApplies(
  e: EdgeView,
  locks: readonly LockView[],
  stateOf: ReadonlyMap<string, { state: AgentState }>,
): boolean {
  if (stateOf.get(e.from)?.state === 'ended') return false;
  if (e.to === undefined) return true;
  if (stateOf.get(e.to)?.state === 'ended') return false;
  if (e.label === undefined) return true;
  const name = e.label.toLowerCase();
  const lower = (l: LockView) => l.path.toLowerCase().replace(/\/+$/, '');
  const named = (l: LockView) => lower(l) === name || lower(l).endsWith(`/${name}`);
  const files = locks.filter((l) => l.kind === 'file' && named(l));
  if (files.some((l) => l.holder === e.from)) return false;
  const heldThen = (l: LockView) => l.holder === e.to && l.acquiredAt <= e.at;
  if (files.some(heldThen)) return true;
  return locks.some((l) => l.kind === 'folder' && heldThen(l) && (named(l) || files.some((f) => lower(f).startsWith(`${lower(l)}/`))));
}

function tone(type: string): ActivityTone {
  if (/denied|blocked|outage/.test(type)) return 'danger';
  if (/take|quiet/.test(type)) return 'warn';
  if (/push|message/.test(type)) return 'accent';
  return 'neutral';
}

function namesList(names: string[]): string {
  const shown = names.slice(0, 3).join(', ');
  return names.length > 3 ? `${shown} and ${names.length - 3} more` : shown;
}

const TASK_ORDER: Record<TaskStatus, number> = { in_progress: 0, open: 1, done: 2, dropped: 3 };

export function buildViewModel(s: Snapshot, now: Millis): ViewModel {
  const stateOf = new Map<string, { state: AgentState; takeable: boolean }>();
  for (const a of s.agents) {
    const d = deriveState(a, now);
    stateOf.set(a.callsign, { state: d.state, takeable: d.takeable });
  }
  const tasksById = new Map(s.tasks.map((t) => [t.id, t]));
  const lockCounts = new Map<string, number>();
  for (const l of s.locks) lockCounts.set(l.holder, (lockCounts.get(l.holder) ?? 0) + 1);

  const visible = s.agents.filter((a) => !isHidden(a, now));
  const agents: AgentVM[] = visible.map((a) => {
    const d = deriveState(a, now);
    const task = a.taskId === null ? undefined : tasksById.get(a.taskId);
    return {
      callsign: a.callsign,
      kind: a.kind,
      person: a.person,
      branch: a.branch,
      state: d.state,
      takeable: d.takeable,
      stateLabel: stateLabel(d.state, d.silenceMs),
      enforced: a.hooked,
      activityLine: activityLine(a, d.state, d.silenceMs),
      taskLabel: task ? `#${task.id} ${task.title}` : null,
      lockCount: lockCounts.get(a.callsign) ?? 0,
    };
  });

  const present = new Set(agents.map((a) => a.callsign));
  const seen = new Set<string>();
  const edges: EdgeVM[] = [];
  for (const e of s.edges) {
    if (!edgeIsLive(e.kind, e.at, now)) continue;
    if (e.kind === 'blocked' && !blockedStillApplies(e, s.locks, stateOf)) continue;
    if (!present.has(e.from) || (e.to !== undefined && !present.has(e.to))) continue;
    const pair = e.kind === 'nearby' ? [e.from, e.to ?? ''].sort().join('|') : `${e.from}|${e.to ?? ''}`;
    const key = `${e.kind}:${pair}`;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push({ key, kind: e.kind, from: e.from, to: e.to ?? null, label: e.label ?? null, at: e.at });
  }

  const live = agents.filter((a) => a.state !== 'ended');
  const unenforced = live.filter((a) => !a.enforced).map((a) => a.callsign);
  const outage = visible
    .filter((a) => a.outageAt !== null && now - a.outageAt < OUTAGE_BANNER_MS)
    .map((a) => a.callsign);
  const banners: Banner[] = [];
  if (s.mode === 'warn') {
    banners.push({ id: 'mode', tone: 'warn', text: 'Warn mode: conflicts are flagged but edits are not blocked.' });
  } else if (s.mode === 'off') {
    banners.push({ id: 'mode', tone: 'danger', text: 'Enforcement is off: edits are not being blocked.' });
  }
  if (unenforced.length > 0) {
    banners.push({
      id: 'enforcement',
      tone: 'warn',
      text: `${plural(unenforced.length, 'agent')} not enforced: ${namesList(unenforced)}`,
    });
  }
  if (outage.length > 0) {
    banners.push({
      id: 'outage',
      tone: 'warn',
      text: `${plural(outage.length, 'agent')} reported an outage in the last 10 minutes: ${namesList(outage)}`,
    });
  }

  const activeTasks = s.tasks.filter((t) => t.status === 'open' || t.status === 'in_progress');
  const items: TaskItemVM[] = s.tasks
    .filter((t) => t.status !== 'dropped')
    .sort((a, b) => TASK_ORDER[a.status] - TASK_ORDER[b.status] || a.id - b.id)
    .map((t) => ({
      id: t.id,
      title: t.title,
      status: t.status,
      owner: t.owner,
      ownerState: t.owner ? (stateOf.get(t.owner)?.state ?? 'ended') : null,
      note: t.note,
      waitingOn: t.dependsOn.filter((id) => {
        const dep = tasksById.get(id);
        return dep !== undefined && dep.status !== 'done' && dep.status !== 'dropped';
      }),
    }));

  const locks: LockItemVM[] = [...s.locks]
    .sort((a, b) => a.holder.localeCompare(b.holder) || a.path.localeCompare(b.path))
    .map((l) => {
      const st = stateOf.get(l.holder);
      return {
        key: `${l.repo}:${l.path}`,
        path: l.path,
        kind: l.kind,
        holder: l.holder,
        holderState: st?.state ?? 'ended',
        takeable: st?.takeable ?? false,
      };
    });

  const activity: ActivityItemVM[] = [...s.activity]
    .sort((a, b) => b.seq - a.seq)
    .map((a) => ({ seq: a.seq, type: a.type, tone: tone(a.type), age: ago(now - a.ts), text: a.text }));

  const fraction = s.usage.cap > 0 ? s.usage.requests / s.usage.cap : 0;
  const level: UsageVM['level'] =
    fraction >= LIMITS.guardWarnAt
      ? 'high'
      : fraction >= LIMITS.guardSlowerAt
        ? 'warn'
        : fraction >= LIMITS.guardSlowAt
          ? 'slow'
          : 'ok';

  return {
    room: s.room,
    mode: s.mode,
    counts: { agents: live.length, tasks: activeTasks.length, locks: s.locks.length },
    banners,
    agents,
    edges,
    tasks: {
      open: s.tasks.filter((t) => t.status === 'open').length,
      inProgress: s.tasks.filter((t) => t.status === 'in_progress').length,
      done: s.tasks.filter((t) => t.status === 'done').length,
      items,
    },
    locks,
    activity,
    usage: { requests: s.usage.requests, cap: s.usage.cap, fraction, level },
  };
}

export type ConnectionState = 'connecting' | 'open' | 'closed';

/** After this long without a connection the page shows the reconnecting banner (§14.5). */
export const RECONNECT_BANNER_AFTER_MS = 10_000;

/** `since` is when the connection was last lost (or the page loaded without one). */
export function showReconnectBanner(state: ConnectionState, since: Millis, now: Millis): boolean {
  return state !== 'open' && now - since >= RECONNECT_BANNER_AFTER_MS;
}

/** One plain sentence per edge, for the screen-reader list next to the graph. */
export function describeEdge(e: EdgeVM): string {
  switch (e.kind) {
    case 'message':
      return `${e.from} messaged ${e.to ?? 'someone'}`;
    case 'broadcast':
      return `${e.from} messaged everyone`;
    case 'blocked': {
      return `${e.from} blocked from ${e.label ?? 'a file'}${e.to ? `, held by ${e.to}` : ''}`;
    }
    case 'waiting':
      return `${e.to ?? 'someone'} waits on ${e.from}`;
    case 'nearby':
      return `${e.from} and ${e.to ?? 'someone'} hold locks in the same folder`;
  }
}
