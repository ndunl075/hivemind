/**
 * The Room Durable Object (ARCHITECTURE.md §8.2). One object per room, single-threaded, so every claim and lock is
 * decided strictly in order.
 *
 * - Load once: blockConcurrencyWhile creates the schema in code and loads everything into memory.
 * - Atomic by construction: mutations are synchronous checks followed by writes, with no await in between.
 * - Memory-first writes: see AgentStore; request counters flush at most once a minute.
 * - No alarms: states are derived from timestamps; housekeeping piggybacks on requests.
 * - Dashboard: hibernating WebSockets, a snapshot on connect and on change (at most 4 a second), pulses at once.
 * - events.data (JSON) holds { text, data?, pulse?, edge?, wake? } of every RoomEvent, so a snapshot builder can rebuild
 *   the activity feed and recent edges from the table.
 */
import { DurableObject } from 'cloudflare:workers';
import {
  DEFAULT_SETTINGS, LIMITS, type AgentRecord, type Features, type HookResponse, type Millis, type ModeRequest, type ModeResponse,
  type ProjectSettings, type ResolvedSettings, type RoomContext, type RoomEvent, type RoomMode, type UnlockRequest,
  type UnlockResponse, type WhoamiResponse, type Pulse,
} from '../../shared/contracts';
import { AgentStore } from './agents';
import { BudgetCounter } from './budget';
import type { Env } from './env';
import { createLocks } from './features/locks';
import { handleMcp } from './features/mcp';
import { createMessages } from './features/messages';
import { createPushes } from './features/git';
import { createSnapshot } from './features/snapshot';
import { createTasks } from './features/tasks';
import { Pipeline } from './pipeline';
import { HttpError, type RoomServices } from './services';
import { PERSON_NAME_RE } from './tokens';
import { canonicalPath, errorResponse, json, utcDate } from './util';
import { isObj, isRoomMode, parseHookRequest, sanitizeSettings } from './validate';
import { WaitRegistry } from './waits';

/** Set by the Worker after it verified the token. Only the Worker can reach a Room. */
export interface InternalClaims {
  kind: 'agent' | 'viewer' | 'admin';
  room: string;
  person?: string;
  generation?: number;
}

const SNAPSHOT_MIN_GAP_MS = 1000 / LIMITS.snapshotsPerSecond;
const HOUSEKEEPING_EVERY_MS = 60_000;
const DEFAULT_MODE: RoomMode = 'enforce';

export class Room extends DurableObject<Env> {
  private meta = new Map<string, string>();
  agents!: AgentStore;
  features!: Features;
  budget!: BudgetCounter;
  readonly waits = new WaitRegistry();
  private pipeline!: Pipeline;
  private svc!: RoomServices;
  private roomCtx!: RoomContext;
  private settingsByRepo = new Map<string, ProjectSettings>();
  private eventSeq = 0;
  private roomName = '';
  private snapshotTimer: ReturnType<typeof setTimeout> | null = null;
  private lastSnapshotAt = 0;
  private lastHousekeeping = 0;
  private readonly burst = new Map<string, { start: Millis; count: number }>();
  private readonly messageTimes = new Map<string, Millis[]>();

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    state.blockConcurrencyWhile(async () => this.boot());
  }

  private now = (): Millis => Date.now();

  // ---------------------------------------------------------------------------------------------- boot

  /** Creates the schema if needed and loads everything into memory. Safe to call again after a wipe. */
  private boot(): void {
    const sql = this.ctx.storage.sql;
    sql.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)').toArray();
    sql.exec(`CREATE TABLE IF NOT EXISTS events (
      seq INTEGER PRIMARY KEY, ts INTEGER NOT NULL, type TEXT NOT NULL, actor TEXT, data TEXT NOT NULL)`).toArray();

    this.meta.clear();
    for (const r of sql.exec('SELECT key, value FROM meta').toArray()) this.meta.set(String(r.key), String(r.value));
    if (!this.meta.has('schema_version')) this.setMeta('schema_version', '1');
    if (!this.meta.has('mode')) this.setMeta('mode', DEFAULT_MODE);
    if (!this.meta.has('agent_generation')) this.setMeta('agent_generation', '1');
    if (!this.meta.has('viewer_generation')) this.setMeta('viewer_generation', '1');
    this.roomName = this.meta.get('room') ?? '';

    this.settingsByRepo.clear();
    for (const [k, v] of this.meta) {
      if (!k.startsWith('settings:')) continue;
      try {
        const s = sanitizeSettings(JSON.parse(v));
        if (s) this.settingsByRepo.set(k.slice('settings:'.length), s);
      } catch { /* ignore a corrupt row */ }
    }

    const today = utcDate(this.now());
    this.budget = new BudgetCounter(this.now(), Number(this.meta.get(`budget:${today}`) ?? 0), today);
    this.dropOldBudgetKeys(`budget:${today}`);
    this.lastHousekeeping = this.now();
    this.eventSeq = Number(sql.exec('SELECT COALESCE(MAX(seq), 0) AS m FROM events').toArray()[0]?.m ?? 0);

    this.agents = new AgentStore(sql, this.now);
    this.agents.createSchema();
    this.agents.load();

    this.roomCtx = {
      now: this.now,
      mode: () => this.mode(),
      settings: (repo) => this.resolveSettings(repo),
      agent: (cs) => this.agents.get(cs),
      agents: () => this.agents.all(),
      resolveRepo: (actor, repo) => this.resolveRepo(actor.repo, repo),
      sql,
      emit: (e) => this.emit(e),
    };
    // Every factory gets the same, still-filling Features object; none calls another feature while constructing.
    const features = {} as Features;
    features.locks = createLocks(this.roomCtx, features);
    features.tasks = createTasks(this.roomCtx, features);
    features.messages = createMessages(this.roomCtx, features);
    features.pushes = createPushes(this.roomCtx, features);
    features.snapshot = createSnapshot(this.roomCtx, features);
    this.features = features;

    this.svc = {
      ctx: this.roomCtx,
      features,
      agents: this.agents,
      roomName: () => this.roomName,
      heartbeatMs: () => this.budget.level().heartbeatMs,
      wait: (cs, keys, seconds) => this.waits.park(cs, keys, seconds),
      allowMessage: (cs) => this.allowMessage(cs),
      endAgent: (a) => this.endAgent(a),
      storeSettings: (repo, s) => this.storeSettings(repo, s),
      changed: () => this.scheduleSnapshot(),
    };
    this.pipeline = new Pipeline(this.svc);

    // Over agents are cleaned up before their callsign is reused or their session revived, and at boot.
    this.agents.onRetire = (a, fresh) => this.cleanupEnded(a, fresh);
    this.agents.onDelete = (cs) => this.forgetMessages(cs);
    for (const a of this.agents.all()) if (this.agents.isEnded(a)) this.agents.retire(a);

    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
    this.restoreModeIfNewDay();
  }

  // ---------------------------------------------------------------------------------------------- meta and settings

  private setMeta(key: string, value: string): void {
    if (this.meta.get(key) === value) return;
    this.meta.set(key, value);
    this.ctx.storage.sql.exec('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)', key, value).toArray();
  }

  private delMeta(key: string): void {
    if (!this.meta.delete(key)) return;
    this.ctx.storage.sql.exec('DELETE FROM meta WHERE key = ?', key).toArray();
  }

  mode(): RoomMode {
    const m = this.meta.get('mode');
    return isRoomMode(m) ? m : DEFAULT_MODE;
  }

  private num(key: string): number {
    return Number(this.meta.get(key) ?? 1);
  }

  private storeSettings(repo: string, s: ProjectSettings): void {
    this.settingsByRepo.set(repo, s);
    this.setMeta(`settings:${repo}`, JSON.stringify(s));
  }

  private resolveSettings(repo: string | null): ResolvedSettings {
    const s = repo ? this.settingsByRepo.get(repo) : undefined;
    return Object.freeze({
      requireTask: s?.requireTask ?? DEFAULT_SETTINGS.requireTask,
      advisory: Object.freeze([...(s?.advisory ?? DEFAULT_SETTINGS.advisory)]),
      ignore: Object.freeze([...(s?.ignore ?? DEFAULT_SETTINGS.ignore)]),
    });
  }

  private resolveRepo(own: string | null, repo: string | undefined): string | null {
    if (!repo) return own;
    const r = repo.toLowerCase();
    const known = new Set<string>(this.settingsByRepo.keys());
    for (const a of this.agents.all()) if (a.repo) known.add(a.repo);
    for (const k of known) if (k.toLowerCase() === r) return k;
    const byName = new Set<string>();
    for (const a of this.agents.all()) if (a.repo && a.repoName?.toLowerCase() === r) byName.add(a.repo);
    if (byName.size === 1) return [...byName][0] as string;
    if (byName.size > 1 && own && byName.has(own)) return own;
    return null;
  }

  // ---------------------------------------------------------------------------------------------- events, snapshot

  private emit(e: RoomEvent): void {
    const ts = this.now();
    const seq = ++this.eventSeq;
    const data = {
      text: e.text,
      ...(e.data ? { data: e.data } : {}),
      ...(e.pulse ? { pulse: e.pulse } : {}),
      ...(e.edge ? { edge: e.edge } : {}),
      ...(e.wake ? { wake: e.wake } : {}),
    };
    this.ctx.storage.sql.exec('INSERT INTO events (seq, ts, type, actor, data) VALUES (?,?,?,?,?)', seq, ts, e.type, e.actor, JSON.stringify(data)).toArray();
    if (seq % 50 === 0) this.ctx.storage.sql.exec('DELETE FROM events WHERE seq <= ?', seq - LIMITS.keepEvents).toArray();
    if (e.pulse) {
      const pulse: Pulse = { type: 'pulse', ...e.pulse, at: ts };
      this.broadcast(JSON.stringify(pulse));
    }
    if (e.wake && e.wake.length > 0) this.waits.wake(e.wake);
    this.scheduleSnapshot();
  }

  /** Full snapshot. The Room owns the envelope fields, whatever the SnapshotApi returns for them. */
  snapshotJson(): string {
    const s = this.features.snapshot.build();
    return JSON.stringify({
      ...s, type: 'snapshot', room: this.roomName, mode: this.mode(), now: this.now(),
      usage: { requests: this.budget.requests, cap: LIMITS.dailyRequestCap },
    });
  }

  private broadcast(text: string): void {
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.send(text); } catch { /* a dead socket is cleaned up by its close event */ }
    }
  }

  private scheduleSnapshot(): void {
    if (this.snapshotTimer !== null || this.ctx.getWebSockets().length === 0) return;
    const wait = Math.max(0, this.lastSnapshotAt + SNAPSHOT_MIN_GAP_MS - this.now());
    this.snapshotTimer = setTimeout(() => {
      this.snapshotTimer = null;
      this.lastSnapshotAt = this.now();
      if (this.ctx.getWebSockets().length > 0) this.broadcast(this.snapshotJson());
    }, wait);
  }

  // ---------------------------------------------------------------------------------------------- limits, guard

  private rateLimited(person: string): boolean {
    const now = this.now();
    const b = this.burst.get(person);
    if (!b || now - b.start >= 1000) {
      this.burst.set(person, { start: now, count: 1 });
      return false;
    }
    b.count += 1;
    return b.count > LIMITS.requestsPerSecondBurstPerPerson;
  }

  private allowMessage(callsign: string): boolean {
    const now = this.now();
    const times = (this.messageTimes.get(callsign) ?? []).filter((t) => now - t < 60_000);
    if (times.length >= LIMITS.messagesPerMinutePerSender) {
      this.messageTimes.set(callsign, times);
      return false;
    }
    times.push(now);
    this.messageTimes.set(callsign, times);
    return true;
  }

  private announce(text: string): void {
    this.features.messages.notify('*', text);
  }

  /** Budget guard (§16): count the request, restore a guard-set mode after midnight, switch to warn at 95%. */
  private onRequest(): void {
    const { rolledOver } = this.budget.record(this.now());
    this.persistBudget(rolledOver);
    this.restoreModeIfNewDay();
    const today = this.budget.date;
    if (this.budget.level().warn && this.mode() === 'enforce' && this.meta.get('guard_switch_date') !== today) {
      this.setMeta('mode_by_guard', 'enforce');
      this.setMeta('guard_switch_date', today);
      this.setMeta('mode', 'warn');
      this.emit({ type: 'mode.guard', actor: null, text: 'Daily request budget is almost used: room switched to warn mode' });
      this.announce('Hivemind is close to its daily request budget. Heartbeats are off and the room switched to warn mode: locks are heads-up only until the budget resets at 00:00 UTC.');
    }
  }

  /**
   * Writes the counter on every request (one small in-DO SQLite row), so an eviction can't lose counts. setMeta skips
   * the write when the value is unchanged. Old days' keys are dropped on rollover and at boot.
   */
  private persistBudget(dropOld: boolean): void {
    const key = `budget:${this.budget.date}`;
    this.setMeta(key, String(this.budget.requests));
    this.budget.dirty = false;
    if (dropOld) this.dropOldBudgetKeys(key);
  }

  private dropOldBudgetKeys(keep: string): void {
    for (const k of [...this.meta.keys()]) if (k.startsWith('budget:') && k !== keep) this.delMeta(k);
  }

  private restoreModeIfNewDay(): void {
    const today = utcDate(this.now());
    const replaced = this.meta.get('mode_by_guard');
    if (replaced === undefined || this.meta.get('guard_switch_date') === today) return;
    this.delMeta('mode_by_guard');
    if (this.mode() === 'warn' && isRoomMode(replaced)) {
      this.setMeta('mode', replaced);
      this.emit({ type: 'mode.restored', actor: null, text: `Daily budget reset: room mode restored to ${replaced}` });
      this.announce(`The daily request budget has reset. Room mode is back to ${replaced}.`);
    }
  }

  private afterRequest(): void {
    const now = this.now();
    this.agents.flush();
    if (now - this.lastHousekeeping >= HOUSEKEEPING_EVERY_MS) {
      this.lastHousekeeping = now;
      this.dropOldBudgetKeys(`budget:${this.budget.date}`);
      for (const a of this.agents.reap().newlyEnded) this.cleanupEnded(a);
      this.pruneSettings();
    }
  }

  /** Settings of repos that no agent has been seen in for 24 hours are dropped. */
  private pruneSettings(): void {
    const cutoff = this.now() - LIMITS.deleteEndedAfterMs;
    const live = new Set<string>();
    for (const a of this.agents.all()) if (a.repo && a.lastEvent >= cutoff) live.add(a.repo);
    for (const repo of [...this.settingsByRepo.keys()]) {
      if (live.has(repo)) continue;
      this.settingsByRepo.delete(repo);
      this.delMeta(`settings:${repo}`);
    }
  }

  // ---------------------------------------------------------------------------------------------- agents

  private endAgent(a: AgentRecord): void {
    if (this.agents.end(a)) this.cleanupEnded(a);
  }

  /** §9 rule 8 and §10: an ended agent loses its locks, and its tasks return to open. */
  private cleanupEnded(a: AgentRecord, announce = true): void {
    this.features.locks.releaseAll(a.callsign);
    this.features.tasks.onAgentEnded(a.callsign);
    this.forgetMessages(a.callsign);
    if (announce) this.emit({ type: 'agent.ended', actor: a.callsign, text: `${a.callsign} ended` });
  }

  /** The messages feature may offer forget(callsign): drop direct messages and delivered state of a gone callsign. */
  private forgetMessages(callsign: string): void {
    this.features.messages.forget(callsign);
  }

  // ---------------------------------------------------------------------------------------------- requests

  override async fetch(request: Request): Promise<Response> {
    const claims = this.readClaims(request);
    if (!claims) return errorResponse('bad request', 400);
    const url = new URL(request.url);
    try {
      this.onRequest();
      if (claims.room && this.roomName !== claims.room) {
        this.roomName = claims.room;
        this.setMeta('room', claims.room);
      }
      if (claims.kind === 'agent') {
        if (claims.generation !== this.num('agent_generation') || this.meta.has(`revoked:${claims.person}`)) {
          return errorResponse('token revoked', 401);
        }
        if (this.rateLimited(claims.person as string)) return errorResponse('too many requests', 429, { 'retry-after': '1' });
      } else if (claims.kind === 'viewer' && claims.generation !== this.num('viewer_generation')) {
        return errorResponse('token revoked', 401);
      }
      return await this.route(url.pathname, request, claims);
    } catch (e) {
      if (e instanceof HttpError) return errorResponse(e.message, e.status);
      return errorResponse('internal error', 500);
    } finally {
      this.afterRequest();
    }
  }

  private readClaims(request: Request): InternalClaims | null {
    try {
      const raw = request.headers.get('x-hm-claims');
      const c = raw ? (JSON.parse(raw) as InternalClaims) : null;
      return c && (c.kind === 'agent' || c.kind === 'viewer' || c.kind === 'admin') ? c : null;
    } catch {
      return null;
    }
  }

  private async body(request: Request): Promise<Record<string, unknown>> {
    let b: unknown;
    try { b = await request.json(); } catch { throw new HttpError(400, 'invalid JSON'); }
    if (!isObj(b)) throw new HttpError(400, 'body must be a JSON object');
    return b;
  }

  private async route(path: string, request: Request, claims: InternalClaims): Promise<Response> {
    const method = request.method;
    const needAgent = (): string => {
      if (claims.kind !== 'agent') throw new HttpError(401, 'agent token required');
      return claims.person as string;
    };
    switch (path) {
      case '/hook': {
        const person = needAgent();
        if (method !== 'POST') throw new HttpError(405, 'method not allowed');
        const parsed = parseHookRequest(await this.body(request));
        if (typeof parsed === 'string') throw new HttpError(400, parsed);
        const res: HookResponse = this.pipeline.handleHook(person, parsed);
        return json(res);
      }
      case '/mcp':
        return handleMcp(this.svc, needAgent(), request);
      case '/whoami': {
        const person = needAgent();
        const res: WhoamiResponse = { room: this.roomName, person, mode: this.mode() };
        return json(res);
      }
      case '/mode': {
        const person = needAgent();
        if (method !== 'POST') throw new HttpError(405, 'method not allowed');
        const b = (await this.body(request)) as Partial<ModeRequest>;
        if (!isRoomMode(b.mode)) throw new HttpError(400, 'mode must be enforce, warn or off');
        // A mode set by a teammate always wins over the budget guard's, even when it names the current mode.
        const changed = this.mode() !== b.mode;
        this.setMeta('mode', b.mode);
        this.delMeta('mode_by_guard');
        if (changed) {
          this.emit({ type: 'mode.changed', actor: person, text: `${person} set the room mode to ${b.mode}` });
          this.announce(`Room mode is now ${b.mode} (set by ${person}).`);
        }
        const res: ModeResponse = { mode: b.mode };
        return json(res);
      }
      case '/unlock': {
        const person = needAgent();
        if (method !== 'POST') throw new HttpError(405, 'method not allowed');
        return json(this.unlock(person, (await this.body(request)) as Partial<UnlockRequest>));
      }
      case '/ws':
        if (claims.kind !== 'viewer') throw new HttpError(401, 'viewer token required');
        return this.upgrade(request);
      default:
        if (path.startsWith('/admin/') && claims.kind === 'admin') return this.admin(path, request);
        throw new HttpError(404, 'not found');
    }
  }

  private unlock(person: string, b: Partial<UnlockRequest> & { path?: unknown; agent?: unknown }): UnlockResponse {
    const hasPath = b.path !== undefined;
    const hasAgent = b.agent !== undefined;
    if (hasPath === hasAgent) throw new HttpError(400, 'give exactly one of path or agent');
    let released;
    let what: string;
    let note = '';
    if (hasPath) {
      const p = b.path as { repo?: unknown; path?: unknown };
      if (!isObj(p) || typeof p.repo !== 'string' || typeof p.path !== 'string' || !p.path) throw new HttpError(400, 'path needs repo and path');
      const canon = canonicalPath(p.path);
      if (!canon) throw new HttpError(400, 'path must be repo-relative and stay inside the repo');
      released = this.features.locks.unlockPath(p.repo, canon);
      what = canon;
      const extra = released.filter((l) => l.path.toLowerCase() !== canon.toLowerCase());
      if (extra.length > 0) {
        note = `Also dropped ${extra.map((l) => `${l.kind} lock ${l.path} (held by ${l.holder})`).join(', ')}.`;
      }
    } else {
      if (typeof b.agent !== 'string' || !b.agent) throw new HttpError(400, 'agent must be a callsign');
      released = this.features.locks.holdings(b.agent);
      this.features.locks.releaseAll(b.agent);
      what = `all locks of ${b.agent}`;
    }
    this.emit({ type: 'unlock', actor: null, text: `${person} unlocked ${what} (${released.length} released)`, data: { released: released.map((l) => l.path) } });
    this.announce(`Emergency unlock by ${person}: ${what}. ${released.length} lock${released.length === 1 ? '' : 's'} released.${note ? ` ${note}` : ''} Re-check before editing.`);
    return note ? { released, note } : { released };
  }

  private upgrade(request: Request): Response {
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') throw new HttpError(426, 'expected a WebSocket upgrade');
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server);
    server.send(this.snapshotJson());
    return new Response(null, { status: 101, webSocket: client, headers: { 'sec-websocket-protocol': 'hivemind' } });
  }

  override webSocketMessage(_ws: WebSocket, _message: string | ArrayBuffer): void {
    // View-only: nothing to read. Ping/pong is answered automatically.
  }

  override webSocketClose(ws: WebSocket, code: number): void {
    try { ws.close(code >= 1000 && code < 1015 && code !== 1005 && code !== 1006 ? code : 1000, 'closing'); } catch { /* already closed */ }
  }

  override webSocketError(ws: WebSocket): void {
    try { ws.close(1011, 'error'); } catch { /* already closed */ }
  }

  private closeViewers(reason: string): void {
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.close(1008, reason); } catch { /* already closed */ }
    }
  }

  // ---------------------------------------------------------------------------------------------- admin

  private async admin(path: string, request: Request): Promise<Response> {
    if (request.method !== 'POST') throw new HttpError(405, 'method not allowed');
    switch (path) {
      case '/admin/init':
        return json({ agentGeneration: this.num('agent_generation'), viewerGeneration: this.num('viewer_generation') });
      case '/admin/invite': {
        const b = await this.body(request);
        if (typeof b.person !== 'string' || !PERSON_NAME_RE.test(b.person)) throw new HttpError(400, 'invalid person name');
        if (this.meta.has(`revoked:${b.person}`)) {
          throw new HttpError(409, 'this person was revoked; rotate the agent tokens to start over');
        }
        return json({ generation: this.num('agent_generation') });
      }
      case '/admin/revoke': {
        const b = await this.body(request);
        const hasPerson = b.person !== undefined;
        const hasRotate = b.rotate !== undefined;
        if (hasPerson === hasRotate) throw new HttpError(400, 'give exactly one of person or rotate');
        if (hasPerson) {
          if (typeof b.person !== 'string' || !PERSON_NAME_RE.test(b.person)) throw new HttpError(400, 'invalid person name');
          this.setMeta(`revoked:${b.person}`, String(this.now()));
          for (const a of this.agents.all()) if (a.person === b.person) this.endAgent(a);
          this.emit({ type: 'token.revoked', actor: null, text: `${b.person}'s token was revoked` });
          return json({});
        }
        if (b.rotate === 'agents') {
          this.setMeta('agent_generation', String(this.num('agent_generation') + 1));
          for (const k of [...this.meta.keys()]) if (k.startsWith('revoked:')) this.delMeta(k);
          for (const a of this.agents.all()) this.endAgent(a);
          this.emit({ type: 'token.rotated', actor: null, text: 'Agent tokens were rotated' });
          return json({});
        }
        if (b.rotate === 'viewer') {
          this.setMeta('viewer_generation', String(this.num('viewer_generation') + 1));
          this.closeViewers('viewer token rotated');
          return json({ viewerGeneration: this.num('viewer_generation') });
        }
        throw new HttpError(400, 'rotate must be agents or viewer');
      }
      case '/admin/delete': {
        this.wipe();
        return json({ deleted: true });
      }
      default:
        throw new HttpError(404, 'not found');
    }
  }

  /** Deletes all room data. Token generations only go up, so tokens from before the delete stay dead. */
  private wipe(): void {
    const agentGen = this.num('agent_generation') + 1;
    const viewerGen = this.num('viewer_generation') + 1;
    this.closeViewers('room deleted');
    this.waits.cancelAll();
    if (this.snapshotTimer !== null) {
      clearTimeout(this.snapshotTimer);
      this.snapshotTimer = null;
    }
    const sql = this.ctx.storage.sql;
    const tables = sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'").toArray();
    for (const t of tables) sql.exec(`DELETE FROM "${String(t.name).replace(/"/g, '""')}"`).toArray();
    this.burst.clear();
    this.messageTimes.clear();
    this.boot();
    this.setMeta('agent_generation', String(agentGen));
    this.setMeta('viewer_generation', String(viewerGen));
  }
}
