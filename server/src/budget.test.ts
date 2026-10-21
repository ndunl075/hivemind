import { describe, expect, it } from 'vitest';
import { LIMITS } from '../../shared/contracts';
import { BudgetCounter, guardLevel } from './budget';

describe('guardLevel', () => {
  const cap = LIMITS.dailyRequestCap;
  it('steps through the thresholds', () => {
    expect(guardLevel(0)).toEqual({ heartbeatMs: 15_000, warn: false });
    expect(guardLevel(cap * 0.6 - 1).heartbeatMs).toBe(15_000);
    expect(guardLevel(cap * 0.6).heartbeatMs).toBe(30_000);
    expect(guardLevel(cap * 0.8 - 1).heartbeatMs).toBe(30_000);
    expect(guardLevel(cap * 0.8).heartbeatMs).toBe(60_000);
    expect(guardLevel(cap * 0.95 - 1)).toEqual({ heartbeatMs: 60_000, warn: false });
    expect(guardLevel(cap * 0.95)).toEqual({ heartbeatMs: 0, warn: true });
  });
});

describe('BudgetCounter', () => {
  it('resets when the UTC day changes', () => {
    const c = new BudgetCounter(Date.parse('2026-10-21T23:59:59Z'), 500);
    expect(c.record(Date.parse('2026-10-21T23:59:59Z')).rolledOver).toBe(false);
    expect(c.requests).toBe(501);
    expect(c.record(Date.parse('2026-10-22T00:00:00Z')).rolledOver).toBe(true);
    expect(c.requests).toBe(1);
  });
});
