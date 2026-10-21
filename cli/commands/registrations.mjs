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

/** Characters a path may hold and still be written as one shell word that PowerShell, cmd and Git Bash all read the same. */
const WORD_SAFE = /^[\p{L}\p{N}_@+=:,./~ -]+$/u;

/**
 * A path as a command word that works in PowerShell, cmd.exe and Git Bash alike (verified under each): forward
 * slashes, no quotes around it, and every space written as `" "` (a quote pair around a space). A leading quoted
 * string would only be printed by PowerShell, and `&` is not understood by cmd, so this is the one common form.
 * @param {string} path
 */
export function shellWord(path) {
  const fwd = path.replace(/\\/g, '/');
  if (!WORD_SAFE.test(fwd)) {
    throw new CliError(
      'the Hivemind folder path has a character that cannot be written safely in a command every shell reads the same way. Set HIVEMIND_HOME to a folder whose path has only letters, digits, spaces and . _ - / : and run this again.',
    );
  }
  return fwd.replace(/ /g, '" "');
}

/**
 * The command Claude's headersHelper runs; the helper prints the Authorization header from config.json, so no token
 * is in this string. Claude does not say which shell runs it, so on Windows it is one word: the wrapper script
 * (see helperCmdText), which knows the node path itself. Elsewhere sh runs it, and quoting is enough.
 * @param {string} platform
 * @param {string} node
 * @param {string} helperScript
 * @param {string} helperCmd the Windows wrapper
 */
export function headersHelperCommand(platform, node, helperScript, helperCmd) {
  if (platform === 'win32') return shellWord(helperCmd);
  return `${posixQuote(node)} ${posixQuote(helperScript)}`;
}

/**
 * The Windows wrapper next to headers-helper.mjs: runs it with the node recorded at join time.
 * @param {string} node
 */
export function helperCmdText(node) {
  if (/["\r\n]/.test(node)) throw new CliError('the node path has a character a Windows script cannot hold');
  return `@echo off\r\n"${node.replace(/%/g, '%%')}" "%~dp0headers-helper.mjs"\r\n`;
}

/**
 * True when text from `claude mcp get` (or a settings file) names Hivemind's own helper script.
 * @param {string} text
 */
export function isOurHelper(text) {
  return /\/hook\/headers-helper\.(mjs|cmd)/.test(text.replace(/\\/g, '/'));
}

/**
 * Escape a string as one Windows command-line argument (the MSVC rules): backslashes before a quote are doubled.
 * @param {string} s
 */
function winArg(s) {
  return s.replace(/(\\*)"/g, '$1$1\\"');
}

/**
 * The `claude mcp add-json` command to run by hand, once per shell family, with the JSON quoted for that shell.
 * @param {string} platform
 * @param {string} json
 * @param {string} [prefix] the program and fixed arguments
 * @returns {Array<{ shell: string, command: string }>}
 */
export function addJsonCommands(platform, json, prefix = 'claude mcp add-json --scope user hivemind') {
  if (platform === 'win32') {
    return [
      { shell: 'PowerShell', command: `${prefix} '${winArg(json).replace(/'/g, "''")}'` },
      { shell: 'Command Prompt', command: `${prefix} "${winArg(json)}"` },
    ];
  }
  return [{ shell: 'sh', command: `${prefix} '${json.replace(/'/g, "'\\''")}'` }];
}

/**
 * @param {string} server
 * @param {string} helperCommand
 */
export function claudeMcpJson(server, helperCommand) {
  return { type: 'http', url: `${server}/mcp`, headersHelper: helperCommand };
}

export const ALLOW_RULE = 'mcp__hivemind';
