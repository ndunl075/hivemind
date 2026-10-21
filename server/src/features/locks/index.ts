/**
 * Basic file locks (ARCHITECTURE.md §9 rules 1-3, 6, 7, 8 and 11, plus room modes).
 * Memory first: the table is loaded once; every mutation is a synchronous check followed by a write in the same
 * turn, so the single-threaded Room decides races strictly in order.
 *
 * Not here yet (W5 git-layer): advisory and ignore globs (rules 9, 10), shell-edit attribution and cross-checkout
 * conflict notices (rules 4, 5). Only the always-ignored `.git/` is handled.
 */
import {
  LIMITS,
  type Actor, type Callsign, type EditDecision, type FeatureFactory, type GitStateReport, type LockConflict, type LockView,
  type RepoId, type RepoPath, type RoomContext,
} from '../../../../shared/contracts';
import { deriveState } from '../../../../shared/state';
import { canonicalPath } from '../../util';

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

export function normalizeFolder(path: string): string {
  const p = normalizePath(path);
  return p.endsWith('/') ? p : `${p}/`;
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

export const createLocks: FeatureFactory<'locks'> = (ctx: RoomContext, features) => {
  ctx.sql.exec(`CREATE TABLE IF NOT EXISTS locks (
    key TEXT PRIMARY KEY, repo TEXT NOT NULL, path TEXT NOT NULL, kind TEXT NOT NULL, holder TEXT NOT NULL,
    checkout TEXT NOT NULL, task_id INTEGER, reason TEXT, acquired_at INTEGER NOT NULL)`).toArray();

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
    return rowsToDrop.map(toView);
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

  return {
    checkEdit(actor, repo, paths): EditDecision {
      const mode = ctx.mode();
      if (mode === 'off') return { allow: true, conflicts: [], notes: [] };
      purgeEnded();
      const wanted: string[] = [];
      const seen = new Set<string>();
      for (const raw of paths) {
        const p = normalizePath(raw);
        if (!p || isGitPath(p) || seen.has(p.toLowerCase())) continue;
        seen.add(p.toLowerCase());
        wanted.push(p);
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
      if (conflicts.length > 0 && mode === 'enforce') return { allow: false, conflicts, notes: [] };
      const notes = conflicts.map((c) => `[Hivemind] Heads-up: ${c.path} is held by ${c.holder} (${c.kind}). Room mode is warn, so the edit proceeds.`);
      const taskId = currentTask(actor.callsign);
      for (const p of wanted) {
        if (conflicted.has(p.toLowerCase())) continue;
        const key = lockKey(repo, p);
        if (locks.has(key)) continue; // rule 1: editing takes a file lock, even under the actor's own folder reservation
        save({ key, repo, path: p, kind: 'file', holder: actor.callsign, checkout: actor.checkout ?? '', taskId, reason: null, acquiredAt: ctx.now() });
      }
      return { allow: true, conflicts, notes };
    },

    applyGitState(actor: Actor, repo: RepoId, state: GitStateReport, _shellSinceHeartbeat: boolean): void {
      // Rule 3: a truncated list never releases anything.
      if (state.truncated) return;
      const divergent = new Set(state.divergent.map((p) => normalizePath(p).toLowerCase()));
      const r = repo.toLowerCase();
      const release: LockRow[] = [];
      // A lock taken after the report was computed (parallel tool calls) must survive it: leave young locks alone.
      const youngAfter = ctx.now() - LIMITS.heartbeatMs;
      for (const l of locks.values()) {
        if (l.kind !== 'file' || l.repo.toLowerCase() !== r) continue;
        // Rules 3 and 5: only a report from the lock's own checkout counts, whichever agent in it sent the report.
        if (!actor.checkout || l.checkout !== actor.checkout) continue;
        if (l.acquiredAt > youngAfter) continue;
        if (!divergent.has(l.path.toLowerCase())) release.push(l);
      }
      drop(release, 'lock.released', actor.callsign, `${actor.callsign}: ${release.length} file(s) no longer divergent, released`);
    },

    reserve(actor, folders, reason, taskId) {
      purgeEnded();
      const wanted = new Map<string, { repo: RepoId; folder: string }>();
      for (const f of folders) {
        const folder = normalizeFolder(f.folder);
        if (folder === '/' || isGitPath(folder)) continue;
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
      if (conflicts.length > 0 || wanted.size === 0) return { granted: conflicts.length === 0, conflicts };
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
