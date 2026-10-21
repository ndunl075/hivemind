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
const MAX_STARSTAR = 8; // `**` segments per pattern; a pattern with more never matches
const MAX_PATTERN_SEGMENTS = 32;
const MAX_PATH_SEGMENTS = 64; // deeper paths are matched by their first 64 segments
const MAX_PATH_CHARS = 1024;
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
    const raw = p.toLowerCase().split('/').filter((s) => s !== '');
    // `**/**` is `**`: runs collapse, so the matcher never has to try the ways of splitting a path between them.
    const segments = raw.filter((seg, i) => !(seg === '**' && raw[i - 1] === '**'));
    // "Everything under" needs at least one segment: a trailing `**` is `*` then `**` (path segments are never empty).
    if (segments[segments.length - 1] === '**' && segments.length > 1 && segments[segments.length - 2] !== '**') segments.splice(segments.length - 1, 0, '*');
    else if (segments.length === 1 && segments[0] === '**') segments.unshift('*');
    const stars = segments.filter((seg) => seg === '**').length;
    if (segments.length > 0 && segments.length <= MAX_PATTERN_SEGMENTS && stars <= MAX_STARSTAR) out = segments;
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

/**
 * Whole path against the pattern's segments. `**` is the any-number-of-segments wildcard, so this is the classic
 * greedy wildcard match with a single backtrack point (the last `**`): O(segments * pattern segments), no recursion.
 * Taking the earliest match for each part between two `**` is always safe, which is why one backtrack point suffices.
 */
function pathMatch(pat: string[], text: string[]): boolean {
  let p = 0;
  let t = 0;
  let star = -1;
  let mark = 0;
  while (t < text.length) {
    const seg = pat[p];
    if (seg === '**') {
      star = p++;
      mark = t;
    } else if (seg !== undefined && segmentMatch(seg, text[t] as string)) {
      p++;
      t++;
    } else if (star >= 0) {
      p = star + 1;
      t = ++mark;
    } else {
      return false;
    }
  }
  while (pat[p] === '**') p++;
  return p === pat.length;
}

/** The segments of a path as the matcher sees them: lowercased, bounded in length and depth. */
function segmentsOf(path: string): string[] {
  const bounded = path.length > MAX_PATH_CHARS ? path.slice(0, MAX_PATH_CHARS) : path;
  return bounded.toLowerCase().split('/', MAX_PATH_SEGMENTS + 1).filter((s) => s !== '').slice(0, MAX_PATH_SEGMENTS);
}

/** True when `path` (repo-relative, POSIX) matches the glob. */
export function globMatch(pattern: string, path: string): boolean {
  const pat = compile(pattern);
  if (pat === null) return false;
  return pathMatch(pat, segmentsOf(path));
}

/** True when `path` matches any pattern. At most the first 100 patterns count. */
export function matchesAny(patterns: readonly string[], path: string): boolean {
  const n = Math.min(patterns.length, MAX_PATTERNS);
  let segments: string[] | null = null;
  for (let i = 0; i < n; i++) {
    const pat = compile(patterns[i] as string);
    if (pat === null) continue;
    segments ??= segmentsOf(path);
    if (pathMatch(pat, segments)) return true;
  }
  return false;
}
