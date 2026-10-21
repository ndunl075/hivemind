import { describe, expect, it } from 'vitest';
import { jaccard, normalizeTitle, titleWords } from './similarity';

describe('title similarity', () => {
  it('normalizes case, punctuation and stop words', () => {
    expect(normalizeTitle('Add the Login-Page!')).toBe('add login page');
    expect(titleWords('Fix: the bug in a form')).toEqual(['fix', 'bug', 'form']);
    expect(normalizeTitle('THE')).toBe('the'); // only stop words: falls back to plain text
  });

  it('scores equal normalized titles 1 and disjoint titles 0', () => {
    expect(jaccard('Build login page', 'build   LOGIN, page.')).toBe(1);
    expect(jaccard('alpha beta', 'gamma delta')).toBe(0);
    expect(jaccard('', 'alpha')).toBe(0);
  });

  it('computes the Jaccard overlap of the word sets', () => {
    expect(jaccard('alpha beta gamma delta', 'alpha beta gamma delta epsilon')).toBeCloseTo(0.8);
    expect(jaccard('alpha beta gamma', 'alpha beta gamma delta')).toBeCloseTo(0.75);
  });
});
