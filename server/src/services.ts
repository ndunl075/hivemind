/** What the Room offers to the pipeline and the MCP layer. Kept in its own file so they don't import the Room. */
import type { Actor, AgentRecord, Features, RoomContext, WakeKey } from '../../shared/contracts';
import type { AgentStore } from './agents';
import type { WaitResult } from './waits';

export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export interface RoomServices {
  ctx: RoomContext;
  features: Features;
  agents: AgentStore;
  roomName(): string;
  /** Current heartbeat interval from the budget guard (0 = off). */
  heartbeatMs(): number;
  /** Parks the caller until one of the keys is woken or `seconds` (at most 45) pass. */
  wait(callsign: string, keys: WakeKey[], seconds: number): Promise<WaitResult>;
  /** Per-sender message rate limit (10 a minute). Counts the attempt when it returns true. */
  allowMessage(callsign: string): boolean;
  /** Ends an agent: marks it ended, releases its locks, returns its tasks. */
  endAgent(agent: AgentRecord): void;
  /** Stores per-repo settings received on /hook. */
  /** Something the dashboard shows has changed: schedule a snapshot. */
  changed(): void;
  storeSettings(repo: string, settings: import('../../shared/contracts').ProjectSettings): void;
}

export function actorOf(a: AgentRecord): Actor {
  return { callsign: a.callsign, person: a.person, kind: a.kind, repo: a.repo, checkout: a.checkout };
}
