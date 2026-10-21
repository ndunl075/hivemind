/** Title similarity for duplicate detection (ARCHITECTURE.md §10). Pure. */

const STOP_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'to', 'of', 'for', 'in', 'on', 'at', 'by', 'with', 'from', 'into', 'is', 'are', 'be',
  'this', 'that', 'it', 'its', 'as', 'we', 'our',
]);

/** Lowercase, punctuation removed, stop words dropped. */
export function titleWords(title: string): string[] {
  const words = title.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 0 && !STOP_WORDS.has(w));
  return words;
}

/** The normalized title: its words joined by single spaces. */
export function normalizeTitle(title: string): string {
  const words = titleWords(title);
  // A title made only of stop words or symbols still compares by its plain lowercase text.
  return words.length > 0 ? words.join(' ') : title.toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Jaccard overlap of the word sets of two titles, 0 to 1. Equal normalized titles score 1. */
export function jaccard(a: string, b: string): number {
  if (normalizeTitle(a) === normalizeTitle(b)) return 1;
  const x = new Set(titleWords(a));
  const y = new Set(titleWords(b));
  if (x.size === 0 || y.size === 0) return 0;
  let shared = 0;
  for (const w of x) if (y.has(w)) shared++;
  return shared / (x.size + y.size - shared);
}
