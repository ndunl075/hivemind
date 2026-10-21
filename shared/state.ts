/**
 * Agent state from timestamps (ARCHITECTURE.md §5). Pure; used by the server and the dashboard
 * so they can never disagree. Architect-owned.
 */
import { LIMITS, type AgentState, type Millis } from './contracts';

export interface StateInput {
  lastEvent: Millis;
  idleSince: Millis | null;
  endedAt: Millis | null;
}

export interface DerivedState {
  state: AgentState;
  /** Time since the last hook event. */
  silenceMs: number;
  /** Idle or quiet with at least LIMITS.takeableAfterMs of silence. */
  takeable: boolean;
}

export function deriveState(agent: StateInput, now: Millis): DerivedState {
  const silenceMs = Math.max(0, now - agent.lastEvent);
  if (agent.endedAt !== null || silenceMs >= LIMITS.endedAfterMs) {
    return { state: 'ended', silenceMs, takeable: false };
  }
  const idle = agent.idleSince !== null && agent.idleSince >= agent.lastEvent;
  const state: AgentState = idle ? 'idle' : silenceMs >= LIMITS.quietAfterMs ? 'quiet' : 'working';
  const takeable = state !== 'working' && silenceMs >= LIMITS.takeableAfterMs;
  return { state, silenceMs, takeable };
}
