/**
 * Codex adapter: a stub (ARCHITECTURE.md §6.2). The Codex wave replaces this file.
 * It parses the common fields only, finds no edit paths and emits no output, so a Codex session
 * registered against this stub is never blocked. Codex treats unknown output fields as a failed
 * hook, so the real adapter must build output from a per-event whitelist (docs/spike-results.md §3).
 * @typedef {import('../../shared/hook-modules').ParsedHookInput} ParsedHookInput
 * @typedef {import('../../shared/hook-modules').HookOutcome} HookOutcome
 * @typedef {import('../../shared/contracts').HookEvent} HookEvent
 */

/**
 * @param {unknown} raw
 * @returns {ParsedHookInput}
 */
export function parse(raw) {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('hook payload is not an object');
  const r = /** @type {Record<string, unknown>} */ (raw);
  if (typeof r.session_id !== 'string' || r.session_id === '') throw new Error('hook payload has no session_id');
  const tool = typeof r.tool_name === 'string' ? r.tool_name : null;
  const isHivemindTool = tool !== null && tool.startsWith('mcp__hivemind__');
  const input = typeof r.tool_input === 'object' && r.tool_input !== null ? /** @type {Record<string, unknown>} */ (r.tool_input) : {};
  return {
    event: /** @type {HookEvent} */ (String(r.hook_event_name)),
    session: r.session_id,
    cwd: typeof r.cwd === 'string' && r.cwd !== '' ? r.cwd : process.cwd(),
    tool,
    editPaths: [],
    isShell: tool === 'Bash',
    me: isHivemindTool && typeof input.me === 'string' ? input.me : null,
    isHivemindTool,
    stopActive: r.stop_hook_active === true,
    endReason: typeof r.reason === 'string' ? r.reason : null,
  };
}

/**
 * @param {HookEvent} _event
 * @param {HookOutcome} _outcome
 * @returns {string | null}
 */
export function format(_event, _outcome) {
  return null;
}

export default { parse, format };
