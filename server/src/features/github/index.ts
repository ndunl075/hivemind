/**
 * GitHub push webhook (ARCHITECTURE.md §12 "Pushes outside agent sessions", §13): learns about pushes and merges that
 * happen outside any agent session (a person's own clone, a pull request merged on github.com) and tells the repo's
 * active agents.
 *
 * A webhook can only produce a notice and a `lastPush` row, through the same PushesApi the hook's reports use. It
 * never takes, releases or grants a lock, task or setting.
 *
 * - Binding: the webhook is created inside a project (`hivemind webhook`), which binds it to that repo's root commit id
 *   and its GitHub `owner/name`. A delivery whose `repository.full_name` differs is ignored; there is no matching by
 *   short name, so an unrelated repo with the same name can't receive another's pushes.
 * - Dedupe: a push is held for a grace period (the hook reports a push on its next heartbeat). If an agent reported
 *   the same commit on the same branch meanwhile, the whole webhook push is dropped. A file whose latest row is newer
 *   than the push is never overwritten. A delivery repeated (same branch, before and after) is ignored for 24 hours.
 *   Held pushes of one branch collapse into one.
 * - Stale-copy checks: the payload has no blob SHAs. Rows get an empty blob, except where an agent on another branch
 *   reported the file in the last 24 hours: its blob is kept, so a squash merge of that branch doesn't warn the author.
 * - The held pushes are delivered by flushDue(), which the Room calls after every request (there are no alarms).
 */
import { LIMITS, type Actor, type Features, type Millis, type RoomContext } from '../../../../shared/contracts';
import { pathText } from '../locks/framing';
import { parsePush, type GithubPush } from './payload';

export { parsePush, pusherLabel } from './payload';
export { verifySignature, webhookSecret } from './signature';

/** Least time a push waits for an agent's own report of it. */
export const GRACE_MS = 20_000;
/** Held pushes delivered per flush; the rest wait for the next request. */
export const FLUSH_BATCH = 20;
const MINUTE_MS = 60_000;

export interface GithubBinding {
  /** Root commit id of the repo the webhook was created in. */
  repo: string;
  /** `owner/name` on GitHub, lowercase. */
  fullName: string;
}

export type Receipt =
  | { ok: true; status: 'queued' | 'duplicate' }
  | { ok: false; status: 'ignored'; reason: string }
  | { ok: false; status: 'invalid'; reason: string };

export interface GithubApi {
  /** Validates and queues one verified `push` delivery (raw JSON text) for the bound repo. */
  receive(body: string, binding: GithubBinding): Receipt;
  /** Delivers held pushes whose grace period is over (at most FLUSH_BATCH). Cheap when nothing is due. Never throws. */
  flushDue(): void;
}

export interface GithubOptions {
  /** The grace period; the Room lengthens it while the budget guard slows heartbeats. */
  graceMs?: () => Millis;
}

interface Held {
  repo: string; fullName: string; branch: string; before: string; sha: string; pusher: string;
  files: string[]; incomplete: boolean; pushAt: Millis; receivedAt: Millis;
}

export function createGithub(ctx: RoomContext, features: Features, options: GithubOptions = {}): GithubApi {
  ctx.sql.exec(`CREATE TABLE IF NOT EXISTS github_pushes (
    repo TEXT NOT NULL, full_name TEXT NOT NULL, branch TEXT NOT NULL, before_sha TEXT NOT NULL, sha TEXT NOT NULL,
    pusher TEXT NOT NULL, files TEXT NOT NULL, incomplete INTEGER NOT NULL, push_at INTEGER NOT NULL,
    received_at INTEGER NOT NULL, done INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (full_name, branch, before_sha, sha))`).toArray();

  const graceMs = (): Millis => Math.max(GRACE_MS, options.graceMs?.() ?? 0);
  let nextDue = Number.POSITIVE_INFINITY;
  let lastPrune = 0;

  const refreshDue = (): void => {
    const row = ctx.sql.exec('SELECT MIN(received_at) AS t FROM github_pushes WHERE done = 0').toArray()[0];
    nextDue = row && row.t !== null && row.t !== undefined ? Number(row.t) + graceMs() : Number.POSITIVE_INFINITY;
  };
  refreshDue();

  const finish = (r: Record<string, unknown>): void => {
    ctx.sql.exec(
      "UPDATE github_pushes SET done = 1, files = '[]' WHERE full_name = ? AND branch = ? AND before_sha = ? AND sha = ?",
      String(r.full_name), String(r.branch), String(r.before_sha), String(r.sha),
    ).toArray();
  };

  /** True when an agent's hook already reported this commit on this branch (the whole push is then not news). */
  const reportedByAgent = (repo: string, branch: string, sha: string): boolean =>
    ctx.sql.exec("SELECT 1 AS x FROM pushes WHERE repo = ? AND branch = ? AND lower(sha) = ? AND callsign NOT LIKE 'github:%' LIMIT 1", repo, branch, sha).toArray().length > 0;

  const deliver = (p: Held): void => {
    if (p.files.length === 0) return;
    if (reportedByAgent(p.repo, p.branch, p.sha)) return;
    const actor: Actor = { callsign: p.pusher, person: 'github', kind: 'claude', repo: p.repo, checkout: null };
    const known = new Map(features.pushes.latest(actor, p.repo, p.files).map((l) => [l.path.toLowerCase(), l]));
    const rows: Array<{ path: string; blob: string }> = [];
    for (const path of p.files) {
      const l = known.get(path.toLowerCase());
      if (l && l.at > p.pushAt) continue; // a newer push of this file is the better answer
      // An agent's report of this file on another branch (the pull request's branch) has the content a squash or
      // fast-forward merge brings, so keep its blob: the author's agent then isn't warned about its own change.
      const blob = l && !l.by.startsWith('github:') && l.branch !== p.branch ? l.blob : '';
      rows.push({ path, blob });
    }
    if (rows.length === 0) return;
    features.pushes.record(actor, p.repo, { branch: p.branch, sha: p.sha, files: rows });
    if (p.incomplete) {
      features.messages.notify(
        '*',
        `${p.pusher} pushed ${pathText(p.branch, 100)}; GitHub lists only some of the files of a push that large, so more files than named may have changed. Pull before editing.`,
        { repo: p.repo, exclude: [p.pusher] },
      );
    }
  };

  return {
    receive(body, binding): Receipt {
      let raw: unknown;
      try { raw = JSON.parse(body); } catch { return { ok: false, status: 'invalid', reason: 'payload is not JSON' }; }
      const now = ctx.now();
      const parsed = parsePush(raw, now);
      if (!parsed.ok) {
        return 'ignore' in parsed ? { ok: false, status: 'ignored', reason: parsed.ignore } : { ok: false, status: 'invalid', reason: parsed.error };
      }
      const push: GithubPush = parsed.push;
      if (push.fullName !== binding.fullName.toLowerCase()) {
        return { ok: false, status: 'ignored', reason: 'this webhook is bound to a different repository' };
      }
      const seen = ctx.sql.exec(
        'SELECT 1 AS x FROM github_pushes WHERE full_name = ? AND branch = ? AND before_sha = ? AND sha = ?', push.fullName, push.branch, push.before, push.after,
      ).toArray();
      if (seen.length > 0) return { ok: true, status: 'duplicate' };

      // Held pushes of this branch collapse into this one: it carries their files too.
      let files = push.files;
      let incomplete = push.incomplete;
      for (const old of ctx.sql.exec('SELECT * FROM github_pushes WHERE full_name = ? AND branch = ? AND done = 0', push.fullName, push.branch).toArray()) {
        try {
          const merged = new Set([...(JSON.parse(String(old.files)) as string[]), ...files]);
          files = [...merged].slice(0, LIMITS.maxDivergentPaths);
          incomplete = incomplete || Number(old.incomplete) === 1 || merged.size > LIMITS.maxDivergentPaths;
        } catch { /* a corrupt row adds nothing */ }
        finish(old);
      }
      const pushAt = push.commitAt !== null && push.commitAt <= now ? push.commitAt : now;
      ctx.sql.exec(
        'INSERT INTO github_pushes (repo, full_name, branch, before_sha, sha, pusher, files, incomplete, push_at, received_at, done) VALUES (?,?,?,?,?,?,?,?,?,?,0)',
        binding.repo, push.fullName, push.branch, push.before, push.after, push.by, JSON.stringify(files), incomplete ? 1 : 0, pushAt, now,
      ).toArray();
      refreshDue();
      return { ok: true, status: 'queued' };
    },

    flushDue(): void {
      try {
        const now = ctx.now();
        if (now < nextDue && now - lastPrune < MINUTE_MS) return;
        const due = ctx.sql.exec(
          'SELECT * FROM github_pushes WHERE done = 0 AND received_at <= ? ORDER BY received_at LIMIT ?', now - graceMs(), FLUSH_BATCH,
        ).toArray();
        for (const r of due) {
          try {
            // A push held longer than the retention time is no longer news.
            if (now - Number(r.received_at) <= LIMITS.pushTtlMs) {
              deliver({
                repo: String(r.repo), fullName: String(r.full_name), branch: String(r.branch), before: String(r.before_sha), sha: String(r.sha),
                pusher: String(r.pusher), files: JSON.parse(String(r.files)) as string[], incomplete: Number(r.incomplete) === 1,
                pushAt: Number(r.push_at), receivedAt: Number(r.received_at),
              });
            }
          } catch { /* a bad row must not stop the others or the request that triggered the flush */ }
          finish(r);
        }
        if (now - lastPrune >= MINUTE_MS) {
          lastPrune = now;
          ctx.sql.exec('DELETE FROM github_pushes WHERE received_at < ?', now - LIMITS.pushTtlMs).toArray();
        }
        refreshDue();
      } catch { /* the webhook must never fail the request it rides on */ }
    },
  };
}
