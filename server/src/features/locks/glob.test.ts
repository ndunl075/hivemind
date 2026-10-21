import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../../../../shared/contracts';
import { globMatch, matchesAny } from './glob';

describe('glob matcher (§9 dialect)', () => {
  it('* stays inside one segment', () => {
    expect(globMatch('src/*.ts', 'src/a.ts')).toBe(true);
    expect(globMatch('src/*.ts', 'src/deep/a.ts')).toBe(false);
    expect(globMatch('*.md', 'README.md')).toBe(true);
    expect(globMatch('*.md', 'docs/README.md')).toBe(false);
    expect(globMatch('a*c', 'abc')).toBe(true);
    expect(globMatch('a*c', 'ac')).toBe(true);
    expect(globMatch('a*c', 'a/c')).toBe(false);
  });

  it('** matches any number of segments, including none', () => {
    expect(globMatch('**/package-lock.json', 'package-lock.json')).toBe(true);
    expect(globMatch('**/package-lock.json', 'a/package-lock.json')).toBe(true);
    expect(globMatch('**/package-lock.json', 'a/b/c/package-lock.json')).toBe(true);
    expect(globMatch('**/package-lock.json', 'a/package-lock.json.bak')).toBe(false);
    expect(globMatch('src/**/x.ts', 'src/x.ts')).toBe(true);
    expect(globMatch('src/**/x.ts', 'src/a/b/x.ts')).toBe(true);
    expect(globMatch('dist/**', 'dist/a.js')).toBe(true);
    expect(globMatch('dist/**', 'dist/a/b.js')).toBe(true);
    expect(globMatch('dist/**', 'dist')).toBe(false);
    expect(globMatch('dist/**', 'distant/a.js')).toBe(false);
    expect(globMatch('**', 'anything/at/all')).toBe(true);
  });

  it('? is exactly one character within a segment', () => {
    expect(globMatch('a?c.ts', 'abc.ts')).toBe(true);
    expect(globMatch('a?c.ts', 'ac.ts')).toBe(false);
    expect(globMatch('a?c.ts', 'a/c.ts')).toBe(false);
  });

  it('is anchored at the repo root and case-insensitive', () => {
    expect(globMatch('package.json', 'package.json')).toBe(true);
    expect(globMatch('package.json', 'web/package.json')).toBe(false);
    expect(globMatch('package.json', 'PACKAGE.JSON')).toBe(true);
    expect(globMatch('SRC/Gen/**', 'src/gen/X.ts')).toBe(true);
  });

  it('a trailing slash means everything under, and a leading ./ or / is dropped', () => {
    expect(globMatch('dist/', 'dist/a.js')).toBe(true);
    expect(globMatch('./dist/**', 'dist/a.js')).toBe(true);
    expect(globMatch('/dist/**', 'dist/a.js')).toBe(true);
  });

  it('treats everything else literally', () => {
    expect(globMatch('a.b', 'aXb')).toBe(false);
    expect(globMatch('a+b(c)[d]{e}|f^g$h.ts', 'a+b(c)[d]{e}|f^g$h.ts')).toBe(true);
    expect(globMatch('', 'a')).toBe(false);
    expect(globMatch('x'.repeat(201), 'x'.repeat(201))).toBe(false);
  });

  it('the defaults: lockfiles anywhere, bun.lock* matches bun.lockb', () => {
    expect(matchesAny(DEFAULT_SETTINGS.advisory, 'bun.lockb')).toBe(true);
    expect(matchesAny(DEFAULT_SETTINGS.advisory, 'yarn.lock')).toBe(true);
    expect(matchesAny(DEFAULT_SETTINGS.advisory, 'apps/web/package-lock.json')).toBe(true);
    expect(matchesAny(DEFAULT_SETTINGS.advisory, 'package.json')).toBe(true);
    expect(matchesAny(DEFAULT_SETTINGS.advisory, 'src/index.ts')).toBe(false);
  });

  it('does not backtrack badly on hostile patterns', () => {
    const t = Date.now();
    expect(globMatch('*a*a*a*a*a*a*a*a*a*b', 'a'.repeat(60))).toBe(false);
    expect(globMatch('**/**/**/**/**/x', 'a/'.repeat(40) + 'y')).toBe(false);
    expect(Date.now() - t).toBeLessThan(500);
  });
});
