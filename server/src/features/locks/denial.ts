/** The denial message of ARCHITECTURE.md §9. Pure. */
import type { AgentState, LockConflict, Millis, RepoPath } from '../../../../shared/contracts';
import { ageText } from '../../util';

export interface DenialInput {
  /** Requested paths of the edit, to name the file that was blocked. */
  paths: RepoPath[];
  conflicts: LockConflict[];
  /** Task titles by id, for "(task #4 "Login page", ...)". */
  taskTitles: ReadonlyMap<number, string>;
  /** Silence (ms since last event) per holder callsign. */
  silenceMs: ReadonlyMap<string, number>;
}

/** The requested path that a conflict blocks (first match), falling back to the lock's own path. */
export function blockedPathFor(conflict: LockConflict, paths: RepoPath[]): RepoPath {
  const lp = conflict.path.toLowerCase();
  for (const p of paths) {
    const pl = p.toLowerCase();
    if (conflict.kind === 'folder' ? pl.startsWith(lp) : pl === lp) return p;
  }
  return conflict.path;
}

function stateWord(state: AgentState): string {
  return state;
}

export function denialText(input: DenialInput): string {
  const [first, ...rest] = input.conflicts;
  if (!first) return '[Hivemind] Edit blocked.';
  const blocked = blockedPathFor(first, input.paths);
  const what = first.kind === 'folder' && blocked.toLowerCase() !== first.path.toLowerCase()
    ? `${blocked} is in ${first.path}, a folder held by ${first.holder}`
    : `${blocked} is held by ${first.holder}`;
  const parts: string[] = [];
  const title = first.taskId !== null ? input.taskTitles.get(first.taskId) : undefined;
  if (first.taskId !== null) parts.push(title ? `task #${first.taskId} "${title}"` : `task #${first.taskId}`);
  parts.push(first.kind === 'folder' ? 'folder reserved' : 'unpushed changes');
  parts.push(`${first.holder} is ${stateWord(first.holderState)}`);

  const lines = [
    `[Hivemind] Edit blocked: ${what}`,
    `(${parts.join(', ')}).`,
    "Don't change this file another way (no shell writes, no copies). Instead:",
    '- work on something else (`status` lists free tasks), or',
    `- \`post\` to ${first.holder} to coordinate, or`,
  ];
  if (first.takeable) {
    const silence = input.silenceMs.get(first.holder) ?? 0;
    const target = first.kind === 'folder' ? `this folder (${first.path})` : 'this file';
    lines.push(`${first.holder} has been ${stateWord(first.holderState)} ${ageText(silence)}. You may \`take\` ${target} with a reason.`);
  } else {
    lines.push(`- \`wait\` with for: "release:${first.path}".`);
  }
  if (rest.length > 0) {
    const others = rest.map((c) => `${blockedPathFor(c, input.paths)} (held by ${c.holder})`);
    lines.push(`Also blocked: ${others.join(', ')}. Nothing was changed or locked.`);
  }
  return lines.join('\n');
}

export type { Millis };
