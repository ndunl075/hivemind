/**
 * The small built-in glob matcher for `advisory` and `ignore` (ARCHITECTURE.md §9 "Settings"). No dependency, and no
 * regular expressions: patterns come from a committed file that teammates edit, so matching must stay polynomial.
 *
 * Patterns are repo-relative POSIX globs, matched against the whole path, case-insensitively:
 *   `*`   any characters within one path segment (including none)
 *   `?`   exactly one character within a segment
 *   `**`  as a whole segment: any number of segments, including none
 * A pattern is anchored at the repo root: `package.json` does not match `sub/package.json`, but a pattern that starts
 * with `**` and a slash (like the default lockfile entries) does, and also matches the file at the root.
 * A trailing `/` means "everything under": `dist/` is `dist/**`. `a/**` matches everything under `a`, not `a` itself.
 * A leading `/` or `./` is ignored. Backslashes are path separators. Anything else is literal, including `[` and `{`.
 */

const MAX_PATTERN_CHARS = 200;
const MAX_PATTERNS = 100;
const CACHE_MAX = 500;

/** Lowercased segments of a pattern; '**' is the any-segments wildcard. Null when the pattern can never match. */
type Compiled = string[] | null;

const cache = new Map<string, Compiled>();

function compile(pattern: string): Compiled {
  const hit = cache.get(pattern);
  if (hit !== undefined) return hit;
  let out: Compiled = null;
  if (pattern.length > 0 && pattern.length <= MAX_PATTERN_CHARS) {
    let p = pattern.replace(/\\/g, '/').replace(/^(\.\/)+/, '').replace(/^\/+/, '');
    if (p.endsWith('/')) p += '**';
    const segments = p.toLowerCase().split('/').filter((s) => s !== '');
    if (segments.length > 0) out = segments;
  }
  if (cache.size >= CACHE_MAX) cache.clear();
  cache.set(pattern, out);
  return out;
}

/** One segment against one pattern segment (`*` and `?`). Classic two-pointer match, O(n * m) at worst. */
function segmentMatch(pat: string, text: string): boolean {
  let p = 0;
  let t = 0;
  let star = -1;
  let mark = 0;
  while (t < text.length) {
    const c = pat[p];
    if (c === '*') {
      star = p++;
      mark = t;
    } else if (p < pat.length && (c === '?' || c === text[t])) {
      p++;
      t++;
    } else if (star >= 0) {
      p = star + 1;
      t = ++mark;
    } else {
      return false;
    }
  }
  while (pat[p] === '*') p++;
  return p === pat.length;
}

/** Whole path against the pattern's segments, with `**` handled by memoised recursion: O(patterns * segments). */
function pathMatch(pat: string[], text: string[]): boolean {
  const memo = new Map<number, boolean>();
  const go = (pi: number, ti: number): boolean => {
    const key = pi * (text.length + 1) + ti;
    const seen = memo.get(key);
    if (seen !== undefined) return seen;
    let res: boolean;
    if (pi === pat.length) {
      res = ti === text.length;
    } else if (pat[pi] === '**') {
      // A trailing `**` needs at least one segment; elsewhere it may swallow none.
      res = pi === pat.length - 1 ? ti < text.length : go(pi + 1, ti) || (ti < text.length && go(pi, ti + 1));
    } else {
      res = ti < text.length && segmentMatch(pat[pi] as string, text[ti] as string) && go(pi + 1, ti + 1);
    }
    memo.set(key, res);
    return res;
  };
  return go(0, 0);
}

/** True when `path` (repo-relative, POSIX) matches the glob. */
export function globMatch(pattern: string, path: string): boolean {
  const pat = compile(pattern);
  if (pat === null) return false;
  return pathMatch(pat, path.toLowerCase().split('/').filter((s) => s !== ''));
}

/** True when `path` matches any pattern. At most the first 100 patterns count. */
export function matchesAny(patterns: readonly string[], path: string): boolean {
  const n = Math.min(patterns.length, MAX_PATTERNS);
  for (let i = 0; i < n; i++) {
    if (globMatch(patterns[i] as string, path)) return true;
  }
  return false;
}
