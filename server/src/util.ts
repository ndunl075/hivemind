import type { Millis } from '../../shared/contracts';

/** "12s", "3m", "2h". */
export function ageText(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h`;
}

export function agoText(now: Millis, at: Millis): string {
  return `${ageText(now - at)} ago`;
}

/** Strip control characters (keeps \n and \t) and cap the length. */
export function cleanText(text: string, maxChars: number): string {
  // eslint-disable-next-line no-control-regex
  const stripped = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
  return stripped.length > maxChars ? stripped.slice(0, maxChars) : stripped;
}

export function utcDate(ms: Millis): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function json(body: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

export function errorResponse(error: string, status: number, headers?: Record<string, string>): Response {
  return json({ error }, status, headers);
}

/** SQL helper: always drains the cursor so writes execute eagerly. */
export function rows(cursor: { toArray(): Record<string, unknown>[] }): Record<string, unknown>[] {
  return cursor.toArray();
}

/**
 * Canonical repo-relative POSIX path: backslashes become '/', '.' and empty segments vanish, '..' pops a segment.
 * Returns null for absolute paths (leading '/' or a backslash, a drive letter) and for paths that escape the repo.
 * A trailing '/' (a folder) is kept. '.' alone canonicalises to ''.
 */
export function canonicalPath(raw: string): string | null {
  const p = raw.replace(/\\/g, '/');
  if (p.startsWith('/') || /^[A-Za-z]:/.test(p) || p.includes('\0')) return null;
  const out: string[] = [];
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (out.length === 0) return null;
      out.pop();
    } else {
      out.push(seg);
    }
  }
  const joined = out.join('/');
  return joined !== '' && p.endsWith('/') ? `${joined}/` : joined;
}
