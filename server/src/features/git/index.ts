/**
 * Pushes (ARCHITECTURE.md §12): the latest push per file, the push notice to the other agents of the repo, and
 * the `lastPush` list the hook gets back on an edit (the hook compares it with the local copy: the stale-copy check).
 *
 * `createPushes` implements PushesApi from shared/contracts.ts. The Room builds it as `features.pushes`.
 */
import { LIMITS, type FeatureFactory, type LastPush } from '../../../../shared/contracts';
import { deriveState } from '../../../../shared/state';
import { cleanLine } from '../messages/sanitize';
import { pushNotice } from './notice';

export { pushNotice } from './notice';

/** A repo cannot report more than this many pushed files at once (the hook sends at most 500). */
const MAX_FILES = LIMITS.maxDivergentPaths;

export const createPushes: FeatureFactory<'pushes'> = (ctx, features) => {
  ctx.sql.exec(`CREATE TABLE IF NOT EXISTS pushes (
    repo TEXT NOT NULL, path TEXT NOT NULL, callsign TEXT NOT NULL, branch TEXT NOT NULL, sha TEXT NOT NULL,
    blob TEXT NOT NULL, pushed_at INTEGER NOT NULL, PRIMARY KEY (repo, path))`).toArray();

  const k = (repo: string, path: string): string => `${repo.toLowerCase()}:${path.toLowerCase()}`;
  const latestByPath = new Map<string, LastPush & { repo: string }>();
  for (const r of ctx.sql.exec('SELECT * FROM pushes').toArray()) {
    const p = {
      repo: String(r.repo), path: String(r.path), by: String(r.callsign), branch: String(r.branch),
      sha: String(r.sha), blob: String(r.blob), at: Number(r.pushed_at),
    };
    latestByPath.set(k(p.repo, p.path), p);
  }

  /** Rows older than 24 hours go (§4 retention). */
  const expire = (): void => {
    const cutoff = ctx.now() - LIMITS.pushTtlMs;
    let any = false;
    for (const [key, p] of latestByPath) {
      if (p.at < cutoff) {
        latestByPath.delete(key);
        any = true;
      }
    }
    if (any) ctx.sql.exec('DELETE FROM pushes WHERE pushed_at < ?', cutoff).toArray();
  };

  return {
    record(actor, repo, push): void {
      const files = push.files.slice(0, MAX_FILES);
      if (files.length === 0) return;
      const now = ctx.now();
      expire();
      // The hook reports a push again if the answer to its first report was lost: the same agent, commit and blobs
      // are the same push, and the other agents have been told already.
      const repeat = files.every((f) => {
        const old = latestByPath.get(k(repo, f.path));
        return !!old && old.by === actor.callsign && old.sha === push.sha && old.blob === f.blob;
      });
      if (repeat) return;

      for (const f of files) {
        const old = latestByPath.get(k(repo, f.path));
        if (old && old.path !== f.path) ctx.sql.exec('DELETE FROM pushes WHERE repo = ? AND path = ?', old.repo, old.path).toArray();
        latestByPath.set(k(repo, f.path), { repo, path: f.path, sha: push.sha, blob: f.blob, by: actor.callsign, branch: push.branch, at: now });
        ctx.sql.exec(
          'INSERT OR REPLACE INTO pushes (repo, path, callsign, branch, sha, blob, pushed_at) VALUES (?,?,?,?,?,?,?)',
          repo, f.path, actor.callsign, push.branch, push.sha, f.blob, now,
        ).toArray();
      }

      // One notice to every other active agent of the repo. Agents in the pusher's own checkout share its
      // working copy, so they already have what was pushed; ended agents will never read it.
      const skip = ctx.agents()
        .filter((a) => a.callsign !== actor.callsign && (
          deriveState(a, now).state === 'ended' || (a.repo === repo && actor.checkout !== null && a.checkout === actor.checkout)))
        .map((a) => a.callsign);
      features.messages.notify('*', pushNotice(actor.callsign, push.branch, files.map((f) => f.path)), {
        repo, exclude: [actor.callsign, ...skip],
      });

      const first = files[0]?.path;
      ctx.emit({
        type: 'push', actor: actor.callsign,
        text: `${actor.callsign} pushed ${cleanLine(push.branch, 100)} (${files.length} file${files.length === 1 ? '' : 's'})`,
        data: { branch: push.branch, sha: push.sha, files: files.map((f) => f.path) },
        pulse: { kind: 'push', from: actor.callsign, ...(first ? { path: first } : {}) },
      });
    },

    latest(actor, repo, paths): LastPush[] {
      const cutoff = ctx.now() - LIMITS.pushTtlMs;
      const out: LastPush[] = [];
      for (const path of paths) {
        const p = latestByPath.get(k(repo, path));
        if (p && p.at >= cutoff && p.by !== actor.callsign) {
          out.push({ path: p.path, sha: p.sha, blob: p.blob, by: p.by, branch: p.branch, at: p.at });
        }
      }
      return out;
    },
  };
};

export const createGit = createPushes;
