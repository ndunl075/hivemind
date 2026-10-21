import { describe, expect, it } from 'vitest';
import { canonicalPath } from './util';

describe('canonicalPath', () => {
  it('resolves dots and separators', () => {
    expect(canonicalPath('src/./a//b.ts')).toBe('src/a/b.ts');
    expect(canonicalPath('src/x/../a.ts')).toBe('src/a.ts');
    expect(canonicalPath('.\\src\\a.ts')).toBe('src/a.ts');
    expect(canonicalPath('src/auth/')).toBe('src/auth/');
    expect(canonicalPath('.')).toBe('');
  });
  it('rejects absolute paths and escapes', () => {
    for (const p of ['/etc/passwd', 'C:/x', 'c:\\x', '../a', 'a/../../b', '\\\\server\\share']) expect(canonicalPath(p), p).toBeNull();
  });
});
