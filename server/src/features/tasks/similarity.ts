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
/** Two titles sharing a rare token (SAVE10, v2, HTTP2, #12) never score below this in `similarity`. */
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
  else if (w.length > 5 && w.endsWith('ing') && /[aeiouy]/.test(w.slice(0, -3))) {
    w = w.slice(0, -3);
    if (w.length > 3 && w[w.length - 1] === w[w.length - 2] && !/[lsz]/.test(w[w.length - 1]!)) w = w.slice(0, -1);
  } else if (w.length > 4 && w.endsWith('ed') && !w.endsWith('eed')) w = w.slice(0, -2);
  else if (/(ss|x|ch|sh)es$/.test(w) && w.length > 4) w = w.slice(0, -2);
  else if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) w = w.slice(0, -1);
  if (w.length > 3 && w.endsWith('e')) w = w.slice(0, -1);
  return w;
}

/** A rare token: 2+ characters mixing letters and digits (SAVE10, v2, HTTP2). Bare numbers like 3 or 2026 are not. */
const isRare = (w: string): boolean => w.length >= 2 && /\p{L}/u.test(w) && /\p{N}/u.test(w);
const GENERIC_STEMS = new Set([...GENERIC_WORDS].map(stem));
const weight = (w: string): number => (isRare(w) ? RARE_WEIGHT : GENERIC_STEMS.has(w) ? GENERIC_WEIGHT : 1);

/** The comparison set: stemmed words, plus the joined lowercase form of a split identifier (OAuth2 → o, auth2, oauth2). */
function stemSet(title: string): Set<string> {
  const out = new Set<string>();
  const add = (w: string): void => { if (!STOP_WORDS.has(w)) out.add(/\p{N}/u.test(w) ? w : stem(w)); };
  for (const raw of title.replace(/#(\p{N}+)/gu, 'ref$1').split(/[^\p{L}\p{N}]+/u)) {
    if (raw === '') continue;
    const parts = titleWords(raw);
    for (const p of parts) add(p);
    if (parts.length > 1) add(raw.toLowerCase());
  }
  return out;
}

/**
 * Plain Jaccard overlap of the stemmed word sets of two titles, 0 to 1. Equal normalized titles score 1. This decides
 * duplicates, so it is deliberately conservative: "Add login page" and "Fix login page" stay apart.
 */
export function jaccard(a: string, b: string): number {
  if (normalizeTitle(a) === normalizeTitle(b)) return 1;
  const x = stemSet(a);
  const y = stemSet(b);
  if (x.size === 0 || y.size === 0) return 0;
  let shared = 0;
  for (const w of x) if (y.has(w)) shared++;
  return shared / (x.size + y.size - shared);
}

/**
 * Looser score for "similar" suggestions only: weighted Jaccard (generic words weigh little, rare tokens like SAVE10
 * weigh a lot), raised to a floor when the titles share a rare token.
 */
export function similarity(a: string, b: string): number {
  if (normalizeTitle(a) === normalizeTitle(b)) return 1;
  const x = stemSet(a);
  const y = stemSet(b);
  if (x.size === 0 || y.size === 0) return 0;
  let shared = 0;
  let total = 0;
  let rareShared = false;
  for (const w of x) {
    total += weight(w);
    if (y.has(w)) {
      shared += weight(w);
      if (isRare(w)) rareShared = true;
    }
  }
  for (const w of y) if (!x.has(w)) total += weight(w);
  const score = total === 0 ? 0 : shared / total;
  return rareShared ? Math.max(score, RARE_SHARED_FLOOR) : score;
}
