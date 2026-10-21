import { describe, expect, it } from 'vitest';
import { deriveState } from './state';

const MIN = 60_000;
const now = 1_000_000_000_000;

describe('deriveState', () => {
  it('is working when recently active', () => {
    expect(deriveState({ lastEvent: now - 5_000, idleSince: null, endedAt: null }, now)).toEqual({
      state: 'working', silenceMs: 5_000, takeable: false,
    });
  });

  it('stays working between 2 and 10 minutes of silence', () => {
    expect(deriveState({ lastEvent: now - 9 * MIN, idleSince: null, endedAt: null }, now).state).toBe('working');
  });

  it('is quiet after 10 minutes and takeable after 15', () => {
    expect(deriveState({ lastEvent: now - 10 * MIN, idleSince: null, endedAt: null }, now)).toMatchObject({ state: 'quiet', takeable: false });
    expect(deriveState({ lastEvent: now - 15 * MIN, idleSince: null, endedAt: null }, now)).toMatchObject({ state: 'quiet', takeable: true });
  });

  it('is idle after Stop, takeable after 15 minutes of silence', () => {
    const lastEvent = now - 14 * MIN;
    expect(deriveState({ lastEvent, idleSince: lastEvent, endedAt: null }, now)).toMatchObject({ state: 'idle', takeable: false });
    expect(deriveState({ lastEvent: now - 16 * MIN, idleSince: now - 16 * MIN, endedAt: null }, now)).toMatchObject({ state: 'idle', takeable: true });
  });

  it('ignores an idle mark older than the last event', () => {
    expect(deriveState({ lastEvent: now - 1_000, idleSince: now - 5_000, endedAt: null }, now).state).toBe('working');
  });

  it('is ended after SessionEnd or 12 hours of silence', () => {
    expect(deriveState({ lastEvent: now, idleSince: null, endedAt: now }, now).state).toBe('ended');
    expect(deriveState({ lastEvent: now - 12 * 60 * MIN, idleSince: null, endedAt: null }, now).state).toBe('ended');
  });
});
