/**
 * Checks that data from a source has the shape the views rely on (§8.2 snapshots and pulses).
 * Malformed list elements are dropped, and optional fields are normalized, so one bad record can never
 * throw while rendering or show "undefined".
 */
import type {
  ActivityView,
  AgentView,
  DashboardMessage,
  EdgeKind,
  EdgeView,
  LockView,
  Pulse,
  PulseKind,
  TaskView,
} from '../../shared/contracts';

const PULSES: readonly PulseKind[] = ['message', 'broadcast', 'denied', 'push'];
const EDGES: readonly EdgeKind[] = ['message', 'broadcast', 'blocked', 'waiting', 'nearby'];
const TASK_STATUS = ['open', 'in_progress', 'done', 'dropped'] as const;

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
const str = (v: unknown): v is string => typeof v === 'string';
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const strOrNull = (v: unknown): string | null => (str(v) ? v : null);
const numOrNull = (v: unknown): number | null => (num(v) ? v : null);

function agent(v: unknown): AgentView | null {
  if (!isObj(v) || !str(v.callsign) || !str(v.person)) return null;
  if (v.kind !== 'claude' && v.kind !== 'codex') return null;
  if (!num(v.lastEvent) || !num(v.startedAt)) return null;
  return {
    callsign: v.callsign,
    kind: v.kind,
    person: v.person,
    repo: strOrNull(v.repo),
    repoName: strOrNull(v.repoName),
    checkout: strOrNull(v.checkout),
    branch: strOrNull(v.branch),
    head: strOrNull(v.head),
    hooked: v.hooked === true,
    activity: strOrNull(v.activity),
    startedAt: v.startedAt,
    lastEvent: v.lastEvent,
    idleSince: numOrNull(v.idleSince),
    endedAt: numOrNull(v.endedAt),
    outageAt: numOrNull(v.outageAt),
    outageMs: numOrNull(v.outageMs),
    taskId: numOrNull(v.taskId),
  };
}

function task(v: unknown): TaskView | null {
  if (!isObj(v) || !num(v.id) || !str(v.title)) return null;
  if (!TASK_STATUS.includes(v.status as (typeof TASK_STATUS)[number])) return null;
  return {
    id: v.id,
    title: v.title,
    description: strOrNull(v.description),
    status: v.status as TaskView['status'],
    owner: strOrNull(v.owner),
    createdBy: str(v.createdBy) ? v.createdBy : '',
    dependsOn: Array.isArray(v.dependsOn) ? v.dependsOn.filter(num) : [],
    areas: Array.isArray(v.areas) ? (v.areas as TaskView['areas']) : [],
    note: strOrNull(v.note),
    createdAt: numOrNull(v.createdAt) ?? 0,
    updatedAt: numOrNull(v.updatedAt) ?? 0,
  };
}

function lock(v: unknown): LockView | null {
  if (!isObj(v) || !str(v.path) || !str(v.holder)) return null;
  if (v.kind !== 'file' && v.kind !== 'folder') return null;
  return {
    repo: str(v.repo) ? v.repo : '',
    path: v.path,
    kind: v.kind,
    holder: v.holder,
    checkout: str(v.checkout) ? v.checkout : '',
    taskId: numOrNull(v.taskId),
    reason: strOrNull(v.reason),
    acquiredAt: numOrNull(v.acquiredAt) ?? 0,
  };
}

function edge(v: unknown): EdgeView | null {
  if (!isObj(v) || !str(v.from) || !num(v.at)) return null;
  if (!EDGES.includes(v.kind as EdgeKind)) return null;
  const kind = v.kind as EdgeKind;
  if (kind !== 'broadcast' && !str(v.to)) return null;
  const out: EdgeView = { kind, from: v.from, at: v.at };
  if (str(v.to)) out.to = v.to;
  if (str(v.label)) out.label = v.label;
  return out;
}

function activity(v: unknown): ActivityView | null {
  if (!isObj(v) || !num(v.seq) || !num(v.ts) || !str(v.type) || !str(v.text)) return null;
  return { seq: v.seq, ts: v.ts, type: v.type, actor: strOrNull(v.actor), text: v.text };
}

function list<T>(raw: unknown, f: (v: unknown) => T | null): T[] {
  return Array.isArray(raw) ? raw.map(f).filter((x): x is T => x !== null) : [];
}

export function parseMessage(raw: unknown): DashboardMessage | null {
  if (!isObj(raw)) return null;
  if (raw.type === 'pulse') {
    if (!str(raw.from) || !num(raw.at)) return null;
    if (!PULSES.includes(raw.kind as PulseKind)) return null;
    const p: Pulse = { type: 'pulse', kind: raw.kind as PulseKind, from: raw.from, at: raw.at };
    if (str(raw.to)) p.to = raw.to;
    if (str(raw.path)) p.path = raw.path;
    return p;
  }
  if (raw.type === 'snapshot') {
    if (!str(raw.room) || !(raw.mode === 'enforce' || raw.mode === 'warn' || raw.mode === 'off')) return null;
    if (!num(raw.now) || !isObj(raw.usage) || !num(raw.usage.requests) || !num(raw.usage.cap)) return null;
    for (const k of ['agents', 'tasks', 'locks', 'edges', 'activity']) if (!Array.isArray(raw[k])) return null;
    return {
      type: 'snapshot',
      room: raw.room,
      mode: raw.mode,
      now: raw.now,
      usage: { requests: raw.usage.requests, cap: raw.usage.cap },
      agents: list(raw.agents, agent),
      tasks: list(raw.tasks, task),
      locks: list(raw.locks, lock),
      edges: list(raw.edges, edge),
      activity: list(raw.activity, activity),
    };
  }
  return null;
}
