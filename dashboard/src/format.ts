/** Small, pure formatting helpers. */

/** "4s", "14m", "3h", "2d": the coarsest unit that fits. */
export function shortDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/** "4s ago"; under a second reads "just now". */
export function ago(ms: number): string {
  return ms < 1000 ? 'just now' : `${shortDuration(ms)} ago`;
}

export function formatCount(n: number): string {
  return new Intl.NumberFormat('en-US').format(n);
}

export function percent(part: number, whole: number): number {
  if (whole <= 0) return 0;
  return Math.min(100, Math.round((part / whole) * 100));
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${formatCount(n)} ${n === 1 ? one : many}`;
}

/** Cuts text to at most `max` characters, ending in an ellipsis. Works on code points. */
export function truncate(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : `${chars.slice(0, Math.max(0, max - 1)).join('')}…`;
}
