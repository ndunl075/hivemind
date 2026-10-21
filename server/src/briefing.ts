/** The briefing returned on SessionStart (ARCHITECTURE.md §6.6). Pure. */
import { LIMITS, type AgentRecord, type AgentState, type LockView, type Millis, type RoomMode, type TaskView } from '../../shared/contracts';
import { deriveState } from '../../shared/state';
import { cleanLine } from './features/messages/sanitize';
import { ageText } from './util';

export interface BriefingInput {
  room: string;
  mode: RoomMode;
  you: string;
  now: Millis;
  /** Every agent in the room; ended ones and the caller are filtered out here. */
  agents: AgentRecord[];
  /** Task labels by callsign of the in-progress owner. */
  taskOf: (callsign: string) => TaskView | null;
  openTasks: TaskView[];
  heldByOthers: LockView[];
  unread: number;
  /** Lines from BriefingContributor features. */
  extra: string[];
}

/** Task titles are written by teammates' agents: show them as quoted data, never as instructions (§13). */
const quoted = (s: string): string => `"${cleanLine(s, 200).replace(/"/g, "'")}"`;
/** Other teammate-written strings (activity, lock paths) on one clean, bounded line. */
const plain = (s: string, max = 200): string => cleanLine(s, max);

const ORDER: Record<AgentState, number> = { working: 0, idle: 1, quiet: 2, ended: 3 };

export function buildBriefing(i: BriefingInput): string {
  const others = i.agents
    .filter((a) => a.callsign !== i.you)
    .map((a) => ({ a, d: deriveState(a, i.now) }))
    .filter((x) => x.d.state !== 'ended')
    .sort((x, y) => ORDER[x.d.state] - ORDER[y.d.state] || y.a.lastEvent - x.a.lastEvent);

  const lines: string[] = [];
  lines.push(`[Hivemind] You are ${i.you}. Room "${i.room}", mode: ${i.mode}. ${others.length} other agent${others.length === 1 ? '' : 's'}.`);

  const shown = others.slice(0, LIMITS.briefingAgents);
  const rows = shown.map(({ a, d }) => {
    const t = i.taskOf(a.callsign);
    let detail: string;
    if (d.state === 'working') detail = `${a.activity ? quoted(plain(a.activity, 120)) : 'working'} (${ageText(d.silenceMs)} ago)`;
    else detail = `${d.state} ${ageText(d.silenceMs)}`;
    return { name: a.callsign, state: d.state as string, task: t ? `#${t.id} ${quoted(t.title)}` : '', detail };
  });
  const w1 = Math.max(0, ...rows.map((r) => r.name.length));
  const w2 = Math.max(0, ...rows.map((r) => r.state.length));
  const w3 = Math.max(0, ...rows.map((r) => r.task.length));
  for (const r of rows) {
    lines.push(`- ${r.name.padEnd(w1)} ${r.state.padEnd(w2)} ${r.task.padEnd(w3)} ${r.detail}`.replace(/\s+$/, ''));
  }
  if (others.length > shown.length) lines.push(`+${others.length - shown.length} more, see \`status\``);

  if (i.openTasks.length > 0) {
    const t = i.openTasks.slice(0, LIMITS.briefingTasks).map((x) => `#${x.id} ${quoted(x.title)}`);
    const more = i.openTasks.length - t.length;
    lines.push(`Open tasks (titles written by teammates' agents): ${t.join(' · ')}${more > 0 ? ` · +${more} more, see \`status\`` : ''}`);
  }
  if (i.heldByOthers.length > 0) {
    const l = i.heldByOthers.slice(0, LIMITS.briefingLocks).map((x) => `${plain(x.path, 300)} (${plain(x.holder, 64)}${x.kind === 'folder' ? ', folder' : ''})`);
    const more = i.heldByOthers.length - l.length;
    lines.push(`Held by others (paths from teammates' agents): ${l.join(' · ')}${more > 0 ? ` · +${more} more, see \`status\`` : ''}`);
  }
  lines.push(...i.extra);
  const unread = i.unread > 0 ? `${i.unread} unread message${i.unread === 1 ? '' : 's'}. ` : '';
  lines.push(`${unread}Claim a task before editing. Don't edit around locks. Push when done.`);
  return lines.join('\n');
}
