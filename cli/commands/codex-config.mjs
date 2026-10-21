/**
 * The `[mcp_servers.hivemind]` table in ~/.codex/config.toml.
 *
 * The table is written as a marker-delimited block, so the user's own settings, comments and ordering are never
 * rewritten (a parse-and-stringify round trip would drop comments). The block goes before the file's first table
 * header (after the root keys), so a root key appended to the file later cannot land inside our table; a file with
 * no tables gets it at the end. smol-toml checks that the file reads the same as before plus our table, after every
 * change, and a change that would alter anything else is refused.
 */
import { parse } from 'smol-toml';
import { CliError } from './context.mjs';

export const TOML_START = '# hivemind:start (managed by `hivemind join`; do not edit)';
export const TOML_END = '# hivemind:end';

/** The server name of the first (or only) room. Further rooms are named `hivemind-<room>` (see rooms.mjs). */
export const DEFAULT_NAME = 'hivemind';
const NAME_RE = /^hivemind(?:-[a-z0-9]+)*$/;

/**
 * Marker lines for one server. The default server keeps the original text, so a file written by an earlier version
 * is read unchanged; other servers carry their name after the keyword.
 * @param {string} name
 */
const startMarker = (name) => (name === DEFAULT_NAME ? TOML_START : `# hivemind:start ${name} (managed by \`hivemind join\`; do not edit)`);
/** @param {string} name */
const endMarker = (name) => (name === DEFAULT_NAME ? TOML_END : `# hivemind:end ${name}`);

/** @param {string} name */
function checkName(name) {
  if (!NAME_RE.test(name)) throw new CliError(`"${name}" is not a Hivemind MCP server name`);
}

/** The only keys the block ever holds. */
const OUR_KEYS = new Set(['url', 'http_headers', 'default_tools_approval_mode', 'tool_timeout_sec']);

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
 * @param {string} [name] the MCP server name
 */
export function codexMcpBlock(server, token, name = DEFAULT_NAME) {
  checkName(name);
  if (!/^hm_a\.[A-Za-z0-9_.-]+$/.test(token)) throw new CliError('the token has characters a Codex config cannot hold');
  return [
    startMarker(name),
    `[mcp_servers.${name}]`,
    `url = ${tomlString(`${server}/mcp`)}`,
    `http_headers = { Authorization = ${tomlString(`Bearer ${token}`)} }`,
    'default_tools_approval_mode = "approve"',
    'tool_timeout_sec = 60',
    endMarker(name),
  ].join('\n');
}

/**
 * Parse, naming the place of an error but never quoting the file (it can hold keys).
 * @param {string} text
 * @param {string} where file path, for messages
 * @returns {Record<string, any>}
 */
function parseToml(text, where) {
  try {
    return parse(text);
  } catch (e) {
    const { line, column } = /** @type {{ line?: number, column?: number }} */ (e);
    const at = typeof line === 'number' ? ` (line ${line}${typeof column === 'number' ? `, column ${column}` : ''})` : '';
    throw new CliError(`${where} is not valid TOML${at}; nothing was changed.`);
  }
}

/**
 * Stable text of a parsed value, for comparing two parses.
 * @param {unknown} v
 * @returns {string}
 */
function canon(v) {
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  if (v instanceof Date) return `date:${v.toISOString()}`;
  if (typeof v === 'object' && v !== null) {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(/** @type {any} */ (v)[k])}`).join(',')}}`;
  }
  return typeof v === 'bigint' ? `${v}n` : JSON.stringify(v);
}

/**
 * Lines with their line endings kept, so joining them gives the text back byte for byte.
 * @param {string} text
 * @returns {string[]}
 */
function splitLines(text) {
  return text === '' ? [] : text.split(/(?<=\n)/);
}

/**
 * The server a start marker belongs to, or null when the line is not one: `# hivemind:start (...)` is the default
 * server, `# hivemind:start <name> (...)` a named one.
 * @param {string} l
 * @returns {string | null}
 */
function startName(l) {
  const m = /^#\s*hivemind:start(?:\s+(hivemind-[a-z0-9-]+))?(?:\s|$)/.exec(l.trim());
  return m ? (m[1] ?? DEFAULT_NAME) : null;
}
/**
 * @param {string} l
 * @returns {string | null}
 */
function endName(l) {
  const m = /^#\s*hivemind:end(?:\s+(hivemind-[a-z0-9-]+))?$/.exec(l.trim());
  return m ? (m[1] ?? DEFAULT_NAME) : null;
}
const isBlank = (/** @type {string} */ l) => l.trim() === '';

/**
 * Where one server's block is: first and last line index. Null when absent. A marker without its partner, or two
 * blocks of the same server, is an error.
 * @param {string[]} lines
 * @param {string} where
 * @param {string} [name]
 * @returns {{ start: number, end: number } | null}
 */
function blockRange(lines, where, name = DEFAULT_NAME) {
  const starts = lines.flatMap((l, i) => (startName(l) === name ? [i] : []));
  const ends = lines.flatMap((l, i) => (endName(l) === name ? [i] : []));
  if (starts.length === 0 && ends.length === 0) return null;
  const start = starts[0];
  const end = ends[0];
  if (starts.length !== 1 || ends.length !== 1 || start === undefined || end === undefined || end < start) {
    throw new CliError(`${where} has a "# hivemind:start" / "# hivemind:end" marker without exactly one partner${name === DEFAULT_NAME ? '' : ` (${name})`}. Fix or remove the markers by hand; nothing was changed.`);
  }
  return { start, end };
}

/**
 * The lines between the markers must read as our table and nothing else.
 * @param {string[]} lines
 * @param {{ start: number, end: number }} range
 * @param {string} where
 * @param {string} name
 * @returns {Record<string, any>} the table
 */
function ownTable(lines, range, where, name) {
  const refuse = () => new CliError(
    `${where}: the text between "# hivemind:start" and "# hivemind:end" is not exactly the table Hivemind wrote (it was edited). Remove that block by hand; nothing was changed.`,
  );
  let parsed;
  try {
    parsed = parse(lines.slice(range.start + 1, range.end).join(''));
  } catch {
    throw refuse();
  }
  const servers = /** @type {any} */ (parsed.mcp_servers);
  const t = servers?.[name];
  const rootKeys = Object.keys(parsed);
  const hasHttpHeaders = typeof t?.http_headers === 'object' && t.http_headers !== null;
  if (
    rootKeys.length !== 1 || rootKeys[0] !== 'mcp_servers' || Object.keys(servers).length !== 1 || typeof t !== 'object' || t === null ||
    !Object.keys(t).every((k) => OUR_KEYS.has(k)) ||
    (hasHttpHeaders && Object.keys(t.http_headers).some((k) => k !== 'Authorization'))
  ) throw refuse();
  return t;
}

/**
 * Indexes of lines that look like a table header and are not inside a multi-line string. A guess; every use is
 * checked by re-parsing.
 * @param {string[]} lines
 * @returns {number[]}
 */
function headerLines(lines) {
  /** @type {number[]} */
  const out = [];
  /** @type {string | null} */
  let open = null;
  lines.forEach((l, i) => {
    if (open === null && /^\s*\[/.test(l)) out.push(i);
    for (const delim of ['"""', "'''"]) {
      const n = l.split(delim).length - 1;
      if (open === delim) {
        if (n > 0) open = null;
        break;
      }
      if (open === null && n % 2 === 1) {
        open = delim;
        break;
      }
    }
  });
  return out;
}

/**
 * @param {string} text
 */
const eolOf = (text) => (text.includes('\r\n') ? '\r\n' : '\n');

/**
 * @param {string} text
 * @param {string} [name]
 */
export function hasOurBlock(text, name = DEFAULT_NAME) {
  const lines = splitLines(text);
  return lines.some((l) => startName(l) === name) && lines.some((l) => endName(l) === name);
}

/**
 * Names of every Hivemind server block in the file, in file order.
 * @param {string} text
 * @returns {string[]}
 */
export function blockNames(text) {
  /** @type {string[]} */
  const names = [];
  for (const l of splitLines(text)) {
    const n = startName(l);
    if (n !== null && !names.includes(n)) names.push(n);
  }
  return names;
}

/**
 * Add or refresh our block. Throws if the user already has their own `mcp_servers.hivemind` table outside it.
 * @param {string | null} existing file text, or null when there is no file
 * @param {string} block from codexMcpBlock
 * @param {string} where file path, for messages
 * @param {string} [name] the MCP server name the block is for
 * @returns {string} the new file text
 */
export function setBlock(existing, block, where, name = DEFAULT_NAME) {
  checkName(name);
  const text = existing ?? '';
  const eol = eolOf(text);
  const blockText = block.split('\n').join(eol);
  const lines = splitLines(text);
  const range = blockRange(lines, where, name);

  const withoutOurs = range ? [...lines.slice(0, range.start), ...lines.slice(range.end + 1)].join('') : text;
  const before = parseToml(withoutOurs, where);
  const servers = before.mcp_servers;
  if (servers && typeof servers === 'object' && name in servers) {
    throw new CliError(`${where} already has its own [mcp_servers.${name}] table. Remove it (or move it elsewhere) and run this again. Nothing was changed.`);
  }
  const want = /** @type {any} */ (parse(block).mcp_servers)[name];
  const expected = canon({ ...before, mcp_servers: { ...(servers ?? {}), [name]: want } });
  /** @param {string} next */
  const good = (next) => {
    try { return canon(parse(next)) === expected; } catch { return false; }
  };

  if (range) {
    const tail = lines[range.end] ?? '';
    const endEol = tail.endsWith('\r\n') ? '\r\n' : tail.endsWith('\n') ? '\n' : '';
    const next = [...lines.slice(0, range.start), blockText + endEol, ...lines.slice(range.end + 1)].join('');
    if (good(next)) return next;
  } else {
    // Another Hivemind block is already there: go right after it, so no block ever lands between another one's
    // marker and its table.
    let lastEnd = -1;
    for (const other of blockNames(text)) {
      const r = other === name ? null : blockRange(lines, where, other);
      if (r && r.end > lastEnd) lastEnd = r.end;
    }
    if (lastEnd >= 0) {
      const tail = lines[lastEnd] ?? '';
      const lead = tail.endsWith('\n') ? '' : eol;
      const rest = lines.slice(lastEnd + 1);
      const gap = rest.length > 0 && !isBlank(rest[0] ?? '') ? eol : '';
      const next = `${lines.slice(0, lastEnd + 1).join('')}${lead}${eol}${blockText}${eol}${gap}${rest.join('')}`;
      if (good(next)) return next;
    }
    for (const i of headerLines(lines)) {
      const next = `${lines.slice(0, i).join('')}${blockText}${eol}${eol}${lines.slice(i).join('')}`;
      if (good(next)) return next;
    }
    const sep = text === '' ? '' : text.endsWith('\n') ? eol : eol + eol;
    const next = `${text}${sep}${blockText}${eol}`;
    if (good(next)) return next;
  }
  throw new CliError(`${where} would not read back as expected after the change; nothing was changed.`);
}

/**
 * Remove our block and nothing else: the lines between the markers (checked to be our table), plus the one blank
 * line that separated it. Refused if what remains would read differently from the file minus our table.
 * @param {string} text
 * @param {string} where file path, for messages
 * @param {string} [name] the MCP server name
 * @returns {string}
 */
export function removeBlock(text, where = 'config.toml', name = DEFAULT_NAME) {
  const lines = splitLines(text);
  const range = blockRange(lines, where, name);
  if (!range) return text;
  ownTable(lines, range, where, name);
  const keep = [...lines.slice(0, range.start), ...lines.slice(range.end + 1)];
  const after = lines[range.end + 1];
  if (after !== undefined && isBlank(after)) keep.splice(range.start, 1);
  else if (after === undefined && range.start > 0 && isBlank(/** @type {string} */ (lines[range.start - 1]))) keep.splice(range.start - 1, 1);
  const next = keep.join('');

  const full = parseToml(text, where);
  const expected = structuredClone(full);
  if (expected.mcp_servers && typeof expected.mcp_servers === 'object') {
    delete expected.mcp_servers[name];
    if (Object.keys(expected.mcp_servers).length === 0) delete expected.mcp_servers;
  }
  let got;
  try { got = parse(next); } catch { got = null; }
  if (got === null || canon(got) !== canon(expected)) {
    throw new CliError(
      `${where}: removing the Hivemind block would change other settings (text after "# hivemind:end" belongs to its table). Move that text elsewhere, remove the block by hand, and run this again. Nothing was changed.`,
    );
  }
  return next;
}

/**
 * The URL and flags in the block, for `doctor`. Null when there is no block.
 * @param {string} text
 * @param {string} [name]
 * @returns {{ url: string, hasAuth: boolean, approve: boolean, timeout: number | null } | null}
 */
export function readBlock(text, name = DEFAULT_NAME) {
  const lines = splitLines(text);
  let range;
  try { range = blockRange(lines, 'config.toml', name); } catch { return null; }
  if (!range) return null;
  try {
    const t = /** @type {any} */ (parse(lines.slice(range.start + 1, range.end).join('')).mcp_servers)?.[name];
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
