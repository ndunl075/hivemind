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
