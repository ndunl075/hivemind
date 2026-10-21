import { describe, expect, it } from 'vitest';
import { ago, percent, plural, shortDuration, truncate } from './format';

describe('format', () => {
  it('picks the coarsest unit', () => {
    expect(shortDuration(4_000)).toBe('4s');
    expect(shortDuration(59_999)).toBe('59s');
    expect(shortDuration(14 * 60_000)).toBe('14m');
    expect(shortDuration(3 * 3_600_000 + 5)).toBe('3h');
    expect(shortDuration(50 * 3_600_000)).toBe('2d');
    expect(shortDuration(-5)).toBe('0s');
  });
  it('writes relative ages', () => {
    expect(ago(400)).toBe('just now');
    expect(ago(4_000)).toBe('4s ago');
  });
  it('computes percent and plurals', () => {
    expect(percent(12_840, 100_000)).toBe(13);
    expect(percent(5, 0)).toBe(0);
    expect(percent(500, 100)).toBe(100);
    expect(plural(1, 'agent')).toBe('1 agent');
    expect(plural(5, 'agent')).toBe('5 agents');
  });
  it('truncates on code points', () => {
    expect(truncate('short', 10)).toBe('short');
    expect(truncate('abcdefghij', 5)).toBe('abcd…');
  });
});
