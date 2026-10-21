/** The denial message of ARCHITECTURE.md §9. Pure. */
import type { AgentState, LockConflict, Millis, RepoPath } from '../../../../shared/contracts';
import { ageText } from '../../util';
import { cleanLine } from '../messages/sanitize';

/** Task titles are written by teammates' agents: show them as quoted data, never as instructions (§13). */
const quoted = (s: string): string => `"${cleanLine(s, 200).replace(/"/g, "'")}"`;
/** Paths come from teammates' agents too: one clean, bounded line. */
const plain = (s: string, max = 300): string => cleanLine(s, max);

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
  const blocked = plain(blockedPathFor(first, input.paths));
  const firstPath = plain(first.path);
  const what = first.kind === 'folder' && blocked.toLowerCase() !== firstPath.toLowerCase()
    ? `${blocked} is in ${firstPath}, a folder held by ${first.holder}`
    : `${blocked} is held by ${first.holder}`;
  const parts: string[] = [];
  const title = first.taskId !== null ? input.taskTitles.get(first.taskId) : undefined;
  if (first.taskId !== null) parts.push(title ? `task #${first.taskId} ${quoted(title)}` : `task #${first.taskId}`);
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
    const target = first.kind === 'folder' ? `this folder (${firstPath})` : 'this file';
    lines.push(`${first.holder} has been ${stateWord(first.holderState)} ${ageText(silence)}. You may \`take\` ${target} with a reason.`);
  } else {
    lines.push(`- \`wait\` with for: "release:${firstPath}".`);
  }
  if (rest.length > 0) {
    const others = rest.map((c) => `${plain(blockedPathFor(c, input.paths))} (held by ${c.holder})`);
    lines.push(`Also blocked: ${others.join(', ')}. Nothing was changed or locked.`);
  }
  return lines.join('\n');
}

export type { Millis };
