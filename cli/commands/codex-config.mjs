/**
 * The `[mcp_servers.hivemind]` table in ~/.codex/config.toml.
 *
 * The table is written as a marker-delimited block appended to the file, so the user's own settings, comments and
 * ordering are never rewritten (a parse-and-stringify round trip would drop comments). smol-toml is used to check
 * that the file parses before and after, and that the result holds exactly the table we meant to write.
 */
import { parse } from 'smol-toml';
import { CliError } from './context.mjs';

export const TOML_START = '# hivemind:start (managed by `hivemind join`; do not edit)';
export const TOML_END = '# hivemind:end';
const BLOCK_RE = /(?:\r?\n)?# hivemind:start[^\n]*\n[\s\S]*?# hivemind:end[ \t]*(?:\r?\n|$)/;

/**
 * A TOML basic string.
 * @param {string} s
 */
function tomlString(s) {
  return JSON.stringify(s);
}

/**
 * @param {string} server normalized, no trailing slash
 * @param {string} token
 */
export function codexMcpBlock(server, token) {
  if (!/^hm_a\.[A-Za-z0-9_.-]+$/.test(token)) throw new CliError('the token has characters a Codex config cannot hold');
  return [
    TOML_START,
    '[mcp_servers.hivemind]',
    `url = ${tomlString(`${server}/mcp`)}`,
    `http_headers = { Authorization = ${tomlString(`Bearer ${token}`)} }`,
    'default_tools_approval_mode = "approve"',
    'tool_timeout_sec = 60',
    TOML_END,
  ].join('\n');
}

/**
 * @param {string} text
 * @param {string} where for error messages
 * @returns {Record<string, any>}
 */
function parseToml(text, where) {
  try {
    return parse(text);
  } catch (e) {
    throw new CliError(`${where} is not valid TOML (${/** @type {Error} */ (e).message.split('\n')[0]}); nothing was changed.`);
  }
}

/**
 * @param {string} text
 */
export function hasOurBlock(text) {
  return BLOCK_RE.test(text);
}

/**
 * Add or refresh our block. Throws if the user already has their own `mcp_servers.hivemind` table outside it.
 * @param {string | null} existing file text, or null when there is no file
 * @param {string} block from codexMcpBlock
 * @param {string} where file path, for messages
 * @returns {string} the new file text
 */
export function setBlock(existing, block, where) {
  const text = existing ?? '';
  const withoutOurs = text.replace(BLOCK_RE, '');
  const before = parseToml(withoutOurs, where);
  if (before.mcp_servers && typeof before.mcp_servers === 'object' && 'hivemind' in before.mcp_servers) {
    throw new CliError(`${where} already has its own [mcp_servers.hivemind] table. Remove it (or move it elsewhere) and run this again. Nothing was changed.`);
  }
  let next;
  if (hasOurBlock(text)) {
    next = text.replace(BLOCK_RE, (m) => `${m.startsWith('\n') || m.startsWith('\r') ? '\n' : ''}${block}\n`);
  } else {
    const sep = text === '' ? '' : text.endsWith('\n') ? '\n' : '\n\n';
    next = `${text}${sep}${block}\n`;
  }
  const after = parseToml(next, where);
  const t = after.mcp_servers?.hivemind;
  const want = parse(block).mcp_servers;
  if (JSON.stringify(t) !== JSON.stringify(/** @type {any} */ (want).hivemind)) {
    throw new CliError(`${where} would not read back as expected after the change; nothing was changed.`);
  }
  return next;
}

/**
 * Remove our block and nothing else.
 * @param {string} text
 * @returns {string}
 */
export function removeBlock(text) {
  return text.replace(BLOCK_RE, '');
}

/**
 * The token and URL in the block, for `doctor`. Null when there is no block.
 * @param {string} text
 * @returns {{ url: string, hasAuth: boolean, approve: boolean, timeout: number | null } | null}
 */
export function readBlock(text) {
  const m = BLOCK_RE.exec(text);
  if (!m) return null;
  try {
    const t = /** @type {any} */ (parse(m[0]).mcp_servers)?.hivemind;
    return {
      url: String(t?.url ?? ''),
      hasAuth: typeof t?.http_headers?.Authorization === 'string',
      approve: t?.default_tools_approval_mode === 'approve',
      timeout: typeof t?.tool_timeout_sec === 'number' ? t.tool_timeout_sec : null,
    };
  } catch {
    return null;
  }
}
