/**
 * Merging Hivemind's hook registrations into a settings object shaped `{ hooks: { <Event>: [{ matcher?, hooks: [handler] }] } }`
 * (Claude's settings.json and Codex's hooks.json share this shape). Only handlers recognised as Hivemind's are ever
 * replaced or removed; everything else, including other handlers in the same group, is left as it was.
 */
import { CliError } from './context.mjs';

/**
 * @typedef {{ event: string, matcher?: string, timeout: number }} HookSpec
 * @typedef {Record<string, any>} Obj
 */

/**
 * A handler is Hivemind's when any of its command strings points at our hook script.
 * @param {string} hookScript absolute path of $HIVEMIND_HOME/hook/hook.mjs
 * @returns {(handler: unknown) => boolean}
 */
export function oursMatcher(hookScript) {
  const norm = (/** @type {string} */ s) => s.replace(/\\/g, '/').toLowerCase();
  const exact = norm(hookScript);
  return (handler) => {
    if (typeof handler !== 'object' || handler === null) return false;
    const h = /** @type {Obj} */ (handler);
    const strings = [h.command, h.commandWindows, ...(Array.isArray(h.args) ? h.args : [])]
      .filter((s) => typeof s === 'string')
      .map(norm);
    return strings.some((s) => s.includes(exact) || /\/\.?hivemind\/hook\/hook\.mjs/.test(s));
  };
}

/**
 * @param {Obj} root
 * @returns {Obj}
 */
function hooksOf(root) {
  if (root.hooks === undefined) return {};
  if (typeof root.hooks !== 'object' || root.hooks === null || Array.isArray(root.hooks)) {
    throw new CliError('the "hooks" entry is not an object; nothing was changed.');
  }
  return root.hooks;
}

/**
 * Put our handler into each event, replacing any earlier Hivemind handler in place. Returns a new object.
 * @param {Obj} root
 * @param {HookSpec[]} specs
 * @param {(spec: HookSpec) => Obj} makeHandler
 * @param {(handler: unknown) => boolean} isOurs
 * @returns {Obj}
 */
export function mergeHooks(root, specs, makeHandler, isOurs) {
  const next = structuredClone(root);
  const hooks = hooksOf(next);
  for (const spec of specs) {
    const groups = hooks[spec.event];
    if (groups !== undefined && !Array.isArray(groups)) throw new CliError(`"hooks.${spec.event}" is not a list; nothing was changed.`);
    /** @type {Obj[]} */
    const kept = [];
    let at = -1;
    for (const g of groups ?? []) {
      if (typeof g === 'object' && g !== null && Array.isArray(g.hooks)) {
        const rest = g.hooks.filter((/** @type {unknown} */ h) => !isOurs(h));
        if (rest.length !== g.hooks.length && at < 0) at = kept.length;
        if (rest.length > 0) kept.push(rest.length === g.hooks.length ? g : { ...g, hooks: rest });
      } else {
        kept.push(g);
      }
    }
    /** @type {Obj} */
    const ours = { ...(spec.matcher === undefined ? {} : { matcher: spec.matcher }), hooks: [makeHandler(spec)] };
    if (at < 0) kept.push(ours);
    else kept.splice(at, 0, ours);
    hooks[spec.event] = kept;
  }
  next.hooks = hooks;
  return next;
}

/**
 * Remove every Hivemind handler, dropping groups, events and the `hooks` key only when that leaves them empty.
 * @param {Obj} root
 * @param {(handler: unknown) => boolean} isOurs
 * @returns {Obj}
 */
export function removeHooks(root, isOurs) {
  const next = structuredClone(root);
  if (next.hooks === undefined) return next;
  const hooks = hooksOf(next);
  for (const event of Object.keys(hooks)) {
    const groups = hooks[event];
    if (!Array.isArray(groups)) continue;
    /** @type {Obj[]} */
    const kept = [];
    let touched = false;
    for (const g of groups) {
      if (typeof g === 'object' && g !== null && Array.isArray(g.hooks)) {
        const rest = g.hooks.filter((/** @type {unknown} */ h) => !isOurs(h));
        if (rest.length !== g.hooks.length) touched = true;
        if (rest.length > 0) kept.push(rest.length === g.hooks.length ? g : { ...g, hooks: rest });
      } else {
        kept.push(g);
      }
    }
    if (!touched) continue;
    if (kept.length > 0) hooks[event] = kept;
    else delete hooks[event];
  }
  if (Object.keys(hooks).length === 0) delete next.hooks;
  return next;
}

/**
 * @param {Obj} root
 * @param {(handler: unknown) => boolean} isOurs
 */
export function hasOurHooks(root, isOurs) {
  const hooks = root.hooks;
  if (typeof hooks !== 'object' || hooks === null) return false;
  return Object.values(hooks).some(
    (groups) => Array.isArray(groups) && groups.some((g) => g && Array.isArray(g.hooks) && g.hooks.some(isOurs)),
  );
}
