/**
 * Text hygiene for everything an agent writes that another agent will read (messages, task titles, notes).
 * ARCHITECTURE.md §11 guardrails: control characters stripped, length capped. On top of util.cleanText this folds
 * every kind of line break into '\n' (so the quoting in format() cannot be escaped with a bare '\r' or U+2028)
 * and drops invisible bidirectional and zero-width characters.
 */
import { cleanText } from '../../util';

// eslint-disable-next-line no-misleading-character-class
const INVISIBLE = /[\u0080-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff\u00ad]/g;
const LINE_BREAKS = /\r\n|\r|\u2028|\u2029|\u0085|\u000b|\u000c/g;

/** Multi-line text: line breaks folded to '\n', control and invisible characters removed, capped. */
export function cleanBlock(text: string, maxChars: number): string {
  return cleanText(text.replace(LINE_BREAKS, '\n').replace(INVISIBLE, ''), maxChars);
}

/** Single-line text (titles): all whitespace runs, line breaks included, collapse to one space; trimmed and capped. */
export function cleanLine(text: string, maxChars: number): string {
  return cleanBlock(text, maxChars * 4).replace(/\s+/g, ' ').trim().slice(0, maxChars).trim();
}
