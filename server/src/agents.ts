/**
 * The Room's agent roster: memory first, SQLite behind it (ARCHITECTURE.md §4, §8.2).
 * Registration, idle changes and endings are written at once; last_event, activity and the like are flushed
 * at most once a minute, piggybacked on a request.
 */
import { LIMITS, type AgentKind, type AgentRecord, type AgentView, type Callsign, type Millis, type SqlLike } from '../../shared/contracts';
import { deriveState } from '../../shared/state';

export class RoomFullError extends Error {}

const FLUSH_EVERY_MS = 60_000;

export interface RegisterFields {
  kind: AgentKind;
  person: string;
  session: string | null;
  hooked: boolean;
  repo: string | null;
  repoName?: string | null;
  checkout?: string | null;
  branch?: string | null;
  head?: string | null;
}

export class AgentStore {
  private readonly map = new Map<Callsign, AgentRecord>();
  private readonly sessions = new Map<string, Callsign>();
  private readonly dirty = new Set<Callsign>();
  private lastFlush = 0;
  /**
   * Called once for an agent that is over (ended, or 12 hours silent) before its callsign is reused or its session
   * revived: the Room releases its locks, returns its tasks and clears its messages.
   */
  onRetire: (a: AgentRecord, fresh: boolean) => void = () => {};
  /** Called when an agent row is deleted for good. */
  onDelete: (callsign: Callsign) => void = () => {};

  constructor(private readonly sql: SqlLike, private readonly now: () => Millis) {}

  createSchema(): void {
    // repo_name is an addition to the §4 schema: the dashboard shows the repo's display name.
    this.sql.exec(`CREATE TABLE IF NOT EXISTS agents (
      callsign TEXT PRIMARY KEY, session_id TEXT UNIQUE, kind TEXT NOT NULL, person TEXT NOT NULL,
      repo TEXT, repo_name TEXT, checkout TEXT, branch TEXT, head TEXT, hooked INTEGER NOT NULL, activity TEXT,
      started_at INTEGER NOT NULL, last_event INTEGER NOT NULL, idle_since INTEGER, ended_at INTEGER,
      outage_at INTEGER, outage_ms INTEGER)`).toArray();
  }

  load(): void {
    this.map.clear();
    this.sessions.clear();
    this.dirty.clear();
    this.lastFlush = this.now();
    for (const r of this.sql.exec('SELECT * FROM agents').toArray()) {
      const a: AgentRecord = {
        callsign: String(r.callsign),
        session: r.session_id === null ? null : String(r.session_id),
        kind: r.kind as AgentKind,
        person: String(r.person),
        repo: (r.repo as string | null) ?? null,
        repoName: (r.repo_name as string | null) ?? null,
        checkout: (r.checkout as string | null) ?? null,
        branch: (r.branch as string | null) ?? null,
        head: (r.head as string | null) ?? null,
        hooked: Number(r.hooked) === 1,
        activity: (r.activity as string | null) ?? null,
        startedAt: Number(r.started_at),
        lastEvent: Number(r.last_event),
        idleSince: r.idle_since === null ? null : Number(r.idle_since),
        endedAt: r.ended_at === null ? null : Number(r.ended_at),
        outageAt: r.outage_at === null ? null : Number(r.outage_at),
        outageMs: r.outage_ms === null ? null : Number(r.outage_ms),
        taskId: null,
      };
      this.map.set(a.callsign, a);
      if (a.session) this.sessions.set(a.session, a.callsign);
    }
  }

  get(callsign: Callsign): AgentRecord | null {
    return this.map.get(callsign) ?? null;
  }

  all(): AgentRecord[] {
    return [...this.map.values()];
  }

  bySession(session: string): AgentRecord | null {
    const cs = this.sessions.get(session);
    return cs ? (this.map.get(cs) ?? null) : null;
  }

  isEnded(a: AgentRecord): boolean {
    return deriveState(a, this.now()).state === 'ended';
  }

  activeCount(): number {
    let n = 0;
    for (const a of this.map.values()) if (!this.isEnded(a)) n++;
    return n;
  }

  private allocate(kind: AgentKind, person: string): Callsign {
    for (let n = 1; ; n++) {
      const cs = n === 1 ? `${kind}-${person}` : `${kind}-${person}-${n}`;
      const existing = this.map.get(cs);
      if (!existing) return cs;
      if (this.isEnded(existing)) {
        this.retire(existing);
        this.remove(cs);
        return cs;
      }
    }
  }

  /** Makes sure an over agent has been cleaned up, whether or not it was marked ended. */
  retire(a: AgentRecord): void {
    const fresh = a.endedAt === null;
    if (fresh) {
      a.endedAt = Math.min(this.now(), a.lastEvent + LIMITS.endedAfterMs);
      a.activity = null;
      this.persist(a);
    }
    this.onRetire(a, fresh);
  }

  private remove(callsign: Callsign): void {
    const a = this.map.get(callsign);
    if (!a) return;
    if (a.session) this.sessions.delete(a.session);
    this.map.delete(callsign);
    this.dirty.delete(callsign);
    this.sql.exec('DELETE FROM agents WHERE callsign = ?', callsign).toArray();
    this.onDelete(callsign);
  }

  /** Creates an agent with a fresh callsign. Throws RoomFullError at the agent cap. */
  register(f: RegisterFields): AgentRecord {
    if (this.activeCount() >= LIMITS.maxAgentsPerRoom) throw new RoomFullError('room is full');
    const now = this.now();
    const callsign = this.allocate(f.kind, f.person);
    const a: AgentRecord = {
      callsign, session: f.session, kind: f.kind, person: f.person, repo: f.repo, repoName: f.repoName ?? null,
      checkout: f.checkout ?? null, branch: f.branch ?? null, head: f.head ?? null, hooked: f.hooked,
      activity: null, startedAt: now, lastEvent: now, idleSince: null, endedAt: null, outageAt: null,
      outageMs: null, taskId: null,
    };
    this.map.set(callsign, a);
    if (a.session) this.sessions.set(a.session, callsign);
    this.persist(a);
    return a;
  }

  /** A session that comes back after ending (or after 12 hours of silence) keeps its callsign. */
  revive(a: AgentRecord): void {
    this.retire(a);
    const now = this.now();
    a.endedAt = null;
    a.idleSince = null;
    a.lastEvent = now;
    a.startedAt = now;
    a.activity = null;
    this.persist(a);
  }

  /**
   * Records an event for an agent. Setting or clearing idle_since is written at once, together with
   * last_event, so a reload can never show a working agent as idle.
   */
  touch(a: AgentRecord, opts: { idle?: boolean; activity?: string | null } = {}): void {
    const now = this.now();
    a.lastEvent = now;
    if (opts.activity !== undefined) a.activity = opts.activity;
    const wasIdle = a.idleSince !== null;
    a.idleSince = opts.idle ? now : null;
    if (wasIdle !== (a.idleSince !== null) || opts.idle) this.persist(a);
    else this.dirty.add(a.callsign);
  }

  markDirty(a: AgentRecord): void {
    this.dirty.add(a.callsign);
  }

  /** Marks an agent ended. Returns false if it already was. */
  end(a: AgentRecord): boolean {
    if (a.endedAt !== null) return false;
    a.endedAt = this.now();
    a.activity = null;
    this.persist(a);
    return true;
  }

  persist(a: AgentRecord): void {
    this.dirty.delete(a.callsign);
    this.sql.exec(
      `INSERT OR REPLACE INTO agents (callsign, session_id, kind, person, repo, repo_name, checkout, branch, head, hooked,
        activity, started_at, last_event, idle_since, ended_at, outage_at, outage_ms) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      a.callsign, a.session, a.kind, a.person, a.repo, a.repoName, a.checkout, a.branch, a.head, a.hooked ? 1 : 0,
      a.activity, a.startedAt, a.lastEvent, a.idleSince, a.endedAt, a.outageAt, a.outageMs,
    ).toArray();
  }

  /** Writes dirty rows at most once a minute (or when forced). */
  flush(force = false): void {
    const now = this.now();
    if (!force && now - this.lastFlush < FLUSH_EVERY_MS) return;
    this.lastFlush = now;
    for (const cs of [...this.dirty]) {
      const a = this.map.get(cs);
      if (a) this.persist(a);
    }
  }

  /**
   * Housekeeping: agents silent for 12 hours become ended (returned so the Room can release their holdings),
   * and agents ended for more than 24 hours are deleted.
   */
  reap(): { newlyEnded: AgentRecord[] } {
    const now = this.now();
    const newlyEnded: AgentRecord[] = [];
    for (const a of [...this.map.values()]) {
      if (a.endedAt === null && now - a.lastEvent >= LIMITS.endedAfterMs) {
        a.endedAt = a.lastEvent + LIMITS.endedAfterMs;
        a.activity = null;
        this.persist(a);
        newlyEnded.push(a);
      } else if (a.endedAt !== null && now - a.endedAt >= LIMITS.deleteEndedAfterMs) {
        this.remove(a.callsign);
      }
    }
    return { newlyEnded };
  }

  view(a: AgentRecord, taskId: number | null): AgentView {
    const { session: _session, ...view } = a;
    return { ...view, taskId };
  }
}
