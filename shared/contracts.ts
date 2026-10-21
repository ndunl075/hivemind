/**
 * Hivemind contracts. Architect-owned and frozen during a wave (ARCHITECTURE.md §20.2).
 *
 * Two kinds of contract live here:
 *  1. Wire types: what crosses the network between the hook, MCP clients, the dashboard and the server.
 *  2. Internal feature interfaces: how server features talk to each other, so Wave 2 slices
 *     can be built in parallel against Wave 1's basic implementations.
 *
 * Types plus a few plain constants (LIMITS, DEFAULT_SETTINGS). Nothing in this file may import a runtime
 * (Node, Workers, DOM). The hook (plain JS, copied to ~/.hivemind/hook/) can't import this file: it keeps its
 * own copy of the LIMITS values it uses, and a test in cli/hook asserts they match.
 */

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

/** Milliseconds since the Unix epoch, server clock. */
export type Millis = number;

/** 'claude-nico', 'codex-ana-2'. */
export type Callsign = string;

/** Root commit SHA of a repo (§12). */
export type RepoId = string;

/** Hash of hostname + checkout path (§4). */
export type CheckoutId = string;

/** Repo-relative POSIX path. Folders end with '/'. */
export type RepoPath = string;

export type AgentKind = 'claude' | 'codex';

export type RoomMode = 'enforce' | 'warn' | 'off';

/** §5 agent states. Derived, never stored. */
export type AgentState = 'working' | 'idle' | 'quiet' | 'ended';

export type TaskStatus = 'open' | 'in_progress' | 'done' | 'dropped';

export type LockKind = 'file' | 'folder';

/** §9 settings from .hivemind/project.json. Missing fields take the defaults in §9. */
export interface ProjectSettings {
  requireTask?: boolean;
  /** Globs (§9 dialect). Never denied, only heads-up. */
  advisory?: string[];
  /** Globs (§9 dialect). Never locked. */
  ignore?: string[];
}

/** Settings with defaults applied. Read-only so a consumer can't change the defaults for everyone. */
export interface ResolvedSettings {
  readonly requireTask: boolean;
  readonly advisory: readonly string[];
  readonly ignore: readonly string[];
}

export const DEFAULT_SETTINGS: ResolvedSettings = Object.freeze({
  requireTask: true,
  advisory: Object.freeze(['package.json', '**/package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock*']),
  ignore: Object.freeze([] as string[]),
});

// ---------------------------------------------------------------------------
// Tuning constants (§5, §6, §8, §11, §16). Change only through the architect.
// ---------------------------------------------------------------------------

export const LIMITS = Object.freeze({
  /** §5: working → quiet after this much silence. */
  quietAfterMs: 10 * 60_000,
  /** §5: idle or quiet holders become takeable after this much silence. */
  takeableAfterMs: 15 * 60_000,
  /** §5: silence after which an agent is ended. */
  endedAfterMs: 12 * 60 * 60_000,
  /** §4: ended agents are deleted after this long. */
  deleteEndedAfterMs: 24 * 60 * 60_000,
  /** §6.2: default heartbeat interval. */
  heartbeatMs: 15_000,
  /** §6.3: hook network timeout. */
  hookTimeoutMs: 1_500,
  /** §6.3: hook network timeout on SessionEnd. */
  sessionEndTimeoutMs: 800,
  /** §6.3: consecutive failures that open the circuit breaker. */
  breakerFailures: 3,
  /** §6.3: how long the open breaker skips the network. */
  breakerOpenMs: 60_000,
  /** §7: longest wait. */
  waitMaxSeconds: 45,
  /** §8.2 */
  maxAgentsPerRoom: 50,
  maxMessageChars: 2_000,
  messagesPerMinutePerSender: 10,
  requestsPerSecondBurstPerPerson: 20,
  /** §4 retention */
  keepMessages: 500,
  keepEvents: 2_000,
  pushTtlMs: 24 * 60 * 60_000,
  /** §12 */
  maxDivergentPaths: 500,
  /** §8.2: dashboard snapshots per second, at most. */
  snapshotsPerSecond: 4,
  /** §16: budget guard thresholds, as a fraction of the daily cap, and the heartbeat intervals they set. */
  dailyRequestCap: 100_000,
  guardSlowAt: 0.6,
  guardSlowHeartbeatMs: 30_000,
  guardSlowerAt: 0.8,
  guardSlowerHeartbeatMs: 60_000,
  guardWarnAt: 0.95,
  /** §6.6 briefing caps. */
  briefingAgents: 8,
  briefingTasks: 5,
  briefingLocks: 8,
  /** §10 duplicates. */
  duplicateJaccard: 0.8,
  similarTasksShown: 3,
  /** §7 inbox(recent: true). */
  inboxRecent: 20,
  /** §14.2: how long message and blocked edges stay on the dashboard. */
  messageEdgeMs: 60_000,
  blockedEdgeMs: 2 * 60_000,
} as const);

// ---------------------------------------------------------------------------
// Tokens (§13)
// ---------------------------------------------------------------------------

/** Parsed from `hm_a.<room>.<person>.<generation>.<signature>`. */
export interface AgentTokenClaims {
  kind: 'agent';
  room: string;
  person: string;
  generation: number;
}

/** Parsed from `hm_v.<room>.<generation>.<signature>`. */
export interface ViewerTokenClaims {
  kind: 'viewer';
  room: string;
  generation: number;
}

// ---------------------------------------------------------------------------
// Hook ↔ server (§6.4): POST /hook
// ---------------------------------------------------------------------------

export type HookEvent =
  | 'SessionStart'
  | 'UserPromptSubmit'
  | 'PreToolUse'
  | 'PostToolUse'
  | 'Stop'
  | 'SessionEnd';

export interface PushedFile {
  path: RepoPath;
  /** Blob SHA of the file in the pushed commit. */
  blob: string;
}

export interface PushReport {
  branch: string;
  /** Commit that carried the files. */
  sha: string;
  files: PushedFile[];
}

/** §12 Git state, sent on SessionStart, UserPromptSubmit, Stop and heartbeats (not while heartbeats are off). */
export interface GitStateReport {
  divergent: RepoPath[];
  /** SessionStart only: divergent files that existed before this agent started. */
  baseline?: RepoPath[];
  /** Name of the comparison point, e.g. 'origin/main', or null if none. */
  upstream: string | null;
  truncated: boolean;
  pushed: PushReport | null;
}

export interface HookRequest {
  v: 1;
  event: HookEvent;
  agent: AgentKind;
  session: string;
  tool?: string;
  repo: RepoId;
  checkout: CheckoutId;
  branch: string | null;
  head: string | null;
  /** Edits only. */
  paths?: RepoPath[];
  git?: GitStateReport | null;
  shellSinceHeartbeat?: boolean;
  /** Contents of .hivemind/project.json when new or changed. */
  settings?: ProjectSettings | null;
  stopActive?: boolean;
  endReason?: string | null;
  /** Length of a just-ended outage, if any. */
  outageMs?: number;
  /** origin URL basename, display only. */
  repoName?: string;
}

export interface LastPush {
  path: RepoPath;
  sha: string;
  blob: string;
  by: Callsign;
  branch: string;
  at: Millis;
}

export interface HookResponse {
  decision: 'allow' | 'deny' | 'block' | 'none';
  reason: string | null;
  context: string | null;
  callsign: Callsign;
  lastPush?: LastPush[];
  /** 0 = heartbeats and Git state off (§16). */
  heartbeatMs: number;
  mode: RoomMode;
}

// ---------------------------------------------------------------------------
// Other HTTP routes (§8.1)
// ---------------------------------------------------------------------------

export interface WhoamiResponse {
  room: string;
  person: string;
  mode: RoomMode;
}

export interface ModeRequest {
  mode: RoomMode;
}

export interface ModeResponse {
  mode: RoomMode;
}

/** Exactly one target. */
export type UnlockRequest =
  | { path: { repo: RepoId; path: RepoPath }; agent?: never }
  | { agent: Callsign; path?: never };

export interface UnlockResponse {
  released: LockView[];
  /** Present when unlocking a file also dropped a covering folder reservation. */
  note?: string;
}

export interface AdminCreateRoomRequest {
  room: string;
}

export interface AdminCreateRoomResponse {
  room: string;
  viewerToken: string;
}

export interface AdminInviteRequest {
  person: string;
}

export interface AdminInviteResponse {
  agentToken: string;
}

export interface AdminRevokeRequest {
  /** Revoke one person, or rotate a whole generation. */
  person?: string;
  rotate?: 'agents' | 'viewer';
}

export interface AdminRevokeResponse {
  /** Present when the viewer generation was rotated. */
  viewerToken?: string;
}

export interface ErrorResponse {
  error: string;
}

// ---------------------------------------------------------------------------
// Views shared by MCP results and the dashboard snapshot
// ---------------------------------------------------------------------------

export interface AgentView {
  callsign: Callsign;
  kind: AgentKind;
  person: string;
  repo: RepoId | null;
  repoName: string | null;
  checkout: CheckoutId | null;
  branch: string | null;
  head: string | null;
  hooked: boolean;
  activity: string | null;
  startedAt: Millis;
  lastEvent: Millis;
  idleSince: Millis | null;
  endedAt: Millis | null;
  outageAt: Millis | null;
  outageMs: number | null;
  /** In-progress task, if any. */
  taskId: number | null;
}

export interface TaskView {
  id: number;
  title: string;
  description: string | null;
  status: TaskStatus;
  owner: Callsign | null;
  createdBy: Callsign;
  dependsOn: number[];
  areas: { repo: RepoId; folder: RepoPath }[];
  note: string | null;
  createdAt: Millis;
  updatedAt: Millis;
}

export interface LockView {
  repo: RepoId;
  path: RepoPath;
  kind: LockKind;
  holder: Callsign;
  checkout: CheckoutId;
  taskId: number | null;
  reason: string | null;
  acquiredAt: Millis;
}

export interface MessageView {
  id: number;
  sender: Callsign | 'hivemind';
  recipient: Callsign | '*';
  text: string;
  createdAt: Millis;
}

export interface ActivityView {
  seq: number;
  ts: Millis;
  type: string;
  actor: Callsign | null;
  /** One-line human-readable summary. */
  text: string;
}

// ---------------------------------------------------------------------------
// Dashboard (§14, §8.2): GET /r/<room>/ws
// ---------------------------------------------------------------------------

export type EdgeKind = 'message' | 'broadcast' | 'blocked' | 'waiting' | 'nearby';

/**
 * Edge direction (§14.2): message A to B is from A to B; blocked A to B means A was denied a file B holds;
 * waiting means A's task depends on B's in-progress task and is drawn from B to A; nearby is undirected.
 */
export interface EdgeView {
  kind: EdgeKind;
  from: Callsign;
  /** Absent for broadcast. */
  to?: Callsign;
  /** File name for 'blocked'. */
  label?: string;
  at: Millis;
}

export interface Snapshot {
  type: 'snapshot';
  room: string;
  mode: RoomMode;
  /** Server time when built, so the client can derive states (§5) with shared/state.ts. */
  now: Millis;
  usage: { requests: number; cap: number };
  agents: AgentView[];
  tasks: TaskView[];
  locks: LockView[];
  edges: EdgeView[];
  activity: ActivityView[];
}

export type PulseKind = 'message' | 'broadcast' | 'denied' | 'push';

export interface Pulse {
  type: 'pulse';
  kind: PulseKind;
  from: Callsign;
  to?: Callsign;
  path?: RepoPath;
  at: Millis;
}

export type DashboardMessage = Snapshot | Pulse;

/** WebSocket subprotocols the dashboard offers: ['hivemind', <viewer token>]. */
export const DASHBOARD_SUBPROTOCOL = 'hivemind';

// ---------------------------------------------------------------------------
// MCP tools (§7). Arguments; `me` is required everywhere except register.
// ---------------------------------------------------------------------------

/**
 * Paths in tool arguments are plain repo-relative paths. `repo` is optional everywhere: it defaults to the
 * caller's current repo (known from its hooks). It may be the repo's display name (origin basename) or its
 * root commit SHA, and is required only when the caller has no repo yet (an MCP-registered agent).
 */
export interface NewTask {
  title: string;
  description?: string;
  /** Folders, e.g. 'src/auth/'. */
  areas?: RepoPath[];
  dependsOn?: number[];
}

export interface ToolArgs {
  status: { me: Callsign };
  task_add: { me: Callsign; tasks: NewTask[]; claim?: boolean; force?: boolean; repo?: string };
  task_claim: { me: Callsign; id: number; take?: boolean; reason?: string };
  task_update: { me: Callsign; id: number; status: 'in_progress' | 'open' | 'done' | 'dropped'; note?: string };
  reserve: { me: Callsign; folders: RepoPath[]; reason?: string; repo?: string };
  release: { me: Callsign; paths?: RepoPath[]; repo?: string };
  take: { me: Callsign; path: RepoPath; reason: string; repo?: string };
  /** 'all' is stored as recipient '*'. */
  post: { me: Callsign; to: Callsign | 'all'; text: string };
  inbox: { me: Callsign; recent?: boolean };
  wait: { me: Callsign; seconds: number; for?: string };
  register: { kind: AgentKind; note?: string; repo?: string };
}

export type ToolName = keyof ToolArgs;

/** Structured results (§7). The MCP layer returns them as JSON text content. */
export interface ToolResults {
  status: {
    you: AgentView;
    mode: RoomMode;
    agents: (AgentView & { state: AgentState; takeable: boolean })[];
    tasks: TaskView[];
    heldByOthers: LockView[];
    yours: LockView[];
    unread: number;
  };
  task_add: {
    created: { id: number; title: string; similar: { id: number; title: string }[] }[];
    duplicates: { title: string; existing: TaskView }[];
    claim?: ToolResults['task_claim'];
  };
  task_claim:
    | { result: 'ok'; task: TaskView; reserved: LockView[] }
    | { result: 'taken'; owner: Callsign; ownerState: AgentState; takeable: boolean }
    | { result: 'waiting'; unfinished: number[] };
  task_update: { task: TaskView };
  reserve: { granted: boolean; conflicts: LockConflict[] };
  release: { released: LockView[]; stillDivergent: RepoPath[] };
  take: { ok: true; lock: LockView } | { ok: false; error: string };
  post: { id: number } | { bounced: true; reason: string };
  inbox: { unread: MessageView[]; recent?: MessageView[] };
  wait: { event: 'message' | 'release' | 'task' | 'timeout'; messages?: MessageView[] };
  register: { callsign: Callsign; enforced: false };
}

// ---------------------------------------------------------------------------
// Internal feature interfaces (§8.2 "Feature boundaries", §20.2)
//
// The Room builds one RoomContext and calls each feature's factory once:
//   export const createLocks: FeatureFactory<'locks'> = (ctx, features) => ({ ... });
// `features` is the same object for every factory; it's complete before the first request, so a factory may
// keep the reference but must not call other features while constructing. Each feature creates its own
// tables (CREATE TABLE IF NOT EXISTS) in its factory through ctx.sql. The Room owns `agents`, `meta`, `events`.
// ---------------------------------------------------------------------------

/** The subset of Durable Object SQL storage that features use, kept runtime-neutral. */
export interface SqlLike {
  exec(query: string, ...bindings: unknown[]): { toArray(): Record<string, unknown>[] };
}

/** An agent as the server holds it: the view plus its session. */
export interface AgentRecord extends AgentView {
  session: string | null;
}

/** Wake-up keys for `wait` (§7): 'message:<callsign>', 'release:<repo>:<path>', 'task:<id>'. */
export type WakeKey = string;

/** Something worth showing or waking on. The Room logs it to `events`, broadcasts it and resolves waits. */
export interface RoomEvent {
  type: string;
  actor: Callsign | null;
  /** One-line summary for the activity feed. */
  text: string;
  data?: Record<string, unknown>;
  pulse?: Omit<Pulse, 'type' | 'at'>;
  edge?: Omit<EdgeView, 'at'>;
  wake?: WakeKey[];
}

export interface RoomContext {
  now(): Millis;
  mode(): RoomMode;
  /** Settings for a repo with defaults applied (§9). */
  settings(repo: RepoId | null): ResolvedSettings;
  agent(callsign: Callsign): AgentRecord | null;
  agents(): AgentRecord[];
  /** Resolves a tool's `repo` argument (display name or root SHA) for a caller; null if unknown. */
  resolveRepo(actor: Actor, repo: string | undefined): RepoId | null;
  sql: SqlLike;
  emit(event: RoomEvent): void;
}

export interface Features {
  locks: LocksApi;
  tasks: TasksApi;
  messages: MessagesApi;
  pushes: PushesApi;
  snapshot: SnapshotApi;
}

export type FeatureFactory<K extends keyof Features> = (ctx: RoomContext, features: Features) => Features[K];

/** What a feature sees of the agent making a request. */
export interface Actor {
  callsign: Callsign;
  person: string;
  kind: AgentKind;
  repo: RepoId | null;
  checkout: CheckoutId | null;
}

export interface LockConflict {
  repo: RepoId;
  path: RepoPath;
  holder: Callsign;
  kind: LockKind;
  taskId: number | null;
  /** Holder's derived state and whether it may be taken (§5). */
  holderState: AgentState;
  takeable: boolean;
}

export interface EditDecision {
  /** False only in enforce mode with conflicts. */
  allow: boolean;
  conflicts: LockConflict[];
  /** Heads-up lines (advisory paths, warn mode). */
  notes: string[];
}

export interface LocksApi {
  /** §9 rules 1, 2, 9–12. All or nothing: takes locks for every path only if allowed. */
  checkEdit(actor: Actor, repo: RepoId, paths: RepoPath[]): EditDecision;
  /** §9 rules 3–5: release by divergence, attribute shell edits, flag conflicts across checkouts. */
  applyGitState(actor: Actor, repo: RepoId, state: GitStateReport, shellSinceHeartbeat: boolean): void;
  /** §9 rule 6. All or nothing. */
  reserve(actor: Actor, folders: { repo: RepoId; folder: RepoPath }[], reason: string | null, taskId: number | null): { granted: boolean; conflicts: LockConflict[] };
  /** Returns released locks. All of the actor's holdings if paths is omitted. */
  release(actor: Actor, paths?: { repo: RepoId; path: RepoPath }[]): LockView[];
  /** §9 rule 7. */
  take(actor: Actor, repo: RepoId, path: RepoPath, reason: string): { ok: true } | { ok: false; error: string };
  /** Task done or dropped: release its folder reservations. */
  releaseForTask(taskId: number): void;
  /** §9 rule 8, and emergency unlock. */
  releaseAll(callsign: Callsign): void;
  /** Emergency unlock of one path. */
  unlockPath(repo: RepoId, path: RepoPath): LockView[];
  holdings(callsign: Callsign): LockView[];
  list(): LockView[];
}

export interface TasksApi {
  /** §10 task gate, called on edits before LocksApi.checkEdit. */
  gate(actor: Actor, settings: ResolvedSettings): { allow: true } | { allow: false; reason: string };
  inProgressFor(callsign: Callsign): TaskView | null;
  /** §10: tasks of ended owners return to open. */
  onAgentEnded(callsign: Callsign): void;
  list(): TaskView[];
}

export interface NotifyOptions {
  /** Only agents in this repo (for push notices). */
  repo?: RepoId;
  /** Never deliver to these. */
  exclude?: Callsign[];
}

export interface MessagesApi {
  /**
   * A notice from 'hivemind' to one agent, or '*' for every active agent (filtered by options).
   * Notices have no agent sender; put the agent the notice is about in options.exclude.
   */
  notify(to: Callsign | '*', text: string, options?: NotifyOptions): void;
  /** Unread messages for a callsign, marked delivered (§11). */
  takeUnread(callsign: Callsign, options?: { directOnly?: boolean }): MessageView[];
  hasUnreadDirect(callsign: Callsign): boolean;
  /** Formats messages for injection into an agent's context (§11). */
  format(messages: MessageView[], now: Millis): string;
  /** Unread count without delivering (for status). */
  unreadCount(callsign: Callsign): number;
  /** Drop direct messages and delivery state for an ended agent before its callsign is reused (§5). */
  forget(callsign: Callsign): void;
}

export interface SnapshotApi {
  build(): Snapshot;
}

/** §12 pushes. */
export interface PushesApi {
  /** Record a push and send the push notice. */
  record(actor: Actor, repo: RepoId, push: PushReport): void;
  /** Latest push per path within 24 hours by someone other than the actor. */
  latest(actor: Actor, repo: RepoId, paths: RepoPath[]): LastPush[];
}

/**
 * Optional on any feature: the Room checks each entry of Features for briefingLines() and joins the lines
 * into the briefing (§6.6). Features derive agent states with deriveState() from shared/state.ts and ctx.now().
 */
export interface BriefingContributor {
  briefingLines(actor: Actor): string[];
}
