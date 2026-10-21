/**
 * Budget guard (ARCHITECTURE.md §16). Counts Room requests per UTC day and maps the count to a heartbeat
 * interval. The Room applies the side effects (switching to warn, restoring at midnight).
 */
import { LIMITS } from '../../shared/contracts';
import { utcDate } from './util';

export interface GuardLevel {
  heartbeatMs: number;
  /** True at or above 95% of the cap: heartbeats off and the room switches to warn. */
  warn: boolean;
}

export function guardLevel(requests: number, cap: number = LIMITS.dailyRequestCap): GuardLevel {
  const ratio = requests / cap;
  if (ratio >= LIMITS.guardWarnAt) return { heartbeatMs: 0, warn: true };
  if (ratio >= LIMITS.guardSlowerAt) return { heartbeatMs: LIMITS.guardSlowerHeartbeatMs, warn: false };
  if (ratio >= LIMITS.guardSlowAt) return { heartbeatMs: LIMITS.guardSlowHeartbeatMs, warn: false };
  return { heartbeatMs: LIMITS.heartbeatMs, warn: false };
}

export class BudgetCounter {
  date: string;
  requests: number;
  dirty = false;

  constructor(now: number, requests = 0, date?: string) {
    this.date = date ?? utcDate(now);
    this.requests = requests;
  }

  /** Counts one request. Returns true if the UTC day rolled over (the counter was reset first). */
  record(now: number): { rolledOver: boolean } {
    const today = utcDate(now);
    let rolledOver = false;
    if (today !== this.date) {
      this.date = today;
      this.requests = 0;
      rolledOver = true;
    }
    this.requests += 1;
    this.dirty = true;
    return { rolledOver };
  }

  level(): GuardLevel {
    return guardLevel(this.requests);
  }
}
