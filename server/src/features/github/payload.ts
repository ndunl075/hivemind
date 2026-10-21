/**
 * Reads a GitHub `push` payload (https://docs.github.com/en/webhooks/webhook-events-and-payloads#push). Pure.
 * Everything in it is text from GitHub (and ultimately from whoever pushed): it is validated, bounded and reduced to
 * a few plain fields. Commit messages and author names are never read.
 */
import { LIMITS } from '../../../../shared/contracts';
import { canonicalPath } from '../../util';

/** GitHub lists at most 20 commits in a push payload, newest last; a push of more has files we cannot see. */
export const GITHUB_COMMIT_CAP = 20;
const MAX_PATH_CHARS = 400;
const ZERO_SHA = /^0+$/;

export interface GithubPush {
  /** `owner/name`, lowercase. */
  fullName: string;
  /** `name`, lowercase: the key to the agents' origin display name. */
  repoName: string;
  branch: string;
  /** The SHA the branch pointed to before the push (empty for a new branch). */
  before: string;
  /** The SHA the branch points to after the push. */
  after: string;
  /** When GitHub received the push (`repository.pushed_at`, ms), if the payload says. Not the commit's own date. */
  pushedAt: number | null;
  /** Ids of the commits the payload lists (at most 20), lowercase. */
  commitIds: string[];
  /** Who pushed, reduced to a safe `github:<login>` label. */
  by: string;
  files: string[];
  /** True when the payload may not list every changed file (20 commits, or more files than we keep). */
  incomplete: boolean;
}

/** A push GitHub received longer ago than this is a late redelivery, not news. */
export const MAX_PUSH_AGE_MS = LIMITS.pushTtlMs;

export type PushParse = { ok: true; push: GithubPush } | { ok: false; ignore: string } | { ok: false; error: string };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** `github:octocat`: letters, digits and `._-` only, so a pusher name can't carry text or pose as an agent callsign. */
export function pusherLabel(raw: unknown): string {
  const login = typeof raw === 'string' ? raw.replace(/[^A-Za-z0-9._-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 39) : '';
  return `github:${login || 'someone'}`;
}

export function parsePush(raw: unknown, now: number = Date.now()): PushParse {
  if (!isObj(raw)) return { ok: false, error: 'payload must be a JSON object' };
  const repo = raw.repository;
  const fullName = isObj(repo) && typeof repo.full_name === 'string' ? repo.full_name.trim() : '';
  const name = isObj(repo) && typeof repo.name === 'string' ? repo.name.trim() : '';
  if (!/^[^/\s]{1,100}\/[^/\s]{1,100}$/.test(fullName) || !name || name.length > 100) return { ok: false, error: 'payload has no repository' };
  const ref = raw.ref;
  if (typeof ref !== 'string' || ref.length > 300) return { ok: false, error: 'payload has no ref' };
  if (!ref.startsWith('refs/heads/')) return { ok: false, ignore: 'not a branch push' };
  const branch = ref.slice('refs/heads/'.length);
  if (!branch) return { ok: false, error: 'payload has no branch' };
  const after = raw.after;
  if (typeof after !== 'string' || !/^[0-9a-f]{40,64}$/i.test(after)) return { ok: false, error: 'payload has no after commit' };
  if (raw.deleted === true || ZERO_SHA.test(after)) return { ok: false, ignore: 'branch deleted' };

  const before = typeof raw.before === 'string' && /^[0-9a-f]{40,64}$/i.test(raw.before) && !ZERO_SHA.test(raw.before) ? raw.before.toLowerCase() : '';
  // In push events `repository.pushed_at` is epoch seconds (other events send an ISO string). The commit dates are the
  // authors' and say nothing about when the push happened, so they are not used.
  const pushedRaw = isObj(repo) ? repo.pushed_at : undefined;
  const pushedMs = typeof pushedRaw === 'number' ? pushedRaw * 1000 : typeof pushedRaw === 'string' ? Date.parse(pushedRaw) : Number.NaN;
  const pushedAt = Number.isFinite(pushedMs) && pushedMs > 0 ? pushedMs : null;
  if (pushedAt !== null && now - pushedAt > MAX_PUSH_AGE_MS) return { ok: false, ignore: 'the push is more than 24 hours old' };

  const commits = Array.isArray(raw.commits) ? raw.commits : [];
  const seen = new Set<string>();
  const files: string[] = [];
  let incomplete = commits.length >= GITHUB_COMMIT_CAP;
  const add = (list: unknown): void => {
    if (!Array.isArray(list)) return;
    for (const p of list) {
      if (typeof p !== 'string' || p.length > MAX_PATH_CHARS) continue;
      const canon = canonicalPath(p);
      if (!canon || canon.endsWith('/') || seen.has(canon)) continue;
      if (files.length >= LIMITS.maxDivergentPaths) { incomplete = true; return; }
      seen.add(canon);
      files.push(canon);
    }
  };
  const commitIds = commits.flatMap((c) => (isObj(c) && typeof c.id === 'string' && /^[0-9a-f]{7,64}$/i.test(c.id) ? [c.id.toLowerCase()] : [])).slice(0, GITHUB_COMMIT_CAP);
  const all = [...commits];
  if (isObj(raw.head_commit)) all.push(raw.head_commit);
  for (const c of all) {
    if (!isObj(c)) continue;
    add(c.added);
    add(c.modified);
    add(c.removed);
  }
  if (files.length === 0) return { ok: false, ignore: 'no changed files in the payload' };

  const pusher = isObj(raw.pusher) ? raw.pusher.name : undefined;
  const sender = isObj(raw.sender) ? raw.sender.login : undefined;
  return {
    ok: true,
    push: {
      fullName: fullName.toLowerCase(), repoName: name.toLowerCase(), branch, before, after: after.toLowerCase(), pushedAt, commitIds,
      by: pusherLabel(typeof sender === 'string' && sender ? sender : pusher), files, incomplete,
    },
  };
}
