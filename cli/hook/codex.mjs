/**
 * Codex adapter (ARCHITECTURE.md §6.2, docs/spike-results.md §3).
 *
 * Codex is strict: an unknown field anywhere in a hook's output makes Codex mark the hook failed and let the tool
 * call continue, which would silently turn a deny into an allow. Output is therefore built from a fixed list of
 * fields per event and matches shared/fixtures/hooks/codex/output/* (the accepted samples) byte for byte.
 *
 * @typedef {import('../../shared/hook-modules').ParsedHookInput} ParsedHookInput
 * @typedef {import('../../shared/hook-modules').HookOutcome} HookOutcome
 * @typedef {import('../../shared/contracts').HookEvent} HookEvent
 */

const DEFAULT_DENY = '[Hivemind] Edit blocked.';
/** Codex aliases for apply_patch that carry a plain path (matcher `apply_patch|Edit|Write`). */
const PATH_TOOLS = new Set(['Edit', 'Write']);

/**
 * @param {unknown} v
 * @returns {v is Record<string, unknown>}
 */
function isObj(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * The paths an apply_patch will touch: Add, Update and Delete File headers, plus the target of a Move. Paths can be
 * absolute (the recorded ones are) or relative to the session's cwd; the caller resolves them.
 * @param {string} patch
 * @returns {string[]}
 */
export function patchPaths(patch) {
  /** @type {string[]} */
  const out = [];
  for (const line of patch.split('\n')) {
    // Leading whitespace is allowed: an indented patch is still a patch. Content lines start with + - or a space
    // followed by the content, so a header-looking line inside a hunk can only over-report a path, never hide one.
    const m = /^\s*\*\*\* (?:Add File|Update File|Delete File|Move to):[ \t]*(.+?)\s*$/.exec(line);
    if (m && m[1] && !out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

/**
 * Subagent lifecycle events carry the parent's session_id (plus agent_id), so session_id is used as is.
 * @param {unknown} raw
 * @returns {ParsedHookInput & { source: string | null }}
 */
export function parse(raw) {
  if (!isObj(raw)) throw new Error('hook payload is not an object');
  if (typeof raw.session_id !== 'string' || raw.session_id === '') throw new Error('hook payload has no session_id');
  const tool = typeof raw.tool_name === 'string' ? raw.tool_name : null;
  const input = isObj(raw.tool_input) ? raw.tool_input : {};
  /** @type {string[]} */
  let editPaths = [];
  if (tool === 'apply_patch') {
    const patch = typeof input.command === 'string' ? input.command : typeof input.input === 'string' ? input.input : '';
    editPaths = patchPaths(patch);
  } else if (tool !== null && PATH_TOOLS.has(tool) && typeof input.file_path === 'string') {
    editPaths = [input.file_path];
  }
  const isHivemindTool = tool !== null && tool.startsWith('mcp__hivemind__');
  return {
    event: /** @type {HookEvent} */ (String(raw.hook_event_name)),
    session: raw.session_id,
    cwd: typeof raw.cwd === 'string' && raw.cwd !== '' ? raw.cwd : process.cwd(),
    tool,
    editPaths,
    isShell: tool === 'Bash',
    me: isHivemindTool && typeof input.me === 'string' ? input.me : null,
    isHivemindTool,
    stopActive: raw.stop_hook_active === true,
    endReason: typeof raw.reason === 'string' ? raw.reason : null,
    /** SessionStart only: startup, resume, clear or compact. */
    source: typeof raw.source === 'string' ? raw.source : null,
  };
}

/**
 * hookSpecificOutput with only the whitelisted keys, in the order Codex's accepted samples use.
 * @param {string} name
 * @param {{ permissionDecision?: string; permissionDecisionReason?: string; additionalContext?: string }} f
 */
function specific(name, f) {
  /** @type {Record<string, string>} */
  const inner = { hookEventName: name };
  if (f.permissionDecision !== undefined) inner.permissionDecision = f.permissionDecision;
  if (f.permissionDecisionReason !== undefined) inner.permissionDecisionReason = f.permissionDecisionReason;
  if (f.additionalContext !== undefined) inner.additionalContext = f.additionalContext;
  return JSON.stringify({ hookSpecificOutput: inner });
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
        return specific('PreToolUse', {
          permissionDecision: 'deny',
          permissionDecisionReason: outcome.reason || DEFAULT_DENY,
          ...(context ? { additionalContext: context } : {}),
        });
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
