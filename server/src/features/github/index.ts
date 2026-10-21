/**
 * GitHub push webhook (ARCHITECTURE.md §12 "Pushes outside agent sessions", §13): learns about pushes and merges that
 * happen outside any agent session (a person's own clone, a pull request merged on github.com) and tells the repo's
 * active agents.
 *
 * A webhook can only produce a notice and a `lastPush` row, through the same PushesApi the hook's reports use. It
 * never takes, releases or grants a lock, task or setting.
 *
 * - Mapping: agents report their repo's `origin` display name (the URL's last segment); the payload carries
 *   `repository.name`. A push belongs to the repo id of the agents whose display name equals it (case-insensitive).
 *   No agent of that name: nothing to tell, and the push is dropped. Agents of two different repos with the same
 *   name: ambiguous, the push is dropped rather than risk a wrong notice.
 * - Dedupe: a push is held for a grace period (the hook reports a push on its next heartbeat). If an agent reported
 *   the same commit on the same branch meanwhile, the webhook adds nothing for those files. The same delivery twice
 *   (a replay or a redelivery) is a no-op for 24 hours.
 * - Stale-copy checks: the payload has no blob SHAs, so rows are recorded with an empty blob. The hook then warns
 *   unless the pushed commit (`after`) is in the agent's HEAD; it can't use the "same content" shortcut.
 * - The deferred notices are sent by flushDue(), which the Room calls after every request (there are no alarms).
 */
import { LIMITS, type Actor, type Features, type Millis, type RoomContext } from '../../../../shared/contracts';
import { parsePush, type GithubPush } from './payload';

export { parsePush, pusherLabel } from './payload';
export { verifySignature, webhookSecret } from './signature';

/** Least time a push waits for an agent's own report of it. */
export const GRACE_MS = 20_000;
const MINUTE_MS = 60_000;
const DELIVERIES_PER_MINUTE = 60;

export type Receipt =
  | { ok: true; status: 'queued' | 'duplicate' }
  | { ok: false; status: 'ignored'; reason: string }
  | { ok: false; status: 'invalid'; reason: string }
  | { ok: false; status: 'rate-limited' };

export interface GithubApi {
  /** Validates and queues one verified `push` delivery (raw JSON text). */
  receive(body: string): Receipt;
  /** Sends the notices of queued pushes whose grace period is over. Cheap when nothing is due. */
  flushDue(): void;
}

export interface GithubOptions {
  /** The grace period; the Room lengthens it while the budget guard slows heartbeats. */
  graceMs?: () => Millis;
}

export function createGithub(ctx: RoomContext, features: Features, options: GithubOptions = {}): GithubApi {
  ctx.sql.exec(`CREATE TABLE IF NOT EXISTS github_pushes (
    full_name TEXT NOT NULL, branch TEXT NOT NULL, sha TEXT NOT NULL, repo_name TEXT NOT NULL, pusher TEXT NOT NULL,
    files TEXT NOT NULL, received_at INTEGER NOT NULL, done INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (full_name, branch, sha))`).toArray();

  const graceMs = (): Millis => Math.max(GRACE_MS, options.graceMs?.() ?? 0);
  const deliveryTimes: Millis[] = [];
  let nextDue = Number.POSITIVE_INFINITY;
  let lastPrune = 0;

  const refreshDue = (): void => {
    const row = ctx.sql.exec('SELECT MIN(received_at) AS t FROM github_pushes WHERE done = 0').toArray()[0];
    nextDue = row && row.t !== null && row.t !== undefined ? Number(row.t) + graceMs() : Number.POSITIVE_INFINITY;
  };
  refreshDue();

  const allowDelivery = (now: Millis): boolean => {
    while (deliveryTimes.length > 0 && now - (deliveryTimes[0] as number) >= MINUTE_MS) deliveryTimes.shift();
    if (deliveryTimes.length >= DELIVERIES_PER_MINUTE) return false;
    deliveryTimes.push(now);
    return true;
  };

  /** The repo id the push belongs to, or null (no agent of that name, or two repos share it). */
  const resolveRepo = (repoName: string): string | null => {
    const ids = new Set<string>();
    for (const a of ctx.agents()) if (a.repo && a.repoName?.toLowerCase() === repoName) ids.add(a.repo);
    return ids.size === 1 ? ([...ids][0] as string) : null;
  };

  const deliver = (p: { branch: string; sha: string; repoName: string; pusher: string; files: string[]; receivedAt: Millis }): void => {
    const repo = resolveRepo(p.repoName);
    if (!repo || p.files.length === 0) return;
    const actor: Actor = { callsign: p.pusher, person: 'github', kind: 'claude', repo, checkout: null };
    // What agents and earlier webhooks already know. An agent's own report of this commit (same branch) covers its files.
    const known = new Map(features.pushes.latest(actor, repo, p.files).map((l) => [l.path.toLowerCase(), l]));
    const files = p.files.filter((path) => {
      const l = known.get(path.toLowerCase());
      if (!l) return true;
      if (l.sha === p.sha && l.branch === p.branch) return false; // reported already
      return l.at <= p.receivedAt; // a newer push of this file is the better answer
    });
    if (files.length === 0) return;
    features.pushes.record(actor, repo, { branch: p.branch, sha: p.sha, files: files.map((path) => ({ path, blob: '' })) });
  };

  return {
    receive(body): Receipt {
      let raw: unknown;
      try { raw = JSON.parse(body); } catch { return { ok: false, status: 'invalid', reason: 'payload is not JSON' }; }
      const parsed = parsePush(raw);
      if (!parsed.ok) {
        return 'ignore' in parsed ? { ok: false, status: 'ignored', reason: parsed.ignore } : { ok: false, status: 'invalid', reason: parsed.error };
      }
      const now = ctx.now();
      if (!allowDelivery(now)) return { ok: false, status: 'rate-limited' };
      const push: GithubPush = parsed.push;
      const seen = ctx.sql.exec('SELECT 1 AS x FROM github_pushes WHERE full_name = ? AND branch = ? AND sha = ?', push.fullName, push.branch, push.after).toArray();
      if (seen.length > 0) return { ok: true, status: 'duplicate' };
      ctx.sql.exec(
        'INSERT INTO github_pushes (full_name, branch, sha, repo_name, pusher, files, received_at, done) VALUES (?,?,?,?,?,?,?,0)',
        push.fullName, push.branch, push.after, push.repoName, push.by, JSON.stringify(push.files), now,
      ).toArray();
      refreshDue();
      return { ok: true, status: 'queued' };
    },

    flushDue(): void {
      const now = ctx.now();
      if (now < nextDue && now - lastPrune < MINUTE_MS) return;
      const due = ctx.sql.exec('SELECT * FROM github_pushes WHERE done = 0 AND received_at <= ? ORDER BY received_at', now - graceMs()).toArray();
      for (const r of due) {
        try {
          deliver({
            branch: String(r.branch), sha: String(r.sha), repoName: String(r.repo_name), pusher: String(r.pusher),
            files: JSON.parse(String(r.files)) as string[], receivedAt: Number(r.received_at),
          });
        } catch (e) { /* a bad row must not stop the others or the request that triggered the flush */ }
        ctx.sql.exec('UPDATE github_pushes SET done = 1 WHERE full_name = ? AND branch = ? AND sha = ?', String(r.full_name), String(r.branch), String(r.sha)).toArray();
      }
      if (now - lastPrune >= MINUTE_MS) {
        lastPrune = now;
        ctx.sql.exec('DELETE FROM github_pushes WHERE received_at < ?', now - LIMITS.pushTtlMs).toArray();
      }
      refreshDue();
    },
  };
}
