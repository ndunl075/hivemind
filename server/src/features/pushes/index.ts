/**
 * Basic pushes (ARCHITECTURE.md §12): the latest push per file, answering lastPush. The push notice text
 * to other agents is W5's (git-layer).
 */
import { LIMITS, type FeatureFactory, type LastPush } from '../../../../shared/contracts';

export const createPushes: FeatureFactory<'pushes'> = (ctx) => {
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
      const now = ctx.now();
      expire();
      for (const f of push.files) {
        const key = k(repo, f.path);
        const old = latestByPath.get(key);
        if (old) ctx.sql.exec('DELETE FROM pushes WHERE repo = ? AND path = ?', old.repo, old.path).toArray();
        latestByPath.set(key, { repo, path: f.path, sha: push.sha, blob: f.blob, by: actor.callsign, branch: push.branch, at: now });
        ctx.sql.exec('INSERT INTO pushes (repo, path, callsign, branch, sha, blob, pushed_at) VALUES (?,?,?,?,?,?,?)',
          repo, f.path, actor.callsign, push.branch, push.sha, f.blob, now).toArray();
      }
      const first = push.files[0]?.path;
      ctx.emit({
        type: 'push', actor: actor.callsign,
        text: `${actor.callsign} pushed ${push.branch} (${push.files.length} file${push.files.length === 1 ? '' : 's'})`,
        data: { branch: push.branch, sha: push.sha, files: push.files.map((f) => f.path) },
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
