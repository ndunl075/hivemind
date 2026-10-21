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

export const GIT_ENV_OVERRIDES = Object.freeze({ GIT_OPTIONAL_LOCKS: '0' });
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
      { cwd, env: { ...process.env, ...GIT_ENV_OVERRIDES }, timeout, maxBuffer: 32 * 1024 * 1024, windowsHide: true, encoding: 'utf8' },
      (err, stdout) => (err ? reject(err) : resolveRun(stdout)),
    );
  });
}

/**
 * True when the command exits 0 (for questions such as `merge-base --is-ancestor` and `cat-file -e`).
 * @param {string[]} args
 * @param {string} cwd
 * @param {number} [timeout]
 * @returns {Promise<boolean>}
 */
function succeeds(args, cwd, timeout) {
  return git(args, cwd, timeout).then(() => true, () => false);
}

/**
 * @param {Promise<string>} p
 * @returns {Promise<string | null>}
 */
function orNull(p) {
  return p.then((s) => s.trim() || null, () => null);
}

/**
 * Display name from an origin URL (https or scp-like), or null.
 * @param {string | null} url
 * @returns {string | null}
 */
function repoNameOf(url) {
  if (!url) return null;
  const last = url.replace(/\/+$/, '').replace(/\.git$/, '').split(/[/:]/).pop();
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
 * The comparison point of the current branch (§12), in order: its configured upstream; a remote-tracking branch
 * with the same name on any remote (`origin` first); the merge base with the remote's default branch.
 * @param {string} root
 * @param {{ branch: string | null; head: string | null; upstream: string | null; refs: Map<string, { sha: string; symref: string }>; remotes: string[] }} i
 * @returns {Promise<{ name: string; sha: string } | null>}
 */
async function comparisonPoint(root, i) {
  if (!i.head) return null;
  if (i.upstream) {
    const tracked = i.refs.get(i.upstream);
    const sha = tracked?.sha || await orNull(git(['rev-parse', '--verify', '-q', `${i.upstream}^{commit}`], root));
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
      const base = await orNull(git(['merge-base', 'HEAD', name], root));
      if (base) return { name, sha: base };
    }
  }
  return null;
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
 * Files that went out in a push (§12): in the previous divergent set, and changed between the old comparison point
 * and HEAD, with their blob SHAs in HEAD. Null when nothing was pushed.
 * @param {string} root
 * @param {GitMemory & { branch?: string | null }} previous
 * @param {{ name: string; sha: string }} now
 * @param {string} head
 * @param {string | null} branch
 * @param {string[]} remotes
 * @returns {Promise<GitStateReport['pushed']>}
 */
async function detectPush(root, previous, now, head, branch, remotes) {
  const before = previous.comparison;
  if (!before || before.sha === now.sha || previous.divergent.length === 0) return null;
  // A branch switch moves the comparison point without anything being pushed.
  if (previous.branch !== undefined && previous.branch !== branch) return null;
  // HEAD must now be contained in the comparison point (a fetch alone leaves local commits outside it).
  if (!(await succeeds(['merge-base', '--is-ancestor', head, now.sha], root))) return null;
  const raw = await orNull(git(['diff', '--raw', '-z', '--no-renames', '--no-ext-diff', '--no-abbrev', before.sha, head], root));
  if (!raw) return null;
  const mine = new Set(previous.divergent);
  /** @type {{ path: string; blob: string }[]} */
  const files = [];
  const parts = raw.split('\0');
  for (let i = 0; i + 1 < parts.length; i += 2) {
    // ':100644 100644 <old blob> <new blob> M', then the path.
    const meta = (parts[i] ?? '').split(' ');
    const path = parts[i + 1] ?? '';
    if (mine.has(path)) files.push({ path, blob: meta[3] ?? NULL_SHA });
  }
  if (files.length === 0) return null;
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { branch: branchOfRef(now.name, remotes) || branch || 'HEAD', sha: head, files: files.slice(0, HOOK_LIMITS.maxDivergentPaths) };
}

/**
 * @param {string} root
 * @param {GitMemory | null} previous
 * @returns {Promise<{ report: GitStateReport; memory: GitMemory }>}
 */
export async function state(root, previous) {
  const [statusOut, branch, head, refsOut, remotesOut, upstream] = await Promise.all([
    git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], root),
    orNull(git(['symbolic-ref', '--short', '-q', 'HEAD'], root)),
    orNull(git(['rev-parse', '--verify', '-q', 'HEAD'], root)),
    orNull(git(['for-each-ref', '--format=%(refname)%00%(objectname)%00%(symref)', 'refs/remotes'], root)),
    orNull(git(['remote'], root)),
    orNull(git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], root)),
  ]);
  const refs = parseRemoteRefs(refsOut);
  const remotes = parseRemotes(remotesOut);
  const cp = await comparisonPoint(root, { branch, head, upstream, refs, remotes });

  // Divergent files: working tree and staged changes, plus commits not yet at the comparison point.
  const all = new Set(parseStatus(statusOut));
  if (cp && head && cp.sha !== head) {
    const committed = await orNull(git(['diff', '--name-only', '-z', '--no-renames', '--no-ext-diff', `${cp.sha}...HEAD`], root));
    for (const p of nulList(committed)) all.add(p);
  }
  const sorted = [...all].sort();
  const truncated = sorted.length > HOOK_LIMITS.maxDivergentPaths;
  const divergent = truncated ? sorted.slice(0, HOOK_LIMITS.maxDivergentPaths) : sorted;

  /** @type {GitStateReport['pushed']} */
  let pushed = null;
  if (previous && cp && head) pushed = await detectPush(root, previous, cp, head, branch, remotes);

  /** @type {GitStateReport} */
  const report = { divergent, upstream: cp ? cp.name : null, truncated, pushed };
  if (previous === null) report.baseline = divergent;
  // `branch` rides along in the session state so a branch switch is never mistaken for a push.
  /** @type {GitMemory & { branch: string | null }} */
  const memory = { comparison: cp, divergent, branch };
  return { report, memory };
}

// ---------------------------------------------------------------------------
// Stale-copy check (§12)
// ---------------------------------------------------------------------------

const STALE_TOTAL_MS = 900;
const STALE_CALL_MS = 600;
const STALE_MAX_FILES = 5;
const STALE_MAX_BYTES = 8 * 1024 * 1024;
const PUSH_TTL_MS = 24 * 60 * 60_000;

/**
 * Teammate-written text (callsigns, branch names, paths) made safe for one line of context.
 * @param {unknown} s
 * @param {number} max
 * @returns {string}
 */
function safeText(s, max) {
  return String(s).replace(/[^\w./@+\-]/g, '_').slice(0, max);
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
 * The blob SHA Git would store for a working-tree file, NULL_SHA when the file doesn't exist, null when unknown.
 * @param {string} root
 * @param {string} path
 * @returns {Promise<string | null>}
 */
async function workingBlob(root, path) {
  const abs = resolve(root, path);
  try {
    const st = await stat(abs);
    if (!st.isFile() || st.size > STALE_MAX_BYTES) return null;
  } catch (e) {
    return /** @type {NodeJS.ErrnoException} */ (e).code === 'ENOENT' ? NULL_SHA : null;
  }
  return orNull(git(['hash-object', `--path=${path}`, '--', abs], root, STALE_CALL_MS));
}

/**
 * One file's warning, or null.
 * @param {string} root
 * @param {string | null} branch
 * @param {LastPush} p
 * @param {number} now
 * @returns {Promise<string | null>}
 */
async function staleWarning(root, branch, p, now) {
  if (!p || typeof p.path !== 'string' || typeof p.sha !== 'string' || typeof p.blob !== 'string') return null;
  if (p.path.startsWith('/') || p.path.split('/').includes('..') || /^[A-Za-z]:/.test(p.path)) return null;
  if (!/^[0-9a-f]{4,64}$/i.test(p.sha)) return null;
  const age = Number.isFinite(p.at) ? now - p.at : 0;
  if (age > PUSH_TTL_MS) return null;
  const [inHead, headBlob, local] = await Promise.all([
    succeeds(['merge-base', '--is-ancestor', p.sha, 'HEAD'], root, STALE_CALL_MS),
    orNull(git(['rev-parse', '--verify', '-q', `HEAD:${p.path}`], root, STALE_CALL_MS)),
    workingBlob(root, p.path),
  ]);
  // Already have it: the pushed commit is in HEAD, or the content is the same (covers squash and rebase merges).
  if (inHead) return null;
  if (local === p.blob || (headBlob ?? NULL_SHA) === p.blob) return null;
  const who = safeText(p.by, 64);
  const file = safeText(p.path, 200);
  const when = ago(age);
  const known = await succeeds(['cat-file', '-e', `${p.sha}^{commit}`], root, STALE_CALL_MS);
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
 * @returns {Promise<string[]>}
 */
export async function staleWarnings(root, branch, lastPush) {
  try {
    if (!Array.isArray(lastPush) || lastPush.length === 0) return [];
    const now = Date.now();
    /** @type {string[]} */
    const lines = [];
    const work = Promise.all(lastPush.slice(0, STALE_MAX_FILES).map((p) => staleWarning(root, branch, p, now).catch(() => null)))
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
