/**
 * The task board (ARCHITECTURE.md §10). One owner per task, claims decided strictly in order by the single-threaded
 * Room (every method here is synchronous: a check followed by a write, never an await in between).
 *
 * - States: open -> in_progress (claimed) -> done, or dropped. Only the owner updates a task; its creator may drop it
 *   while it is still open.
 * - The task gate: with requireTask on, an edit is denied while the agent owns no in-progress task.
 * - Dependencies name existing tasks. A claim waits while any is open or in progress; done and dropped count as satisfied.
 * - Duplicates: a new title equal to an open or in-progress one, or overlapping it by Jaccard 0.8 or more, is returned
 *   instead of created unless forced. Otherwise up to three similar titles come back for the agent to judge.
 * - Areas: folders a task expects to touch. Claiming reserves them through LocksApi.
 * - Takeover: a takeable owner's task can be claimed with take and a reason. Tasks of ended owners return to open.
 */
import {
  LIMITS,
  type Actor, type AgentState, type BriefingContributor, type Callsign, type FeatureFactory, type LockConflict,
  type LockView, type NewTask, type RepoId, type RepoPath, type ResolvedSettings, type TaskStatus, type TaskView,
  type TasksApi,
} from '../../../../shared/contracts';
import { deriveState } from '../../../../shared/state';
import { canonicalPath } from '../../util';
import { cleanBlock, cleanLine } from '../messages/sanitize';
import { jaccard, normalizeTitle, similarity } from './similarity';

/** A refusal the caller should read: unknown task, not the owner, bad input. The MCP layer shows it as a tool error. */
export class TaskError extends Error {}

const MAX_TITLE = 200;
const MAX_DESCRIPTION = 2_000;
const MAX_NOTE = 500;
const MAX_AREAS = 20;
const MAX_DEPENDENCIES = 20;
const MAX_NEW_PER_CALL = 20;
const MAX_LIVE_TASKS = 300;
const KEEP_CLOSED = 200;
/** Titles below this overlap are not worth showing as "similar". */
const SIMILAR_FLOOR = 0.2;
/** Prefix on a finished task in `similar`: its work already exists, so the agent should check it first. */
const DONE_MARK = '[DONE: work already exists, check it before starting]';

export interface ClaimOutcome {
  result: 'ok';
  task: TaskView;
  reserved: LockView[];
  /** Present when some of the task's areas could not be reserved. */
  warning?: string;
}
export type ClaimResult =
  | ClaimOutcome
  | { result: 'taken'; owner: Callsign; ownerState: AgentState; takeable: boolean }
  | { result: 'waiting'; unfinished: number[] };

export interface AddOutcome {
  created: { id: number; title: string; similar: { id: number; title: string }[] }[];
  duplicates: { title: string; existing: TaskView }[];
}

/** What the board offers beyond TasksApi, to the MCP tools. */
export interface TaskOps {
  get(id: number): TaskView | null;
  add(actor: Actor, specs: NewTask[], options: { force: boolean; repo?: string }): AddOutcome;
  claim(actor: Actor, id: number, options: { take?: boolean; reason?: string }): ClaimResult;
  update(actor: Actor, id: number, status: TaskStatus, note?: string): TaskView;
}

export type FullTasks = TasksApi & TaskOps & BriefingContributor;

/** Task text written by another agent, shown as quoted data. */
const quoted = (s: string): string => `"${s.replace(/"/g, "'")}"`;

const GATE_TEXT = 'Claim a task first (`task_claim`, or `task_add` with `claim: true`).';

const clone = (t: TaskView): TaskView => ({ ...t, dependsOn: [...t.dependsOn], areas: t.areas.map((a) => ({ ...a })) });

function parseJson<T>(v: unknown, fallback: T): T {
  try {
    return typeof v === 'string' ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
}

/** A canonical folder ending in '/', or null for anything invalid, empty, escaping the repo or inside .git. */
function folderOf(raw: string): RepoPath | null {
  const p = canonicalPath(raw);
  if (!p) return null;
  const folder = p.endsWith('/') ? p : `${p}/`;
  const lower = folder.toLowerCase();
  return lower === '.git/' || lower.startsWith('.git/') ? null : folder;
}

export const createTasks: FeatureFactory<'tasks'> = (ctx, features) => {
  ctx.sql.exec(`CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY, title TEXT NOT NULL, description TEXT, status TEXT NOT NULL, owner TEXT, created_by TEXT NOT NULL,
    depends_on TEXT NOT NULL DEFAULT '[]', areas TEXT NOT NULL DEFAULT '[]', note TEXT, created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL)`).toArray();

  const tasks = new Map<number, TaskView>();
  let nextId = 1;
  for (const r of ctx.sql.exec('SELECT * FROM tasks ORDER BY id').toArray()) {
    const t: TaskView = {
      id: Number(r.id), title: String(r.title), description: r.description === null ? null : String(r.description),
      status: r.status as TaskStatus, owner: r.owner === null ? null : String(r.owner), createdBy: String(r.created_by),
      dependsOn: parseJson<number[]>(r.depends_on, []), areas: parseJson<TaskView['areas']>(r.areas, []),
      note: r.note === null ? null : String(r.note), createdAt: Number(r.created_at), updatedAt: Number(r.updated_at),
    };
    tasks.set(t.id, t);
    nextId = Math.max(nextId, t.id + 1);
  }
  // Ids never repeat, even after the highest task was pruned: the next id is kept in meta (added to the §4 keys).
  const storedNext = Number(ctx.sql.exec("SELECT value FROM meta WHERE key = 'next_task_id'").toArray()[0]?.value ?? 0);
  if (Number.isInteger(storedNext)) nextId = Math.max(nextId, storedNext);

  const save = (t: TaskView): void => {
    tasks.set(t.id, t);
    ctx.sql.exec(
      `INSERT OR REPLACE INTO tasks (id, title, description, status, owner, created_by, depends_on, areas, note, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      t.id, t.title, t.description, t.status, t.owner, t.createdBy, JSON.stringify(t.dependsOn), JSON.stringify(t.areas),
      t.note, t.createdAt, t.updatedAt,
    ).toArray();
  };

  const isOpenOrActive = (t: TaskView): boolean => t.status === 'open' || t.status === 'in_progress';

  const ownerIsGone = (owner: Callsign): boolean => {
    const a = ctx.agent(owner);
    return !a || deriveState(a, ctx.now()).state === 'ended';
  };

  /** Puts an in-progress task back on the board, freeing its folder reservations. */
  const returnToOpen = (t: TaskView, why: string): void => {
    const previous = t.owner;
    const keep = t.note ? ` Last note: "${t.note}"` : '';
    t.status = 'open';
    t.owner = null;
    t.note = cleanBlock(`${why}${keep}`, MAX_NOTE);
    t.updatedAt = ctx.now();
    save(t);
    features.locks.releaseForTask(t.id);
    ctx.emit({
      type: 'task.returned', actor: previous, text: `#${t.id} ${t.title} is open again (${why})`,
      data: { id: t.id }, wake: [`task:${t.id}`],
    });
  };

  /** Tasks whose owner has ended (or is gone) go back to open, even if the Room's housekeeping has not run yet. */
  const reapEnded = (): void => {
    for (const t of [...tasks.values()]) {
      if (t.status === 'in_progress' && t.owner !== null && ownerIsGone(t.owner)) {
        returnToOpen(t, `Returned to open: ${t.owner} ended before finishing.`);
      }
    }
  };

  const unfinishedDeps = (t: TaskView): number[] =>
    t.dependsOn.filter((d) => {
      const dep = tasks.get(d);
      return dep !== undefined && isOpenOrActive(dep); // a dependency that no longer exists counts as satisfied
    });

  const prune = (): void => {
    const closed = [...tasks.values()].filter((t) => !isOpenOrActive(t)).sort((a, b) => a.updatedAt - b.updatedAt || a.id - b.id);
    for (const t of closed.slice(0, Math.max(0, closed.length - KEEP_CLOSED))) {
      tasks.delete(t.id);
      ctx.sql.exec('DELETE FROM tasks WHERE id = ?', t.id).toArray();
    }
  };

  const heldFor = (callsign: Callsign, taskId: number): LockView[] =>
    features.locks.holdings(callsign).filter((l) => l.kind === 'folder' && l.taskId === taskId);

  /** Reserves a task's areas for its new owner, one folder at a time, so a busy folder does not block the others. */
  const reserveAreas = (actor: Actor, t: TaskView): { reserved: LockView[]; warning?: string } => {
    const busy: LockConflict[] = [];
    for (const a of t.areas) {
      const r = features.locks.reserve(actor, [{ repo: a.repo, folder: a.folder }], `task #${t.id}`, t.id);
      if (!r.granted) busy.push(...r.conflicts);
    }
    const reserved = heldFor(actor.callsign, t.id);
    if (busy.length === 0) return { reserved };
    const list = [...new Set(busy.map((c) => `${c.path} (held by ${c.holder})`))].join(', ');
    return {
      reserved,
      warning: `You have the task, but could not reserve: ${list}. Edits there are blocked while they hold it: \`post\` to them, or \`wait\` for the release.`,
    };
  };

  const inProgressFor = (callsign: Callsign): TaskView | null => {
    let best: TaskView | null = null;
    for (const t of tasks.values()) {
      if (t.status === 'in_progress' && t.owner === callsign && (best === null || t.updatedAt >= best.updatedAt)) best = t;
    }
    return best ? clone(best) : null;
  };

  const need = (id: number): TaskView => {
    const t = tasks.get(id);
    if (!t) throw new TaskError(`There is no task #${id}. \`status\` lists the open ones.`);
    return t;
  };

  const api: FullTasks = {
    gate(actor: Actor, settings: ResolvedSettings) {
      if (!settings.requireTask) return { allow: true };
      for (const t of tasks.values()) if (t.status === 'in_progress' && t.owner === actor.callsign) return { allow: true };
      const open = [...tasks.values()].filter((t) => t.status === 'open').slice(0, 3);
      const hint = open.length > 0 ? ` Open tasks (titles written by teammates' agents): ${open.map((t) => `#${t.id} ${quoted(t.title)}`).join(' · ')}.` : '';
      return { allow: false, reason: `${GATE_TEXT}${hint}` };
    },

    inProgressFor,

    onAgentEnded(callsign: Callsign): void {
      for (const t of [...tasks.values()]) {
        if (t.status === 'in_progress' && t.owner === callsign) returnToOpen(t, `Returned to open: ${callsign} ended before finishing.`);
      }
    },

    list(): TaskView[] {
      reapEnded();
      return [...tasks.values()].sort((a, b) => a.id - b.id).map(clone);
    },

    get(id) {
      const t = tasks.get(id);
      return t ? clone(t) : null;
    },

    add(actor, specs, options) {
      if (specs.length === 0) throw new TaskError('Give at least one task.');
      if (specs.length > MAX_NEW_PER_CALL) throw new TaskError(`Add at most ${MAX_NEW_PER_CALL} tasks per call.`);
      reapEnded();
      if ([...tasks.values()].filter(isOpenOrActive).length + specs.length > MAX_LIVE_TASKS) {
        throw new TaskError(`The board already has ${MAX_LIVE_TASKS} live tasks. Finish or drop some first.`);
      }
      // Validate everything first, so a bad entry creates nothing.
      const repo: RepoId | null = ctx.resolveRepo(actor, options.repo);
      if (options.repo && repo === null) throw new TaskError(`Unknown repo "${options.repo}". Use the repo's name or root commit.`);
      const clean = specs.map((s, i) => {
        const where = specs.length > 1 ? ` (task ${i + 1})` : '';
        const title = cleanLine(s.title, MAX_TITLE);
        if (title === '') throw new TaskError(`A task needs a title${where}.`);
        const description = s.description === undefined ? null : (cleanBlock(s.description, MAX_DESCRIPTION).trim() || null);
        const folders: RepoPath[] = [];
        const rawAreas = s.areas ?? [];
        if (rawAreas.length > MAX_AREAS) throw new TaskError(`At most ${MAX_AREAS} areas per task${where}.`);
        for (const raw of rawAreas) {
          const folder = folderOf(raw);
          if (folder === null) throw new TaskError(`Invalid area "${raw}"${where}: use a repo-relative folder such as src/auth/.`);
          if (!folders.some((f) => f.toLowerCase() === folder.toLowerCase())) folders.push(folder);
        }
        if (folders.length > 0 && repo === null) throw new TaskError('Say which repo the areas are in: pass `repo` (its name or root commit).');
        const deps: number[] = [];
        const rawDeps = s.dependsOn ?? [];
        if (rawDeps.length > MAX_DEPENDENCIES) throw new TaskError(`At most ${MAX_DEPENDENCIES} dependencies per task${where}.`);
        for (const d of rawDeps) {
          if (!Number.isInteger(d) || !tasks.has(d)) {
            throw new TaskError(`Task #${String(d)} does not exist${where}. Dependencies must be existing tasks; add chained tasks in separate calls.`);
          }
          if (!deps.includes(d)) deps.push(d);
        }
        return { title, description, folders, deps };
      });

      const out: AddOutcome = { created: [], duplicates: [] };
      const now = ctx.now();
      for (const c of clean) {
        const norm = normalizeTitle(c.title);
        const live = [...tasks.values()].filter(isOpenOrActive);
        // Word overlap only against live tasks; an equal title also matches a done task (its status shows in `existing`).
        const dup = live.find((t) => normalizeTitle(t.title) === norm || jaccard(t.title, c.title) >= LIMITS.duplicateJaccard)
          ?? [...tasks.values()].find((t) => t.status === 'done' && normalizeTitle(t.title) === norm);
        if (dup && !options.force) {
          out.duplicates.push({ title: c.title, existing: clone(dup) });
          continue;
        }
        const similar = [...tasks.values()]
          .filter((t) => t.status !== 'dropped')
          .map((t) => ({ t, score: similarity(t.title, c.title) }))
          .filter((x) => x.score >= SIMILAR_FLOOR)
          .sort((a, b) => b.score - a.score || b.t.id - a.t.id)
          .slice(0, LIMITS.similarTasksShown)
          .map((x) => ({ id: x.t.id, title: x.t.status === 'done' ? `${DONE_MARK} ${x.t.title}` : x.t.title }));
        const t: TaskView = {
          id: nextId++, title: c.title, description: c.description, status: 'open', owner: null, createdBy: actor.callsign,
          dependsOn: c.deps, areas: repo === null ? [] : c.folders.map((folder) => ({ repo, folder })), note: null,
          createdAt: now, updatedAt: now,
        };
        save(t);
        out.created.push({ id: t.id, title: t.title, similar });
        ctx.emit({
          type: 'task.added', actor: actor.callsign, text: `${actor.callsign} added #${t.id} ${t.title}`, data: { id: t.id },
        });
      }
      ctx.sql.exec("INSERT OR REPLACE INTO meta (key, value) VALUES ('next_task_id', ?)", String(nextId)).toArray();
      prune();
      return out;
    },

    claim(actor, id, options): ClaimResult {
      reapEnded();
      const t = need(id);
      if (!isOpenOrActive(t)) throw new TaskError(`Task #${id} is ${t.status}. Pick an open task from \`status\`, or add one.`);
      let tookFrom: Callsign | null = null;
      if (t.status === 'in_progress') {
        if (t.owner === actor.callsign) return { result: 'ok', task: clone(t), reserved: heldFor(actor.callsign, id) };
        const owner = t.owner as Callsign;
        const ownerAgent = ctx.agent(owner);
        const d = ownerAgent ? deriveState(ownerAgent, ctx.now()) : { state: 'ended' as const, takeable: false };
        if (options.take !== true || !d.takeable) return { result: 'taken', owner, ownerState: d.state, takeable: d.takeable };
        const reason = cleanLine(options.reason ?? '', 300);
        if (reason === '') throw new TaskError('Taking over a task needs a reason: pass `reason`.');
        tookFrom = owner;
        features.locks.releaseForTask(id); // the previous owner's folder reservations for this task
        features.messages.notify(
          owner,
          `${actor.callsign} took over your task #${id} ${quoted(t.title)} (their reason, as written by their agent: ${quoted(reason)}). Its folder reservations were released. Stop working on it, and pull before touching related files.`,
        );
      } else {
        const unfinished = unfinishedDeps(t);
        if (unfinished.length > 0) return { result: 'waiting', unfinished };
      }
      t.status = 'in_progress';
      t.owner = actor.callsign;
      t.updatedAt = ctx.now();
      save(t);
      const { reserved, warning } = reserveAreas(actor, t);
      ctx.emit({
        type: tookFrom ? 'task.taken' : 'task.claimed', actor: actor.callsign,
        text: tookFrom ? `${actor.callsign} took over #${id} ${t.title} from ${tookFrom}` : `${actor.callsign} claimed #${id} ${t.title}`,
        data: { id, ...(tookFrom ? { from: tookFrom } : {}) }, wake: [`task:${id}`],
      });
      return { result: 'ok', task: clone(t), reserved, ...(warning ? { warning } : {}) };
    },

    update(actor, id, status, note) {
      reapEnded();
      const t = need(id);
      const isOwner = t.owner === actor.callsign;
      const creatorDrop = !isOwner && t.status === 'open' && t.createdBy === actor.callsign && status === 'dropped';
      if (!isOwner && !creatorDrop) {
        if (t.status === 'in_progress' && t.owner) {
          throw new TaskError(`Only ${t.owner} can update task #${id}. \`post\` to them, or take it over with \`task_claim\` and take: true if they are takeable.`);
        }
        if (t.status === 'open') {
          throw new TaskError(`Task #${id} has no owner. \`task_claim\` it to work on it; only its creator can drop it while it is open.`);
        }
        throw new TaskError(`Task #${id} is ${t.status}; only ${t.owner ?? t.createdBy} can change it.`);
      }
      if (!isOpenOrActive(t)) throw new TaskError(`Task #${id} is already ${t.status}.`);
      if (note !== undefined) t.note = cleanBlock(note, MAX_NOTE).trim() || null;
      t.updatedAt = ctx.now();
      t.status = status;
      if (status === 'open') t.owner = null; // given back
      save(t);
      if (t.status !== 'in_progress') features.locks.releaseForTask(id);
      ctx.emit({
        type: 'task.updated', actor: actor.callsign,
        text: `${actor.callsign} marked #${id} ${t.title} ${status === 'in_progress' ? 'in progress' : status}`,
        data: { id, status }, wake: [`task:${id}`],
      });
      return clone(t);
    },

    briefingLines(actor: Actor): string[] {
      const mine = inProgressFor(actor.callsign);
      return mine ? [`Your task: #${mine.id} ${quoted(mine.title)}`] : [];
    },
  };
  return api;
};
