import { describe, expect, it } from 'vitest';
import { jaccard, normalizeTitle, similarity, stem, titleWords } from './similarity';

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

describe('differently worded titles', () => {
  const alice = 'Add applyDiscount function with SAVE10 code';
  const cara = 'Add discount code support (SAVE10 example)';

  it('splits identifiers and stems plurals and verb forms', () => {
    expect(titleWords('applyDiscount in parseHTMLString')).toEqual(['apply', 'discount', 'parse', 'html', 'string']);
    expect(stem('discounts')).toBe(stem('discount'));
    expect(stem('adding')).toBe(stem('add'));
    expect(stem('applied')).toBe(stem('apply'));
    expect(stem('class')).toBe('class');
  });

  it('scores the same job worded two ways as similar, but not as an exact duplicate', () => {
    const score = jaccard(alice, cara);
    expect(score).toBeGreaterThan(0.5);
    expect(score).toBeLessThan(0.8);
    expect(similarity(alice, cara)).toBeGreaterThanOrEqual(0.2);
  });

  it('treats plural and tense variants of one title as a duplicate', () => {
    expect(jaccard('Add discounts to checkout', 'Adding discount to the checkout')).toBeGreaterThanOrEqual(0.8);
  });

  it('a shared rare token like SAVE10 is enough to be similar', () => {
    expect(similarity('Document the SAVE10 promo', 'Fix rounding for SAVE10 orders')).toBeGreaterThanOrEqual(0.2);
    expect(similarity('Document the promo', 'Fix rounding for orders')).toBeLessThan(0.2);
  });

  it('does not match clearly different tasks', () => {
    for (const other of ['Add sales tax to cart total()', 'Add login page', 'Fix typo in README', 'Update CI to Node 22']) {
      expect(similarity(other, alice)).toBeLessThan(0.2);
      expect(similarity(other, cara)).toBeLessThan(0.2);
    }
    // sharing only generic words (add, code, function) is at most a weak suggestion, never a duplicate
    expect(similarity('Add retry code function', alice)).toBeLessThan(0.3);
  });
});
