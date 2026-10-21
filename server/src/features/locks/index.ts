/**
 * File locks (ARCHITECTURE.md §9, all twelve rules, plus room modes).
 * Memory first: the table is loaded once; every mutation is a synchronous check followed by a write in the same
 * turn, so the single-threaded Room decides races strictly in order.
 *
 * What lives where:
 *  - rules 1, 2, 11: checkEdit, conflicting()
 *  - rule 3: applyGitState releases locks whose file is no longer divergent in the holder's checkout
 *  - rule 4: applyGitState attributes shell edits (with the SessionStart baseline) and flags conflicts across checkouts
 *  - rule 5: checkout-mates never conflict with each other in rule 4, and any of them can release a lock by reporting
 *  - rules 6-8: reserve, release, take, releaseAll, purgeEnded
 *  - rules 9, 10: checkEdit with the glob matcher in glob.ts (advisory paths warn, ignored paths are never locked)
 *  - rule 12: lock keys have no branch in them, so a lock covers a file on every branch of the repo
 *  - "a lock you waited for was released": the denied agents are remembered (bounded, recent) and told on release
 */
import {
  LIMITS,
  type Actor, type Callsign, type EditDecision, type FeatureFactory, type GitStateReport, type LockConflict, type LockView,
  type RepoId, type RepoPath, type RoomContext,
} from '../../../../shared/contracts';
import { deriveState } from '../../../../shared/state';
import { canonicalPath } from '../../util';
import { cleanLine } from '../messages/sanitize';
import { pathText } from './framing';
import { matchesAny } from './glob';

interface LockRow {
  key: string;
  repo: RepoId;
  path: RepoPath;
  kind: 'file' | 'folder';
  holder: Callsign;
  checkout: string;
  taskId: number | null;
  reason: string | null;
  acquiredAt: number;
}

export function normalizePath(path: string): string {
  return canonicalPath(path) ?? '';
}

/** A canonical folder ending in '/', or null for anything invalid, empty ('.'), escaping the repo, or inside .git. */
export function normalizeFolder(path: string): string | null {
  const p = canonicalPath(path);
  if (!p) return null;
  const folder = p.endsWith('/') ? p : `${p}/`;
  return isGitPath(folder) ? null : folder;
}

export function lockKey(repo: RepoId, path: RepoPath): string {
  return `${repo.toLowerCase()}:${path.toLowerCase()}`;
}

function isGitPath(path: string): boolean {
  const p = path.toLowerCase();
  return p === '.git' || p.startsWith('.git/');
}

function toView(l: LockRow): LockView {
  return {
    repo: l.repo, path: l.path, kind: l.kind, holder: l.holder, checkout: l.checkout,
    taskId: l.taskId, reason: l.reason, acquiredAt: l.acquiredAt,
  };
}

/** What the server remembers of one agent's last Git report. In memory only, except the baseline. */
interface AgentGit {
  repo: string;
  checkout: string;
  /** Lowercased divergent paths of the last report. */
  divergent: Set<string>;
  /** False after a truncated report: the list is incomplete, so it can't tell what is new. */
  complete: boolean;
  /** When the last report arrived. */
  reportedAt: number;
  /** When the agent last reported that a shell tool had run since its previous report. */
  shellAt: number;
  /** Advisory files this agent edited that its next report has not covered yet (lowercased path to time). */
  touched: Map<string, number>;
}

interface Baseline {
  repo: string;
  paths: Set<string>;
}

/** A conflict between checkouts that was announced: when its edge was last drawn, and who reported it. */
interface SeenConflict {
  reporter: Callsign;
  checkout: string;
  repo: string;
  at: number;
}

/** Rule 4: more new files than this from one shell command is bulk output, not an edit: nobody gets the locks. */
const MAX_ATTRIBUTED = 50;
/** Rule 4: the blocked edge on the dashboard lasts 2 minutes; redraw it while the conflict lasts. */
const EDGE_REFRESH_MS = 90_000;
const MAX_SEEN_CONFLICTS = 500;
/** Who was denied which lock: recent and bounded, so the memory can't grow without limit. */
const DENIED_TTL_MS = 2 * 60 * 60_000;
const MAX_DENIED_LOCKS = 200;
const MAX_DENIED_PER_LOCK = 10;
/** An advisory edit counts as "changed by that agent" this long before its own report confirms it. */
const TOUCH_TTL_MS = 5 * 60_000;
const NOTICE_PATHS = 5;

/** Paths come from teammates' agents: one clean, bounded line in any notice. */
const plain = (s: string, max = 200): string => cleanLine(s, max);

export const createLocks: FeatureFactory<'locks'> = (ctx: RoomContext, features) => {
  ctx.sql.exec(`CREATE TABLE IF NOT EXISTS locks (
    key TEXT PRIMARY KEY, repo TEXT NOT NULL, path TEXT NOT NULL, kind TEXT NOT NULL, holder TEXT NOT NULL,
    checkout TEXT NOT NULL, task_id INTEGER, reason TEXT, acquired_at INTEGER NOT NULL)`).toArray();
  // The SessionStart baseline outlives a Room restart, so shell edits keep being attributed correctly (rule 4).
  ctx.sql.exec('CREATE TABLE IF NOT EXISTS agent_baselines (callsign TEXT PRIMARY KEY, repo TEXT NOT NULL, paths TEXT NOT NULL)').toArray();

  const baselines = new Map<Callsign, Baseline>();
  for (const r of ctx.sql.exec('SELECT * FROM agent_baselines').toArray()) {
    const callsign = String(r.callsign);
    if (!ctx.agent(callsign)) {
      ctx.sql.exec('DELETE FROM agent_baselines WHERE callsign = ?', callsign).toArray();
      continue;
    }
    try {
      const list: unknown = JSON.parse(String(r.paths));
      baselines.set(callsign, { repo: String(r.repo), paths: new Set(Array.isArray(list) ? list.map((p) => String(p).toLowerCase()) : []) });
    } catch {
      ctx.sql.exec('DELETE FROM agent_baselines WHERE callsign = ?', callsign).toArray();
    }
  }
  const gits = new Map<Callsign, AgentGit>();
  const seenConflicts = new Map<string, SeenConflict>();
  const denied = new Map<string, Map<Callsign, number>>();

  const locks = new Map<string, LockRow>();
  for (const r of ctx.sql.exec('SELECT * FROM locks').toArray()) {
    const row: LockRow = {
      key: String(r.key), repo: String(r.repo), path: String(r.path), kind: r.kind === 'folder' ? 'folder' : 'file',
      holder: String(r.holder), checkout: String(r.checkout), taskId: r.task_id === null ? null : Number(r.task_id),
      reason: r.reason === null ? null : String(r.reason), acquiredAt: Number(r.acquired_at),
    };
    locks.set(row.key, row);
  }

  const save = (l: LockRow): void => {
    locks.set(l.key, l);
    ctx.sql.exec(
      'INSERT OR REPLACE INTO locks (key, repo, path, kind, holder, checkout, task_id, reason, acquired_at) VALUES (?,?,?,?,?,?,?,?,?)',
      l.key, l.repo, l.path, l.kind, l.holder, l.checkout, l.taskId, l.reason, l.acquiredAt,
    ).toArray();
  };

  /** Deletes rows, and tells waiters. `why` is the one-line activity text. */
  const drop = (rowsToDrop: LockRow[], type: string, actor: Callsign | null, why: string): LockView[] => {
    if (rowsToDrop.length === 0) return [];
    for (const l of rowsToDrop) {
      locks.delete(l.key);
      ctx.sql.exec('DELETE FROM locks WHERE key = ?', l.key).toArray();
    }
    ctx.emit({
      type, actor, text: why,
      data: { paths: rowsToDrop.map((l) => l.path) },
      wake: rowsToDrop.map((l) => `release:${l.repo}:${l.path}`),
    });
    for (const l of rowsToDrop) tellWaiters(l, actor);
    return rowsToDrop.map(toView);
  };

  const isActive = (callsign: Callsign): boolean => {
    const a = ctx.agent(callsign);
    return !!a && deriveState(a, ctx.now()).state !== 'ended';
  };

  /** Remembers that `callsign` was denied the lock (bounded; the oldest memories go first). */
  const rememberDenied = (key: string, callsign: Callsign): void => {
    const now = ctx.now();
    let who = denied.get(key);
    if (!who) {
      if (denied.size >= MAX_DENIED_LOCKS) {
        for (const [k, w] of denied) {
          for (const [cs, at] of w) if (now - at > DENIED_TTL_MS) w.delete(cs);
          if (w.size === 0) denied.delete(k);
        }
        // Still full: drop the first (oldest-inserted) lock's memory.
        if (denied.size >= MAX_DENIED_LOCKS) denied.delete(denied.keys().next().value as string);
      }
      who = new Map();
      denied.set(key, who);
    }
    who.delete(callsign); // re-insert, so the newest denial is last
    who.set(callsign, now);
    while (who.size > MAX_DENIED_PER_LOCK) who.delete(who.keys().next().value as Callsign);
  };

  /** "A lock you waited for was released" (§11 notices): tells the agents that were denied this lock recently. */
  const tellWaiters = (l: LockRow, releasedBy: Callsign | null): void => {
    const who = denied.get(l.key);
    if (!who) return;
    denied.delete(l.key);
    const now = ctx.now();
    for (const [callsign, at] of who) {
      if (now - at > DENIED_TTL_MS || callsign === releasedBy || callsign === l.holder || !isActive(callsign)) continue;
      features.messages.notify(
        callsign,
        `A lock you waited for was released: ${pathText(l.path)} (was held by ${l.holder}). You can edit it now. If ${l.holder} pushed, pull first.`,
      );
    }
  };

  /** Rule 8, derived: holders that ended (or no longer exist) lose their locks. */
  const purgeEnded = (): void => {
    const gone = new Map<Callsign, LockRow[]>();
    for (const l of locks.values()) {
      const a = ctx.agent(l.holder);
      if (!a || deriveState(a, ctx.now()).state === 'ended') {
        const list = gone.get(l.holder) ?? [];
        list.push(l);
        gone.set(l.holder, list);
      }
    }
    for (const [holder, list] of gone) drop(list, 'lock.released', holder, `${holder} ended; released ${list.length} lock(s)`);
    for (const cs of [...gits.keys()]) if (!isActive(cs)) gits.delete(cs);
    for (const cs of [...baselines.keys()]) {
      if (!isActive(cs)) {
        baselines.delete(cs);
        ctx.sql.exec('DELETE FROM agent_baselines WHERE callsign = ?', cs).toArray();
      }
    }
  };

  /** Rule 11: locks of other agents that conflict with a file or folder path. */
  const conflicting = (repo: RepoId, path: RepoPath, isFolder: boolean, exceptHolder: Callsign | null): LockRow[] => {
    const r = repo.toLowerCase();
    const p = path.toLowerCase();
    const out: LockRow[] = [];
    for (const l of locks.values()) {
      if (l.repo.toLowerCase() !== r || (exceptHolder !== null && l.holder === exceptHolder)) continue;
      const lp = l.path.toLowerCase();
      let hit: boolean;
      if (l.kind === 'file') hit = isFolder ? lp.startsWith(p) : lp === p;
      else hit = p.startsWith(lp) || (isFolder && lp.startsWith(p));
      if (hit) out.push(l);
    }
    return out;
  };

  const conflictOf = (l: LockRow): LockConflict => {
    const a = ctx.agent(l.holder);
    const d = a ? deriveState(a, ctx.now()) : { state: 'ended' as const, takeable: false };
    return {
      repo: l.repo, path: l.path, holder: l.holder, kind: l.kind, taskId: l.taskId,
      holderState: d.state, takeable: d.takeable,
    };
  };

  const currentTask = (callsign: Callsign): number | null => features.tasks.inProgressFor(callsign)?.id ?? null;

  /** The memory of an agent's last report, reset when it moves to another repo or checkout. */
  const gitOf = (actor: Actor, repo: RepoId): AgentGit => {
    const r = repo.toLowerCase();
    const checkout = actor.checkout ?? '';
    let g = gits.get(actor.callsign);
    if (!g || g.repo !== r || g.checkout !== checkout) {
      g = { repo: r, checkout, divergent: new Set(), complete: false, reportedAt: 0, shellAt: 0, touched: new Map() };
      gits.set(actor.callsign, g);
    }
    return g;
  };

  /**
   * Rule 9: an advisory path is never denied, but the agent hears who else has unpushed changes to it. Agents in the
   * same checkout share the working copy, so they don't count. Also notes that this agent touched the path.
   */
  const advisoryNotes = (actor: Actor, repo: RepoId, advisory: string[]): string[] => {
    if (advisory.length === 0) return [];
    const r = repo.toLowerCase();
    const now = ctx.now();
    const mine = gitOf(actor, repo);
    const notes: string[] = [];
    for (const p of advisory) {
      const lower = p.toLowerCase();
      const others: Callsign[] = [];
      for (const [callsign, g] of gits) {
        if (callsign === actor.callsign || g.repo !== r || g.checkout === (actor.checkout ?? '') || !isActive(callsign)) continue;
        const touchedAt = g.touched.get(lower);
        if (g.divergent.has(lower) || (touchedAt !== undefined && now - touchedAt <= TOUCH_TTL_MS)) others.push(callsign);
      }
      mine.touched.set(lower, now);
      if (others.length === 0) continue;
      const names = others.slice(0, 3).join(', ') + (others.length > 3 ? ` and ${others.length - 3} more` : '');
      notes.push(
        `[Hivemind] Heads-up: ${pathText(p)} is a shared file and ${names} also ${others.length === 1 ? 'has' : 'have'} unpushed changes to it. ` +
        "Your edit goes ahead; merge carefully and don't overwrite their changes.",
      );
    }
    if (mine.touched.size > 200) for (const k of mine.touched.keys()) { mine.touched.delete(k); if (mine.touched.size <= 100) break; }
    return notes;
  };

  return {
    checkEdit(actor, repo, paths): EditDecision {
      const mode = ctx.mode();
      if (mode === 'off') return { allow: true, conflicts: [], notes: [] };
      purgeEnded();
      const settings = ctx.settings(repo);
      const wanted: string[] = [];
      const advisory: string[] = [];
      const seen = new Set<string>();
      for (const raw of paths) {
        const p = normalizePath(raw);
        if (!p || isGitPath(p) || seen.has(p.toLowerCase())) continue;
        seen.add(p.toLowerCase());
        if (matchesAny(settings.ignore, p)) continue; // rule 10: never locked, never denied
        if (matchesAny(settings.advisory, p)) advisory.push(p); // rule 9: never denied (and, so it can't deny anyone, never locked)
        else wanted.push(p);
      }
      const conflicts: LockConflict[] = [];
      const conflicted = new Set<string>();
      const listed = new Set<string>();
      for (const p of wanted) {
        for (const l of conflicting(repo, p, false, actor.callsign)) {
          conflicted.add(p.toLowerCase());
          if (!listed.has(l.key)) {
            listed.add(l.key);
            conflicts.push(conflictOf(l));
          }
        }
      }
      if (conflicts.length > 0 && mode === 'enforce') {
        for (const c of conflicts) rememberDenied(lockKey(c.repo, c.path), actor.callsign);
        return { allow: false, conflicts, notes: [] };
      }
      const notes = conflicts.map((c) => `[Hivemind] Heads-up: ${pathText(c.path)} is held by ${c.holder} (${c.kind}). Room mode is warn, so the edit proceeds.`);
      notes.push(...advisoryNotes(actor, repo, advisory));
      const taskId = currentTask(actor.callsign);
      for (const p of wanted) {
        if (conflicted.has(p.toLowerCase())) continue;
        const key = lockKey(repo, p);
        if (locks.has(key)) continue; // rule 1: editing takes a file lock, even under the actor's own folder reservation
        save({ key, repo, path: p, kind: 'file', holder: actor.callsign, checkout: actor.checkout ?? '', taskId, reason: null, acquiredAt: ctx.now() });
      }
      return { allow: true, conflicts, notes };
    },

    applyGitState(actor: Actor, repo: RepoId, state: GitStateReport, shellSinceHeartbeat: boolean): void {
      const now = ctx.now();
      const r = repo.toLowerCase();
      const checkout = actor.checkout ?? '';
      purgeEnded();
      // Report paths in their own letter case, by lowercase key.
      const reported = new Map<string, string>();
      for (const raw of state.divergent) {
        const p = normalizePath(raw);
        if (p && !isGitPath(p)) reported.set(p.toLowerCase(), p);
      }

      // Rule 3: release by divergence. A truncated list never releases anything.
      if (!state.truncated) {
        const release: LockRow[] = [];
        // A lock taken after the report was computed (parallel tool calls) must survive it: leave young locks alone.
        const youngAfter = now - LIMITS.heartbeatMs;
        // Exception: a file this very report says was pushed (and that is not divergent again) is released at any age.
        const pushed = new Set<string>();
        for (const f of state.pushed?.files ?? []) {
          const p = normalizePath(f.path);
          if (p) pushed.add(p.toLowerCase());
        }
        for (const l of locks.values()) {
          if (l.kind !== 'file' || l.repo.toLowerCase() !== r) continue;
          // Rules 3 and 5: only a report from the lock's own checkout counts, whichever agent in it sent the report.
          if (!actor.checkout || l.checkout !== actor.checkout) continue;
          const key = l.path.toLowerCase();
          if (l.acquiredAt > youngAfter && !pushed.has(key)) continue;
          if (!reported.has(key)) release.push(l);
        }
        drop(release, 'lock.released', actor.callsign, `${actor.callsign}: ${release.length} file(s) no longer divergent, released`);
      }

      // What this agent reported last time (for "what is new") and its baseline (for "what was already there").
      const g = gitOf(actor, repo);
      const previous = g.complete ? g.divergent : null;
      const previousAt = g.reportedAt;
      if (state.baseline) {
        const paths = new Set(state.baseline.map((p) => normalizePath(p).toLowerCase()).filter(Boolean));
        baselines.set(actor.callsign, { repo: r, paths });
        ctx.sql.exec('INSERT OR REPLACE INTO agent_baselines (callsign, repo, paths) VALUES (?,?,?)', actor.callsign, r, JSON.stringify([...paths])).toArray();
      }
      const base = baselines.get(actor.callsign);
      const baseline = base && base.repo === r ? base.paths : null;

      if (ctx.mode() !== 'off' && actor.checkout) {
        const settings = ctx.settings(repo);
        // Settings patterns are matched once per path, however many rules ask.
        const managed = new Map<string, boolean>();
        const isManaged = (lower: string, p: string): boolean => {
          let m = managed.get(lower);
          if (m === undefined) {
            m = !matchesAny(settings.ignore, p) && !matchesAny(settings.advisory, p);
            managed.set(lower, m);
          }
          return m;
        };
        /** Rule 4 only attributes files that were not already there when the agent started. */
        const lockable = (lower: string, p: string): boolean => !baseline?.has(lower) && isManaged(lower, p);

        // Rule 4: a new divergent file nobody holds, that this agent's shell probably made, is locked for it.
        if (shellSinceHeartbeat && !state.truncated && !state.baseline && previous && baseline) {
          const fresh: string[] = [];
          for (const [lower, p] of reported) {
            if (previous.has(lower) || !lockable(lower, p)) continue;
            if (conflicting(repo, p, false, null).length > 0) continue; // somebody holds it (or a folder over it)
            fresh.push(p);
          }
          // "With no clear author, it's locked for nobody": another agent in this checkout ran a shell command since
          // this agent's previous report, or has not reported since then (so nobody knows whether it did), or a whole
          // tree of files appeared at once (generated output).
          const ambiguous = ctx.agents().some((a) => {
            if (a.callsign === actor.callsign || (a.repo ?? '').toLowerCase() !== r || (a.checkout ?? '') !== checkout || !isActive(a.callsign)) return false;
            const o = gits.get(a.callsign);
            return !o || o.repo !== r || o.checkout !== checkout || o.reportedAt <= previousAt || o.shellAt > previousAt;
          });
          if (!ambiguous && fresh.length > 0 && fresh.length <= MAX_ATTRIBUTED) {
            const taskId = currentTask(actor.callsign);
            for (const p of fresh) {
              save({ key: lockKey(repo, p), repo, path: p, kind: 'file', holder: actor.callsign, checkout, taskId, reason: 'shell edit', acquiredAt: now });
            }
            ctx.emit({
              type: 'lock.shell', actor: actor.callsign,
              text: `${actor.callsign} changed ${fresh.length} file(s) through the shell; locked (${fresh.slice(0, 3).map((p) => pathText(p)).join(', ')}${fresh.length > 3 ? ', …' : ''})`,
              data: { paths: fresh.slice(0, 20) },
            });
          }
        }

        // Rule 4 (second half) and rule 5: a divergent file held by an agent in a different checkout is a conflict.
        // Agents in the same checkout share these files and never conflict with each other.
        // A file the reporter already had changed when it started still conflicts with a lock another checkout holds
        // (the other agent is changing it now); only the attribution of rule 4 looks at the baseline.
        // Per holder: files the holder has a lock on, and files that are only inside a folder it reserved.
        const found = new Map<string, { holder: string; folder: boolean; paths: string[]; fresh: boolean }>();
        const current = new Set<string>();
        for (const [lower, p] of reported) {
          if (!isManaged(lower, p)) continue;
          for (const l of conflicting(repo, p, false, actor.callsign)) {
            if (l.checkout === checkout || !isActive(l.holder)) continue;
            const key = `${l.key}|${checkout}|${lower}`;
            current.add(key);
            const seen = seenConflicts.get(key);
            const group = `${l.holder}|${l.kind}`;
            const entry = found.get(group) ?? { holder: l.holder, folder: l.kind === 'folder', paths: [], fresh: false };
            if (!seen) entry.fresh = true;
            if (!seen || now - seen.at >= EDGE_REFRESH_MS) {
              seenConflicts.set(key, { reporter: actor.callsign, checkout, repo: r, at: now });
              entry.paths.push(p);
            }
            found.set(group, entry);
          }
        }
        for (const entry of found.values()) {
          if (entry.paths.length === 0) continue;
          const holder = entry.holder;
          const shown = entry.paths.slice(0, NOTICE_PATHS).map((p) => pathText(p)).join(', ') + (entry.paths.length > NOTICE_PATHS ? `, +${entry.paths.length - NOTICE_PATHS} more` : '');
          const many = entry.paths.length === 1 ? 'is' : 'are';
          if (entry.fresh) {
            features.messages.notify(
              actor.callsign,
              entry.folder
                ? `Conflict: ${shown} ${many} inside a folder reserved by ${holder} in another checkout (unpushed). Nothing was blocked, because the edit had already happened. Coordinate with ${holder} (\`post\`) before you push, so one of you merges the other's work.`
                : `Conflict: ${shown} ${many} also changed by ${holder} in another checkout (unpushed). Nothing was blocked, because the edit had already happened. Coordinate with ${holder} (\`post\`) before you push, so one of you merges the other's work.`,
            );
            features.messages.notify(
              holder,
              entry.folder
                ? `Conflict: ${actor.callsign} changed ${shown}, inside a folder you reserved, in another checkout. Nothing was blocked, because the edit had already happened. Coordinate with ${actor.callsign} (\`post\`) before you push, so one of you merges the other's work.`
                : `Conflict: ${actor.callsign} changed ${shown}, which you hold, in another checkout. Nothing was blocked, because the edit had already happened. Coordinate with ${actor.callsign} (\`post\`) before you push, so one of you merges the other's work.`,
            );
          }
          const first = entry.paths[0] as string;
          ctx.emit({
            type: 'lock.conflict', actor: actor.callsign,
            text: entry.folder
              ? `${actor.callsign} changed ${pathText(first)}${entry.paths.length > 1 ? ` (+${entry.paths.length - 1})` : ''} inside a folder reserved by ${holder}, in a different checkout`
              : `${actor.callsign} and ${holder} both changed ${pathText(first)}${entry.paths.length > 1 ? ` (+${entry.paths.length - 1})` : ''} in different checkouts`,
            data: { path: first, holder },
            pulse: { kind: 'denied', from: actor.callsign, to: holder, path: first },
            edge: { kind: 'blocked', from: actor.callsign, to: holder, label: plain(first.split('/').pop() ?? first, 80) },
          });
        }
        // Conflicts that are gone (pushed, reverted, released) may be announced again if they come back.
        if (!state.truncated) {
          for (const [key, s] of seenConflicts) if (s.reporter === actor.callsign && s.checkout === checkout && !current.has(key)) seenConflicts.delete(key);
        }
        if (seenConflicts.size > MAX_SEEN_CONFLICTS) {
          for (const k of seenConflicts.keys()) { seenConflicts.delete(k); if (seenConflicts.size <= MAX_SEEN_CONFLICTS / 2) break; }
        }
      }

      // Remember this report. An advisory edit is forgotten once the report shows the file (or a whole interval passed
      // and it still doesn't: reverted or pushed).
      g.divergent = new Set(reported.keys());
      g.complete = !state.truncated;
      g.reportedAt = now;
      if (shellSinceHeartbeat) g.shellAt = now;
      for (const [lower, at] of g.touched) if (g.divergent.has(lower) || now - at > LIMITS.heartbeatMs) g.touched.delete(lower);
    },

    reserve(actor, folders, reason, taskId) {
      purgeEnded();
      const wanted = new Map<string, { repo: RepoId; folder: string }>();
      for (const f of folders) {
        const folder = normalizeFolder(f.folder);
        // Never reserve the whole repo by accident: any invalid folder refuses the whole request.
        if (folder === null) return { granted: false, conflicts: [] };
        wanted.set(lockKey(f.repo, folder), { repo: f.repo, folder });
      }
      const conflicts: LockConflict[] = [];
      const listed = new Set<string>();
      for (const w of wanted.values()) {
        for (const l of conflicting(w.repo, w.folder, true, actor.callsign)) {
          if (!listed.has(l.key)) {
            listed.add(l.key);
            conflicts.push(conflictOf(l));
          }
        }
      }
      if (conflicts.length > 0 || wanted.size === 0) return { granted: false, conflicts };
      for (const [key, w] of wanted) {
        const existing = locks.get(key);
        save({
          key, repo: w.repo, path: w.folder, kind: 'folder', holder: actor.callsign, checkout: actor.checkout ?? '',
          taskId, reason, acquiredAt: existing && existing.holder === actor.callsign ? existing.acquiredAt : ctx.now(),
        });
      }
      ctx.emit({ type: 'lock.reserved', actor: actor.callsign, text: `${actor.callsign} reserved ${[...wanted.values()].map((w) => w.folder).join(', ')}` });
      return { granted: true, conflicts: [] };
    },

    release(actor, paths) {
      let targets: LockRow[];
      if (!paths) {
        targets = [...locks.values()].filter((l) => l.holder === actor.callsign);
      } else {
        targets = [];
        for (const p of paths) {
          const norm = normalizePath(p.path);
          const l = locks.get(lockKey(p.repo, norm)) ?? locks.get(lockKey(p.repo, `${norm}/`));
          if (l && l.holder === actor.callsign && !targets.includes(l)) targets.push(l);
        }
      }
      return drop(targets, 'lock.released', actor.callsign, `${actor.callsign} released ${targets.map((l) => l.path).join(', ')}`);
    },

    take(actor, repo, path, reason) {
      purgeEnded();
      const norm = normalizePath(path);
      if (!norm) return { ok: false, error: 'No path given.' };
      const l = locks.get(lockKey(repo, norm)) ?? locks.get(lockKey(repo, `${norm}/`));
      if (!l) {
        const cover = conflicting(repo, norm, false, actor.callsign)[0];
        if (cover) return { ok: false, error: `${norm} is covered by ${cover.kind} lock ${cover.path} held by ${cover.holder}. Take ${cover.path} instead.` };
        return { ok: false, error: `Nobody holds ${norm}. You can edit it directly.` };
      }
      if (l.holder === actor.callsign) return { ok: true };
      const c = conflictOf(l);
      if (!c.takeable) {
        return { ok: false, error: `${l.holder} is ${c.holderState} and not takeable (a holder becomes takeable after 15 minutes of idle or quiet). Use \`post\` to ask, or \`wait\`.` };
      }
      const previous = l.holder;
      save({ ...l, holder: actor.callsign, checkout: actor.checkout ?? '', taskId: currentTask(actor.callsign), reason, acquiredAt: ctx.now() });
      features.messages.notify(
        previous,
        `${actor.callsign} took your ${l.kind} lock on ${l.path} (reason: ${reason}). Pull and reconcile before you continue with it.`,
      );
      ctx.emit({ type: 'lock.taken', actor: actor.callsign, text: `${actor.callsign} took ${l.path} from ${previous}`, data: { path: l.path, from: previous } });
      return { ok: true };
    },

    releaseForTask(taskId) {
      const targets = [...locks.values()].filter((l) => l.kind === 'folder' && l.taskId === taskId);
      drop(targets, 'lock.released', null, `task #${taskId} finished; released ${targets.length} reservation(s)`);
    },

    releaseAll(callsign) {
      const targets = [...locks.values()].filter((l) => l.holder === callsign);
      drop(targets, 'lock.released', callsign, `${callsign} released all locks (${targets.length})`);
    },

    unlockPath(repo, path) {
      const norm = normalizePath(path);
      const isFolder = path.endsWith('/');
      const targets = conflicting(repo, norm, isFolder, null);
      return drop(targets, 'lock.unlocked', null, `Emergency unlock of ${norm}`);
    },

    holdings(callsign) {
      return [...locks.values()].filter((l) => l.holder === callsign).map(toView);
    },

    list() {
      purgeEnded();
      return [...locks.values()].sort((a, b) => a.acquiredAt - b.acquiredAt || (a.key < b.key ? -1 : 1)).map(toView);
    },
  };
};
