/** Title similarity for duplicate detection (ARCHITECTURE.md §10). Pure, deterministic, no I/O. */

const STOP_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'to', 'of', 'for', 'in', 'on', 'at', 'by', 'with', 'from', 'into', 'is', 'are', 'be',
  'this', 'that', 'it', 'its', 'as', 'we', 'our',
]);

/** Words that say little about what a task is about; they count for a third as much as other words. */
const GENERIC_WORDS = new Set([
  'add', 'fix', 'update', 'implement', 'create', 'make', 'new', 'support', 'function', 'code', 'feature', 'handle', 'use',
  'improve', 'change', 'example', 'logic', 'helper',
]);
const GENERIC_WEIGHT = 0.3;
const RARE_WEIGHT = 2.5;
/** Two titles sharing a rare token (one with a digit, like SAVE10 or v2) never score below this. */
const RARE_SHARED_FLOOR = 0.3;

/** Lowercase, identifiers split (applyDiscount → apply discount), punctuation removed, stop words dropped. */
export function titleWords(title: string): string[] {
  const split = title.replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, '$1 $2').replace(/(\p{Lu})(\p{Lu}\p{Ll})/gu, '$1 $2');
  return split.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 0 && !STOP_WORDS.has(w));
}

/** The normalized title: its words joined by single spaces. */
export function normalizeTitle(title: string): string {
  const words = titleWords(title);
  // A title made only of stop words or symbols still compares by its plain lowercase text.
  return words.length > 0 ? words.join(' ') : title.toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Light suffix stemming: discounts → discount, adding → add, applied/applies → apply, code/coding → cod. */
export function stem(word: string): string {
  let w = word;
  if (w.length > 4 && w.endsWith('ies')) w = `${w.slice(0, -3)}y`;
  else if (w.length > 4 && w.endsWith('ied')) w = `${w.slice(0, -3)}y`;
  else if (w.length > 5 && w.endsWith('ing')) {
    w = w.slice(0, -3);
    if (w.length > 3 && w[w.length - 1] === w[w.length - 2] && !/[lsz]/.test(w[w.length - 1]!)) w = w.slice(0, -1);
  } else if (w.length > 4 && w.endsWith('ed')) w = w.slice(0, -2);
  else if (/(ss|x|ch|sh)es$/.test(w) && w.length > 4) w = w.slice(0, -2);
  else if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) w = w.slice(0, -1);
  if (w.length > 3 && w.endsWith('e')) w = w.slice(0, -1);
  return w;
}

const hasDigit = (w: string): boolean => /\p{N}/u.test(w);
const weight = (w: string): number => (hasDigit(w) ? RARE_WEIGHT : GENERIC_WORDS.has(w) ? GENERIC_WEIGHT : 1);

function stemSet(title: string): Set<string> {
  return new Set(titleWords(title).map((w) => (hasDigit(w) ? w : stem(w))));
}

/**
 * Weighted Jaccard overlap of the stemmed word sets of two titles, 0 to 1. Generic words weigh little and tokens with
 * digits (SAVE10) weigh a lot; with all weights equal this is the plain Jaccard. Equal normalized titles score 1.
 */
export function jaccard(a: string, b: string): number {
  if (normalizeTitle(a) === normalizeTitle(b)) return 1;
  const x = stemSet(a);
  const y = stemSet(b);
  if (x.size === 0 || y.size === 0) return 0;
  let shared = 0;
  let total = 0;
  for (const w of x) {
    total += weight(w);
    if (y.has(w)) shared += weight(w);
  }
  for (const w of y) if (!x.has(w)) total += weight(w);
  return total === 0 ? 0 : shared / total;
}

/** Looser score for "similar" suggestions: `jaccard`, raised to a floor when the titles share a rare token like SAVE10. */
export function similarity(a: string, b: string): number {
  const score = jaccard(a, b);
  if (score >= RARE_SHARED_FLOOR) return score;
  const y = stemSet(b);
  for (const w of stemSet(a)) if (hasDigit(w) && y.has(w)) return RARE_SHARED_FLOOR;
  return score;
}
