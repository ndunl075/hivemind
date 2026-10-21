/**
 * Claude Code adapter (ARCHITECTURE.md §6.2, docs/spike-results.md §3).
 * Output shapes follow shared/fixtures/hooks/claude/output/*. Claude ignores unknown fields, but we emit none.
 * @typedef {import('../../shared/hook-modules').ParsedHookInput} ParsedHookInput
 * @typedef {import('../../shared/hook-modules').HookOutcome} HookOutcome
 * @typedef {import('../../shared/contracts').HookEvent} HookEvent
 */

/** Claude 2.1.287 has no MultiEdit; keeping it here is harmless. */
const PATH_TOOLS = new Set(['Edit', 'Write', 'MultiEdit']);
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
const DEFAULT_DENY = '[Hivemind] Edit blocked.';

/**
 * @param {unknown} v
 * @returns {v is Record<string, unknown>}
 */
function isObj(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Subagent events (agent_id present) are treated as the parent session's: session_id is used as is.
 * @param {unknown} raw
 * @returns {ParsedHookInput}
 */
export function parse(raw) {
  if (!isObj(raw)) throw new Error('hook payload is not an object');
  if (typeof raw.session_id !== 'string' || raw.session_id === '') throw new Error('hook payload has no session_id');
  const tool = typeof raw.tool_name === 'string' ? raw.tool_name : null;
  const input = isObj(raw.tool_input) ? raw.tool_input : {};
  /** @type {string[]} */
  const editPaths = [];
  if (tool !== null && PATH_TOOLS.has(tool) && typeof input.file_path === 'string') editPaths.push(input.file_path);
  if (tool === 'NotebookEdit' && typeof input.notebook_path === 'string') editPaths.push(input.notebook_path);
  const isHivemindTool = tool !== null && tool.startsWith('mcp__hivemind__');
  return {
    event: /** @type {HookEvent} */ (String(raw.hook_event_name)),
    session: raw.session_id,
    cwd: typeof raw.cwd === 'string' && raw.cwd !== '' ? raw.cwd : process.cwd(),
    tool,
    editPaths,
    isShell: tool !== null && SHELL_TOOLS.has(tool),
    me: isHivemindTool && typeof input.me === 'string' ? input.me : null,
    isHivemindTool,
    stopActive: raw.stop_hook_active === true,
    endReason: typeof raw.reason === 'string' ? raw.reason : null,
  };
}

/**
 * @param {string} name
 * @param {Record<string, string>} fields
 */
function specific(name, fields) {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: name, ...fields } });
}

/**
 * @param {HookEvent} event
 * @param {HookOutcome} outcome
 * @returns {string | null}
 */
export function format(event, outcome) {
  const context = typeof outcome.context === 'string' && outcome.context !== '' ? outcome.context : null;
  switch (event) {
    case 'PreToolUse':
      if (outcome.decision === 'deny') {
        /** @type {Record<string, string>} */
        const fields = { permissionDecision: 'deny', permissionDecisionReason: outcome.reason || DEFAULT_DENY };
        if (context) fields.additionalContext = context;
        return specific('PreToolUse', fields);
      }
      return context ? specific('PreToolUse', { additionalContext: context }) : null;
    case 'SessionStart':
    case 'UserPromptSubmit':
    case 'PostToolUse':
      return context ? specific(event, { additionalContext: context }) : null;
    case 'Stop':
      return outcome.decision === 'block' && outcome.reason ? JSON.stringify({ decision: 'block', reason: outcome.reason }) : null;
    default:
      return null;
  }
}

export default { parse, format };
