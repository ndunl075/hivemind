/**
 * The protocol section in AGENTS.md and CLAUDE.md: text from shared/protocol.md between marker comments. Anything
 * outside the markers is never touched, and writing the same text twice changes nothing.
 */
import { readFileSync } from 'node:fs';
import { CliError } from './context.mjs';

export const MD_START = '<!-- hivemind:start -->';
export const MD_END = '<!-- hivemind:end -->';
const SECTION_RE = /(?:\r?\n)?<!-- hivemind:start -->[\s\S]*?<!-- hivemind:end -->[ \t]*(?:\r?\n|$)/;

/** The one source of the protocol text, bundled with the CLI (package.json "files"). */
export function protocolText() {
  try {
    return readFileSync(new URL('../../shared/protocol.md', import.meta.url), 'utf8').replace(/\r\n/g, '\n').trim();
  } catch (e) {
    throw new CliError(`cannot read shared/protocol.md: ${/** @type {Error} */ (e).message}`);
  }
}

/** @param {string} protocol */
export function section(protocol) {
  return `${MD_START}\n${protocol}\n${MD_END}`;
}

/**
 * @param {string | null} existing file text, or null when the file doesn't exist
 * @param {string} protocol
 * @returns {string}
 */
export function setSection(existing, protocol) {
  const text = existing ?? '';
  const block = section(protocol);
  if (SECTION_RE.test(text)) {
    return text.replace(SECTION_RE, (m) => `${m.startsWith('\n') || m.startsWith('\r') ? '\n' : ''}${block}\n`);
  }
  if (text.includes(MD_START) || text.includes(MD_END)) {
    throw new CliError('found a Hivemind marker without its partner; fix the file by hand. Nothing was changed.');
  }
  const sep = text === '' ? '' : text.endsWith('\n') ? '\n' : '\n\n';
  return `${text}${sep}${block}\n`;
}

/**
 * @param {string} text
 * @returns {string}
 */
export function removeSection(text) {
  return text.replace(SECTION_RE, '');
}
