/**
 * Git module (ARCHITECTURE.md §6.3, §12). Implements GitModule from shared/hook-modules.ts.
 * Repo identity, the comparison point of a branch, divergent files (capped at 500), push detection, blob SHAs and
 * the stale-copy check. Every Git call is read-only and runs with GIT_OPTIONAL_LOCKS=0, so the hook never takes
 * the index lock and can't make an agent's own `git commit` fail.
 * @typedef {import('../../shared/hook-modules').Identity} Identity
 * @typedef {import('../../shared/hook-modules').GitMemory} GitMemory
 * @typedef {import('../../shared/contracts').GitStateReport} GitStateReport
 * @typedef {import('../../shared/contracts').LastPush} LastPush
 */
import { execFile } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { HOOK_LIMITS } from './limits.mjs';

export const GIT_ENV_OVERRIDES = Object.freeze({
  GIT_OPTIONAL_LOCKS: '0', // never take the index lock
  GIT_NO_LAZY_FETCH: '1', // a partial clone must not fetch objects from the network on our behalf
  GIT_TERMINAL_PROMPT: '0', // never wait for a credential prompt
  GCM_INTERACTIVE: 'never',
});
const GIT_TIMEOUT_MS = 2_000;

/**
 * The only place Git is run.
 * @param {string[]} args
 * @param {string} cwd
 * @param {number} [timeout]
 * @returns {Promise<string>}
 */
function git(args, cwd, timeout = GIT_TIMEOUT_MS) {
  return new Promise((resolveRun, reject) => {
    execFile(
      'git', args,
      { cwd, env: { ...process.env, ...GIT_ENV_OVERRIDES }, timeout, killSignal: 'SIGKILL', maxBuffer: 32 * 1024 * 1024, windowsHide: true, encoding: 'utf8' },
      (err, stdout) => (err ? reject(err) : resolveRun(stdout)),
    );
  });
}

/**
 * @param {Promise<string>} p
 * @returns {Promise<string | null>}
 */
function orNull(p) {
  return p.then((s) => s.trim() || null, () => null);
}

/**
 * Display name from an origin URL (https, scp-like) or a local path (Windows drive or UNC path, POSIX absolute path,
 * file:// URL): the last path segment without `.git`. Null when there is none.
 * @param {string | null} url
 * @returns {string | null}
 */
export function repoNameOf(url) {
  if (!url) return null;
  const text = url.trim();
  const local = /^[A-Za-z]:[\\/]/.test(text) || text.startsWith('\\\\') || text.startsWith('/') || /^file:/i.test(text);
  // A local path may contain `:` (a drive letter); only a remote URL treats it as a separator.
  const separators = local ? /[\\/]/ : /[\\/:]/;
  const trimmed = text.replace(/[\\/]+$/, '');
  if (/^[a-z][a-z0-9+.-]*:\/\/[^/\\]*$/i.test(trimmed)) return null; // host (and port) only: no repository in it
  const parts = trimmed.split(separators).filter(Boolean);
  if (parts.length > 1 && (parts[parts.length - 1] ?? '').toLowerCase() === '.git') parts.pop(); // a work tree's .git directory
  const last = (parts.pop() ?? '').replace(/\.git$/i, '');
  return last ? last.slice(0, 200) : null;
}

/**
 * @param {string} cwd
 * @returns {Promise<Identity | null>}
 */
export async function identity(cwd) {
  try {
    const [top, roots, branch, head, origin] = await Promise.all([
      git(['rev-parse', '--show-toplevel'], cwd),
      git(['rev-list', '--max-parents=0', 'HEAD'], cwd),
      orNull(git(['symbolic-ref', '--short', '-q', 'HEAD'], cwd)),
      orNull(git(['rev-parse', '--short', 'HEAD'], cwd)),
      orNull(git(['remote', 'get-url', 'origin'], cwd)),
    ]);
    const repo = roots.split('\n').map((s) => s.trim()).filter(Boolean).sort()[0];
    const root = top.trim();
    if (!repo || !root) return null;
    return { root: resolve(root), repo, repoName: repoNameOf(origin), branch, head };
  } catch {
    return null;
  }
}

/**
 * Only branch and head, for the periodic refresh (identity does four more Git calls).
 * @param {string} root
 * @returns {Promise<{ branch: string | null; head: string | null }>}
 */
export async function refs(root) {
  const [branch, head] = await Promise.all([
    orNull(git(['symbolic-ref', '--short', '-q', 'HEAD'], root)),
    orNull(git(['rev-parse', '--short', 'HEAD'], root)),
  ]);
  return { branch, head };
}

/**
 * Windows extended-length prefixes: `\\?\C:\x` becomes `C:\x`, `\\?\UNC\h\s` becomes `\\h\s`.
 * @param {string} p
 * @returns {string}
 */
function stripExtended(p) {
  if (/^\\\\[?.]\\UNC\\/i.test(p)) return `\\\\${p.slice(8)}`;
  if (/^\\\\[?.]\\/.test(p)) return p.slice(4);
  return p;
}

/**
 * The path with symlinks resolved and the on-disk letter case, for the nearest existing ancestor
 * (the file itself may not exist yet). Falls back to the input.
 * @param {string} p
 * @returns {string}
 */
function real(p) {
  let cur = p;
  /** @type {string[]} */
  const tail = [];
  for (;;) {
    try {
      return resolve(stripExtended(realpathSync.native(cur)), ...tail);
    } catch {
      const up = dirname(cur);
      if (up === cur) return p;
      tail.unshift(cur.slice(up.length).replace(/^[\\/]+/, ''));
      cur = up;
    }
  }
}

/**
 * @param {string} root
 * @param {string} abs
 * @returns {string | null} repo-relative POSIX path, or null when outside the checkout, at the root, or inside any `.git`
 */
function relInside(root, abs) {
  const rel = relative(root, abs);
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  const segments = rel.split(sep);
  if (segments.some((s) => s.toLowerCase() === '.git')) return null;
  return segments.join('/');
}

/**
 * @param {string} root
 * @param {string} cwd
 * @param {string[]} paths
 * @returns {string[]}
 */
export function normalize(root, cwd, paths) {
  /** @type {string[]} */
  const out = [];
  const realRoot = real(stripExtended(root));
  const realCwd = real(stripExtended(cwd));
  for (const p of paths) {
    if (typeof p !== 'string' || p === '') continue;
    const clean = stripExtended(p);
    // On-disk case and resolved links first; the literal path is the fallback.
    const rel = relInside(realRoot, real(resolve(realCwd, clean))) ?? relInside(resolve(root), resolve(cwd, clean));
    if (rel && !out.includes(rel)) out.push(rel);
  }
  return out;
}


/** Git's all-zero object name: a file that doesn't exist at that side of a diff, or was deleted by a push. */
const NULL_SHA = '0'.repeat(40);
const STATE_BUDGET_MS = 1_200;

/**
 * True for failures that say nothing about the repository (a timeout, a kill, a spawn error), as opposed to Git
 * exiting with a status.
 * @param {unknown} err
 * @returns {boolean}
 */
function isHard(err) {
  return !err || typeof (/** @type {{ code?: unknown }} */ (err)).code !== 'number';
}

/**
 * Paths from `status --porcelain=v1 -z`, including both sides of a rename.
 * @param {string} out
 * @returns {string[]}
 */
function parseStatus(out) {
  /** @type {Set<string>} */
  const files = new Set();
  const parts = out.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i] ?? '';
    if (entry.length < 4) continue;
    const xy = entry.slice(0, 2);
    files.add(entry.slice(3));
    if (xy.includes('R') || xy.includes('C')) {
      // A rename or copy is followed by the original path as its own NUL-separated field.
      i++;
      const orig = parts[i];
      if (orig && xy.includes('R')) files.add(orig);
    }
  }
  return [...files];
}

/**
 * Remote-tracking refs: name without `refs/remotes/`, tip, and the target when the ref is a symbolic ref
 * (`origin/HEAD`).
 * @param {string | null} out
 * @returns {Map<string, { sha: string; symref: string }>}
 */
function parseRemoteRefs(out) {
  /** @type {Map<string, { sha: string; symref: string }>} */
  const map = new Map();
  for (const line of (out ?? '').split('\n')) {
    const [ref, sha, symref] = line.split('\0');
    if (!ref || !ref.startsWith('refs/remotes/')) continue;
    map.set(ref.slice('refs/remotes/'.length), { sha: sha ?? '', symref: (symref ?? '').replace(/^refs\/remotes\//, '') });
  }
  return map;
}

/**
 * Remote names, `origin` first.
 * @param {string | null} out
 * @returns {string[]}
 */
function parseRemotes(out) {
  const names = (out ?? '').split('\n').map((s) => s.trim()).filter(Boolean);
  return names.includes('origin') ? ['origin', ...names.filter((n) => n !== 'origin')] : names;
}

/**
 * The branch part of a remote-tracking name: `origin/feature/x` is `feature/x`.
 * @param {string} name
 * @param {string[]} remotes
 * @returns {string}
 */
function branchOfRef(name, remotes) {
  const remote = remotes.filter((r) => name.startsWith(`${r}/`)).sort((a, b) => b.length - a.length)[0];
  return remote ? name.slice(remote.length + 1) : name;
}

/**
 * Paths of a NUL-separated name list.
 * @param {string | null} out
 * @returns {string[]}
 */
function nulList(out) {
  return (out ?? '').split('\0').filter(Boolean);
}

/**
 * @typedef {(args: string[], cwd: string, timeout: number) => Promise<string>} GitExec
 * @typedef {(args: string[], timeout?: number) => Promise<string>} Run  Git in the repo, inside the state() deadline.
 * @typedef {GitMemory & { branch?: string | null; head?: string | null; mergeBase?: { head: string; target: string; base: string } | null }} Memory
 */

/**
 * @param {Run} g
 * @param {string[]} args
 * @returns {Promise<boolean>} whether Git exited 0; a timeout or spawn failure throws
 */
function ok(g, args) {
  return g(args).then(() => true, (e) => { if (isHard(e)) throw e; return false; });
}

/**
 * @param {Run} g
 * @param {string[]} args
 * @returns {Promise<string | null>} trimmed output, null when Git exited with a status; a timeout or spawn failure throws
 */
function soft(g, args) {
  return g(args).then((s) => s.trim() || null, (e) => { if (isHard(e)) throw e; return null; });
}

/**
 * The comparison point of the current branch (§12), in order: its configured upstream; a remote-tracking branch
 * with the same name on any remote (`origin` first); the merge base with the remote's default branch. Null only when
 * there genuinely is none (no remote, no default branch, nothing in common); any other failure throws.
 * @param {Run} g
 * @param {{ branch: string | null; head: string | null; upstream: string | null; refs: Map<string, { sha: string; symref: string }>; remotes: string[]; previous: Memory | null }} i
 * @returns {Promise<{ name: string; sha: string; mergeBase?: { head: string; target: string; base: string } } | null>}
 */
async function comparisonPoint(g, i) {
  if (!i.head) return null;
  if (i.upstream) {
    const tracked = i.refs.get(i.upstream);
    const sha = tracked?.sha || await soft(g, ['rev-parse', '--verify', '-q', '--end-of-options', `${i.upstream}^{commit}`]);
    if (sha) return { name: i.upstream, sha };
  }
  if (i.branch) {
    for (const remote of i.remotes) {
      const name = `${remote}/${i.branch}`;
      const tracked = i.refs.get(name);
      if (tracked?.sha) return { name, sha: tracked.sha };
    }
  }
  for (const remote of i.remotes) {
    const target = i.refs.get(`${remote}/HEAD`)?.symref;
    const names = [target, `${remote}/main`, `${remote}/master`].filter((n) => !!n && i.refs.has(/** @type {string} */ (n)));
    for (const name of /** @type {string[]} */ (names)) {
      const tip = i.refs.get(name)?.sha ?? '';
      const cached = i.previous?.mergeBase;
      if (cached && tip && cached.head === i.head && cached.target === tip) return { name, sha: cached.base, mergeBase: cached };
      const base = await soft(g, ['merge-base', '--end-of-options', 'HEAD', name]);
      if (base) return { name, sha: base, mergeBase: tip ? { head: i.head, target: tip, base } : undefined };
    }
  }
  return null;
}

/**
 * Files that went out in a push (§12): in the previous divergent set, changed between the old comparison point and
 * HEAD, not dirty now, with their blob SHAs in HEAD. Null when nothing was pushed.
 * @param {Run} g
 * @param {Memory} previous
 * @param {{ name: string; sha: string }} now
 * @param {string} head
 * @param {string | null} branch
 * @param {string[]} remotes
 * @param {Set<string>} dirty
 * @returns {Promise<GitStateReport['pushed']>}
 */
async function detectPush(g, previous, now, head, branch, remotes, dirty) {
  const before = previous.comparison;
  if (!before || before.sha === now.sha || previous.divergent.length === 0 || !previous.head) return null;
  // With no commit made here since the previous report, HEAD only moved by pulling or checking out other people's
  // work: files that were merely edited then are not ours to report, even if a teammate pushed the same path (§12).
  // Only what was already committed ahead of the old comparison point can have gone out. An unreadable or short
  // reflog says nothing, so then every previously divergent file stays eligible.
  /** @type {Set<string> | null} */
  let committedBefore = null;
  const log = await soft(g, ['reflog', 'show', '--format=%H %gs', '-n', '200', 'HEAD', '--']);
  if (log !== null) {
    const entries = log.split('\n');
    const seen = entries.findIndex((l) => l.startsWith(previous.head ?? '\0'));
    if (seen >= 0 && !entries.slice(0, seen).some((l) => /^\S+ (commit|cherry-pick|rebase|revert|am)\b/.test(l))) {
      const out = await soft(g, ['diff', '--name-only', '-z', '--no-renames', '--no-ext-diff', '--end-of-options', `${before.sha}...${previous.head}`, '--']);
      committedBefore = new Set(nulList(out));
    }
  }
  // HEAD must now be contained in the comparison point (a fetch alone leaves local commits outside it).
  if (!(await ok(g, ['merge-base', '--is-ancestor', '--end-of-options', head, now.sha]))) return null;
  const raw = await soft(g, ['diff', '--raw', '-z', '--no-renames', '--no-ext-diff', '--no-abbrev', '--end-of-options', before.sha, head, '--']);
  if (!raw) return null;
  // Our old HEAD is part of today's history (commit and push, pull, merge); when it is not (a rebase, or a reset to
  // the remote) a file only counts if its content is unchanged since then. A reset onto teammates' work discards ours.
  let changedSince = new Set();
  if (!(await ok(g, ['merge-base', '--is-ancestor', '--end-of-options', previous.head, head]))) {
    const diff = await soft(g, ['diff', '--name-only', '-z', '--no-renames', '--no-ext-diff', '--end-of-options', previous.head, head, '--']);
    if (diff === null && !(await ok(g, ['cat-file', '-e', '--end-of-options', `${previous.head}^{commit}`]))) return null;
    changedSince = new Set(nulList(diff));
  }
  const mine = new Set(committedBefore ? previous.divergent.filter((p) => committedBefore.has(p)) : previous.divergent);
  /** @type {{ path: string; blob: string }[]} */
  const files = [];
  const parts = raw.split('\0');
  for (let i = 0; i + 1 < parts.length; i += 2) {
    // ':100644 100644 <old blob> <new blob> M', then the path.
    const meta = (parts[i] ?? '').split(' ');
    const path = parts[i + 1] ?? '';
    if (mine.has(path) && !dirty.has(path) && !changedSince.has(path)) files.push({ path, blob: meta[3] ?? NULL_SHA });
  }
  if (files.length === 0) return null;
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { branch: branchOfRef(now.name, remotes) || branch || 'HEAD', sha: head, files: files.slice(0, HOOK_LIMITS.maxDivergentPaths) };
}

/**
 * §12 Git state. Never reports an incomplete divergent list as complete: when the comparison point is missing, a
 * lookup or the committed diff fails, or the time budget runs out, the report is marked `truncated` (and after a
 * timeout it is status-only, with the previous memory kept so a later heartbeat can still see a push).
 * @param {string} root
 * @param {GitMemory | null} previous
 * @param {{ budgetMs?: number; exec?: GitExec }} [options]
 *   `exec` replaces the Git runner (tests slow it down).
 * @returns {Promise<{ report: GitStateReport; memory: GitMemory }>}
 */
export async function state(root, previous, options = {}) {
  const prev = /** @type {Memory | null} */ (previous);
  const exec = options.exec ?? git;
  // HIVEMIND_GIT_BUDGET_MS is test-only: it lets slow CI runners finish Git work that production would cut off.
  const deadline = Date.now() + (options.budgetMs ?? (Number(process.env.HIVEMIND_GIT_BUDGET_MS) || STATE_BUDGET_MS));
  /** @type {Run} */
  const g = (args, timeout = GIT_TIMEOUT_MS) => {
    const left = deadline - Date.now();
    if (left <= 0) return Promise.reject(Object.assign(new Error('git time budget exceeded'), { code: 'EDEADLINE' }));
    return exec(args, root, Math.min(timeout, left));
  };

  const statusOut = await g(['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  const dirtyFiles = parseStatus(statusOut);
  try {
    const [branch, head, refsOut, remotesOut, upstream] = await Promise.all([
      soft(g, ['symbolic-ref', '--short', '-q', 'HEAD']),
      soft(g, ['rev-parse', '--verify', '-q', 'HEAD']),
      g(['for-each-ref', '--format=%(refname)%00%(objectname)%00%(symref)', 'refs/remotes']),
      g(['remote']),
      soft(g, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']),
    ]);
    const refs = parseRemoteRefs(refsOut);
    const remotes = parseRemotes(remotesOut);
    const cp = await comparisonPoint(g, { branch, head, upstream, refs, remotes, previous: prev });

    // Divergent files: working tree and staged changes, plus commits not yet at the comparison point.
    const all = new Set(dirtyFiles);
    let complete = cp !== null; // without a comparison point, committed work can't be told from pushed work
    if (cp && head && cp.sha !== head) {
      try {
        const committed = await g(['diff', '--name-only', '-z', '--no-renames', '--no-ext-diff', '--end-of-options', `${cp.sha}...HEAD`, '--']);
        for (const p of nulList(committed)) all.add(p);
      } catch (e) {
        if (isHard(e)) throw e;
        complete = false; // e.g. a shallow clone: no merge base to compare against
      }
    }
    const sorted = [...all].sort();
    const capped = sorted.length > HOOK_LIMITS.maxDivergentPaths;
    const divergent = capped ? sorted.slice(0, HOOK_LIMITS.maxDivergentPaths) : sorted;

    /** @type {GitStateReport['pushed']} */
    let pushed = null;
    if (prev && cp && head) pushed = await detectPush(g, prev, cp, head, branch, remotes, new Set(dirtyFiles));

    /** @type {GitStateReport} */
    const report = { divergent, upstream: cp ? cp.name : null, truncated: capped || !complete, pushed };
    if (previous === null) report.baseline = divergent;
    // Branch, HEAD and the merge-base cache ride along in the session state.
    /** @type {Memory} */
    const memory = { comparison: cp ? { name: cp.name, sha: cp.sha } : null, divergent, branch, head, mergeBase: cp?.mergeBase ?? null };
    return { report, memory };
  } catch {
    // Out of time, or Git failed in a way that makes the answer unreliable: what the working tree shows, flagged.
    const sorted = [...new Set(dirtyFiles)].sort();
    const divergent = sorted.slice(0, HOOK_LIMITS.maxDivergentPaths);
    /** @type {GitStateReport} */
    const report = { divergent, upstream: prev?.comparison?.name ?? null, truncated: true, pushed: null };
    if (previous === null) report.baseline = divergent;
    /** @type {Memory} */
    const memory = prev ? { ...prev } : { comparison: null, divergent };
    return { report, memory };
  }
}

// ---------------------------------------------------------------------------
// Stale-copy check (§12)
// ---------------------------------------------------------------------------

const STALE_TOTAL_MS = 900;
const STALE_CALL_MS = 600;
const STALE_MAX_FILES = 5;
const STALE_MAX_BYTES = 2 * 1024 * 1024;
const PUSH_TTL_MS = 24 * 60 * 60_000;

/**
 * Teammate-written identifiers (callsigns, branch names) made safe for one line of context.
 * @param {unknown} s
 * @param {number} max
 * @returns {string}
 */
function safeText(s, max) {
  return String(s).replace(/[^\w./@+\-]/g, '_').slice(0, max);
}

/**
 * A teammate-written path as quoted data on one line: bare when it is plain, otherwise in double quotes with controls
 * and quotes neutralised. Spaces stay spaces.
 * @param {unknown} s
 * @param {number} max
 * @returns {string}
 */
export function quotePath(s, max = 200) {
  const text = String(s).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').replace(/"/g, "'").slice(0, max);
  return /^[\w./@+\-]+$/.test(text) ? text : `"${text}"`;
}

/**
 * A repo-relative POSIX path from the server: not absolute, no drive or UNC form, no backslashes, no `..`.
 * @param {string} p
 * @returns {boolean}
 */
function isSafeRelPath(p) {
  if (p === '' || p.length > 1024) return false;
  if (/[\u0000-\u001f\u007f\\]/.test(p)) return false;
  if (p.startsWith('/') || /^[A-Za-z]:/.test(p)) return false;
  return !p.split('/').some((seg) => seg === '' || seg === '..');
}

/**
 * @param {number} ms
 * @returns {string}
 */
function ago(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
}

/**
 * The blob SHA Git would store for a working-tree file, NULL_SHA when the file doesn't exist, null when unknown or
 * too large to be worth hashing.
 * @param {string} root
 * @param {string} path
 * @param {GitExec} run
 * @returns {Promise<string | null>}
 */
async function workingBlob(root, path, run) {
  const abs = resolve(root, path);
  try {
    const st = await stat(abs);
    if (!st.isFile() || st.size > STALE_MAX_BYTES) return null;
  } catch (e) {
    return /** @type {NodeJS.ErrnoException} */ (e).code === 'ENOENT' ? NULL_SHA : null;
  }
  return run(['hash-object', `--path=${path}`, '--', abs], root, STALE_CALL_MS).then((o) => o.trim() || null, () => null);
}

/**
 * One file's warning, or null.
 * @param {string} root
 * @param {string | null} branch
 * @param {LastPush} p
 * @param {number} now
 * @param {GitExec} run
 * @returns {Promise<string | null>}
 */
async function staleWarning(root, branch, p, now, run) {
  /** @type {(args: string[]) => Promise<boolean>} */
  const yes = (args) => run(args, root, STALE_CALL_MS).then(() => true, () => false);
  /** @type {(args: string[]) => Promise<string | null>} */
  const out = (args) => run(args, root, STALE_CALL_MS).then((o) => o.trim() || null, () => null);
  if (!p || typeof p.path !== 'string' || typeof p.sha !== 'string' || typeof p.blob !== 'string') return null;
  if (!isSafeRelPath(p.path)) return null;
  if (!/^[0-9a-f]{4,64}$/i.test(p.sha)) return null;
  const age = Number.isFinite(p.at) ? now - p.at : 0;
  if (age > PUSH_TTL_MS) return null;
  const [inHead, headBlob] = await Promise.all([
    yes(['merge-base', '--is-ancestor', '--end-of-options', p.sha, 'HEAD']),
    out(['rev-parse', '--verify', '-q', '--end-of-options', `HEAD:${p.path}`]),
  ]);
  // Already have it: the pushed commit is in HEAD, or HEAD holds the same content (covers squash and rebase merges).
  if (inHead) return null;
  if ((headBlob ?? NULL_SHA) === p.blob) return null;
  // The working copy only matters when it differs from HEAD, and only then is it worth hashing.
  const dirty = await out(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', `:(literal)${p.path}`]);
  if (dirty && (await workingBlob(root, p.path, run)) === p.blob) return null;
  const who = safeText(p.by, 64);
  const file = quotePath(p.path);
  const when = ago(age);
  const known = await yes(['cat-file', '-e', '--end-of-options', `${p.sha}^{commit}`]);
  if (!known) return `${who} pushed changes to ${file} ${when}. Fetch and pull first.`;
  if (branch !== null && p.branch === branch) return `${who} pushed changes to ${file} ${when}. Pull first.`;
  return `${file} was changed on \`${safeText(p.branch, 100)}\` by ${who} ${when}. Expect a conflict when these branches meet. Coordinate before editing.`;
}

/**
 * Stale-copy warnings for a file about to be edited: bare sentences, no header. Never throws, and gives up after
 * about 0.9 s in total, so the hook stays inside its time budget.
 * @param {string} root
 * @param {string | null} branch
 * @param {LastPush[]} lastPush
 * @param {{ exec?: GitExec }} [options]  `exec` replaces the Git runner (tests watch which commands run).
 * @returns {Promise<string[]>}
 */
export async function staleWarnings(root, branch, lastPush, options = {}) {
  const run = options.exec ?? git;
  try {
    if (!Array.isArray(lastPush) || lastPush.length === 0) return [];
    const now = Date.now();
    /** @type {string[]} */
    const lines = [];
    const work = Promise.all(lastPush.slice(0, STALE_MAX_FILES).map((p) => staleWarning(root, branch, p, now, run).catch(() => null)))
      .then((found) => { for (const l of found) if (l) lines.push(l); });
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let timer;
    await Promise.race([work, new Promise((r) => { timer = setTimeout(r, STALE_TOTAL_MS); })]);
    clearTimeout(timer);
    const out = [...lines];
    if (lastPush.length > STALE_MAX_FILES && out.length > 0) out.push(`${lastPush.length - STALE_MAX_FILES} more files were pushed by teammates.`);
    return out;
  } catch {
    return [];
  }
}

export default { identity, refs, normalize, state, staleWarnings };
