/**
 * Pushes (ARCHITECTURE.md §12): the latest push per file, the push notice to the other agents of the repo, and
 * the `lastPush` list the hook gets back on an edit (the hook compares it with the local copy: the stale-copy check).
 *
 * `createPushes` implements PushesApi from shared/contracts.ts. The Room builds it as `features.pushes`.
 */
import { LIMITS, type FeatureFactory, type LastPush } from '../../../../shared/contracts';
import { cleanLine } from '../messages/sanitize';
import { pushNotice } from './notice';

export { pushNotice } from './notice';

/** A repo cannot report more than this many pushed files at once (the hook sends at most 500). */
const MAX_FILES = LIMITS.maxDivergentPaths;
/** The latest push per file is kept for at most this many files per repo; the oldest go first. */
const MAX_ROWS_PER_REPO = 2_000;
/** One agent's push notices per minute; the push itself is always recorded. */
const NOTICES_PER_MINUTE = 6;
const MINUTE_MS = 60_000;

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

  /** The last push each agent reported (repo, commit and files), so a retry of an old report can't replace newer pushes. */
  const lastReported = new Map<string, string>();
  /** When each agent's recent push notices went out. */
  const noticeTimes = new Map<string, number[]>();

  /** Keeps a repo's rows to the newest MAX_ROWS_PER_REPO. */
  const capRows = (repo: string): void => {
    const rows = [...latestByPath.entries()].filter(([, p]) => p.repo.toLowerCase() === repo.toLowerCase());
    if (rows.length <= MAX_ROWS_PER_REPO) return;
    rows.sort((a, b) => a[1].at - b[1].at);
    for (const [key, p] of rows.slice(0, rows.length - MAX_ROWS_PER_REPO)) {
      latestByPath.delete(key);
      ctx.sql.exec('DELETE FROM pushes WHERE repo = ? AND path = ?', p.repo, p.path).toArray();
    }
  };

  /** True when this agent may send another notice now (and counts it). */
  const noticeAllowed = (callsign: string, now: number): boolean => {
    const recent = (noticeTimes.get(callsign) ?? []).filter((t) => now - t < MINUTE_MS);
    if (recent.length >= NOTICES_PER_MINUTE) {
      noticeTimes.set(callsign, recent);
      return false;
    }
    recent.push(now);
    noticeTimes.set(callsign, recent);
    if (noticeTimes.size > 500) for (const [cs, ts] of noticeTimes) if (ts.every((t) => now - t >= MINUTE_MS)) noticeTimes.delete(cs);
    return true;
  };

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
      // The same report again, after other agents pushed the same files since: not a new push.
      const signature = `${repo}|${push.sha}|${files.map((f) => `${f.path}=${f.blob}`).join(',')}`;
      if (lastReported.get(actor.callsign) === signature) return;
      lastReported.set(actor.callsign, signature);
      if (lastReported.size > 500) for (const key of lastReported.keys()) { lastReported.delete(key); if (lastReported.size <= 250) break; }

      for (const f of files) {
        const old = latestByPath.get(k(repo, f.path));
        // Pushes are ordered by arrival; the hook only reports a push once (lastReported), so the latest report wins.
        if (old && old.path !== f.path) ctx.sql.exec('DELETE FROM pushes WHERE repo = ? AND path = ?', old.repo, old.path).toArray();
        latestByPath.set(k(repo, f.path), { repo, path: f.path, sha: push.sha, blob: f.blob, by: actor.callsign, branch: push.branch, at: now });
        ctx.sql.exec(
          'INSERT OR REPLACE INTO pushes (repo, path, callsign, branch, sha, blob, pushed_at) VALUES (?,?,?,?,?,?,?)',
          repo, f.path, actor.callsign, push.branch, push.sha, f.blob, now,
        ).toArray();
      }

      capRows(repo);

      // One notice to every other agent of the repo (an ended agent never reads it, so it isn't listed). Agents in the
      // pusher's own checkout share its working copy, so they already have what was pushed.
      const mates = ctx.agents()
        .filter((a) => a.callsign !== actor.callsign && a.repo === repo && actor.checkout !== null && a.checkout === actor.checkout)
        .map((a) => a.callsign);
      if (noticeAllowed(actor.callsign, now)) {
        features.messages.notify('*', pushNotice(actor.callsign, push.branch, files.map((f) => f.path)), {
          repo, exclude: [actor.callsign, ...mates],
        });
      }

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
