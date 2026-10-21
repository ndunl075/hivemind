/**
 * What gets registered where (ARCHITECTURE.md §6.2). Paths are absolute and filled in by `join`/`update`.
 * @typedef {import('./hooks-merge.mjs').HookSpec} HookSpec
 */
import { CliError } from './context.mjs';

const CLAUDE_EDIT_MATCHER = 'Edit|Write|MultiEdit|NotebookEdit|mcp__hivemind__.*';
const CODEX_EDIT_MATCHER = 'apply_patch|Edit|Write|mcp__hivemind__.*';

/** @type {HookSpec[]} */
export const CLAUDE_SPECS = [
  { event: 'SessionStart', timeout: 5 },
  { event: 'UserPromptSubmit', timeout: 5 },
  { event: 'PreToolUse', matcher: CLAUDE_EDIT_MATCHER, timeout: 5 },
  { event: 'PostToolUse', matcher: '.*', timeout: 5 },
  { event: 'Stop', timeout: 5 },
  { event: 'SessionEnd', timeout: 3 },
];

/**
 * Codex has no lookahead matcher and each hook costs PowerShell startup on Windows, so PostToolUse is narrow
 * (docs/spike-results.md item 10). SessionEnd is cut at about 3 s, so its timeout is 3.
 * @type {HookSpec[]}
 */
export const CODEX_SPECS = [
  { event: 'SessionStart', timeout: 5 },
  { event: 'UserPromptSubmit', timeout: 5 },
  { event: 'PreToolUse', matcher: CODEX_EDIT_MATCHER, timeout: 5 },
  { event: 'PostToolUse', matcher: 'Bash|apply_patch', timeout: 5 },
  { event: 'Stop', timeout: 5 },
  { event: 'SessionEnd', timeout: 3 },
];

/**
 * Claude runs `command` + `args` with no shell, so the same entry works under Git Bash and PowerShell (spike item 5).
 * @param {string} node
 * @param {string} hookScript
 * @param {HookSpec} spec
 */
export function claudeHandler(node, hookScript, spec) {
  return { type: 'command', command: node, args: [hookScript, 'claude'], timeout: spec.timeout };
}

/**
 * Double-quote for a POSIX shell, escaping what the shell would still interpret inside double quotes.
 * @param {string} s
 */
export function posixQuote(s) {
  assertNoNewline(s);
  return `"${s.replace(/(["\\$`])/g, '\\$1')}"`;
}

/**
 * Double-quote for Windows PowerShell 5.1, escaping with the backtick.
 * @param {string} s
 */
export function powershellQuote(s) {
  assertNoNewline(s);
  return `"${s.replace(/(["`$])/g, '`$1')}"`;
}

/** @param {string} s */
function assertNoNewline(s) {
  if (/[\r\n]/.test(s)) throw new CliError('a path contains a line break, which cannot be put in a hook command');
}

/**
 * `command` is the POSIX form; `commandWindows` is what Codex runs through PowerShell 5.1: the call operator is
 * required, and the exit code is passed on so a hook's exit 2 still blocks (spike item 6).
 * @param {string} node
 * @param {string} hookScript
 * @param {HookSpec} spec
 */
export function codexHandler(node, hookScript, spec) {
  return {
    type: 'command',
    command: `${posixQuote(node)} ${posixQuote(hookScript)} codex`,
    commandWindows: `& ${powershellQuote(node)} ${powershellQuote(hookScript)} codex; exit $LASTEXITCODE`,
    timeout: spec.timeout,
  };
}

/**
 * The command line Claude's headersHelper runs. Forward slashes and double quotes work under Git Bash and PowerShell
 * alike; the helper prints the Authorization header from config.json, so no token is in this string.
 * @param {string} node
 * @param {string} helperScript
 */
export function headersHelperCommand(node, helperScript) {
  const fwd = (/** @type {string} */ p) => posixQuote(p.replace(/\\/g, '/'));
  return `${fwd(node)} ${fwd(helperScript)}`;
}

/**
 * @param {string} server
 * @param {string} helperCommand
 */
export function claudeMcpJson(server, helperCommand) {
  return { type: 'http', url: `${server}/mcp`, headersHelper: helperCommand };
}

export const ALLOW_RULE = 'mcp__hivemind';
