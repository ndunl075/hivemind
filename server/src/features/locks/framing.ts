/** Teammate-written text framed as data in the notices and denials agents read (ARCHITECTURE.md §13). Pure. */
import { cleanLine } from '../messages/sanitize';

const PLAIN = /^[\w./@+\-]+$/;

/**
 * A path as one clean line. An ordinary path stays bare (`src/auth/login.ts`); anything else (spaces, quotes, brackets,
 * non-ASCII) is shown in double quotes, with its own double quotes turned into single ones, so it reads as data and
 * can't end the quote it sits in. Line breaks and control characters are gone either way.
 */
export function pathText(path: string, max = 200): string {
  const text = cleanLine(path, max).replace(/"/g, "'");
  return PLAIN.test(text) ? text : `"${text}"`;
}

/** The same one-line path without the surrounding quotes, for text that is already inside a quoted string. */
export function pathInQuotes(path: string, max = 200): string {
  return cleanLine(path, max).replace(/"/g, "'");
}
