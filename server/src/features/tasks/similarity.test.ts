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
    expect(jaccard(alice, cara)).toBeLessThan(0.8);
    expect(similarity(alice, cara)).toBeGreaterThan(0.5);
  });

  it('treats plural and tense variants of one title as a duplicate', () => {
    expect(jaccard('Add discounts to checkout', 'Adding discount to the checkout')).toBeGreaterThanOrEqual(0.8);
    expect(jaccard('Parse strings', 'Parse string')).toBe(1);
    expect(stem('speeds')).toBe(stem('speed'));
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

  it('opposite-verb titles are not duplicates (they may still be similar)', () => {
    for (const [a, b] of [
      ['Add v2 API', 'Fix v2 API'], ['Add React 18 hooks', 'Fix React 18 hooks'], ['Fix SAVE10', 'Add SAVE10'],
      ['Add HTTP2', 'Fix HTTP2'], ['Add login page', 'Fix login page'],
    ] as const) {
      expect(jaccard(a, b)).toBeLessThan(0.8);
      expect(similarity(a, b)).toBeGreaterThanOrEqual(0.2);
    }
  });

  it('bare numbers are not rare tokens, but #12 and v2 are', () => {
    expect(similarity('Fix 3 failing tests in auth', 'Add 3 columns to users table')).toBeLessThan(0.2);
    expect(similarity('Update copyright to 2026', 'Fix timezone bug in 2026 report generator')).toBeLessThan(0.2);
    expect(similarity('Revisit #12 wording', 'Ship #12 hotfix')).toBeGreaterThanOrEqual(0.3);
    expect(similarity('Revisit docs for v2', 'Ship v2 hotfix')).toBeGreaterThanOrEqual(0.3);
  });

  it('matches identifiers however their case is written', () => {
    expect(similarity('Add OAuth2 login', 'Add oauth2 login')).toBeGreaterThan(0.5);
    expect(similarity('Fix GitHub webhook', 'Fix github webhook')).toBeGreaterThan(0.5);
    expect(similarity('Port JavaScript parser', 'Port javascript parser')).toBeGreaterThan(0.5);
  });
});
