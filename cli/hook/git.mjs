/**
 * Basic Git module (ARCHITECTURE.md §6.3, §12). Implements GitModule from shared/hook-modules.ts.
 * Covers repo identity and divergent files from `git status` only. The comparison point, push detection and
 * the stale-copy check are added later behind the same interface (the stale check is a no-op here).
 * Every Git call is read-only and runs with GIT_OPTIONAL_LOCKS=0, so the hook never takes the index lock.
 * @typedef {import('../../shared/hook-modules').Identity} Identity
 * @typedef {import('../../shared/hook-modules').GitMemory} GitMemory
 * @typedef {import('../../shared/contracts').GitStateReport} GitStateReport
 * @typedef {import('../../shared/contracts').LastPush} LastPush
 */
import { execFile } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { HOOK_LIMITS } from './limits.mjs';

export const GIT_ENV_OVERRIDES = Object.freeze({ GIT_OPTIONAL_LOCKS: '0' });
const GIT_TIMEOUT_MS = 2_000;

/**
 * The only place Git is run.
 * @param {string[]} args
 * @param {string} cwd
 * @returns {Promise<string>}
 */
function git(args, cwd) {
  return new Promise((resolveRun, reject) => {
    execFile(
      'git', args,
      { cwd, env: { ...process.env, ...GIT_ENV_OVERRIDES }, timeout: GIT_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024, windowsHide: true, encoding: 'utf8' },
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
 * Resolve symlinks of the nearest existing ancestor (the file itself may not exist yet).
 * @param {string} p
 * @returns {string}
 */
function real(p) {
  let cur = p;
  /** @type {string[]} */
  const tail = [];
  for (;;) {
    try {
      return resolve(realpathSync.native(cur), ...tail);
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
 * @returns {string | null} repo-relative POSIX path, or null when outside the checkout, at the root, or under .git/
 */
function relInside(root, abs) {
  const rel = relative(root, abs);
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  const posix = rel.split(sep).join('/');
  if (posix === '.git' || posix.startsWith('.git/')) return null;
  return posix;
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
  for (const p of paths) {
    if (typeof p !== 'string' || p === '') continue;
    const abs = resolve(cwd, p);
    const rel = relInside(root, abs) ?? relInside(real(root), real(abs));
    if (rel && !out.includes(rel)) out.push(rel);
  }
  return out;
}

/**
 * @param {string} root
 * @param {GitMemory | null} previous
 * @returns {Promise<{ report: GitStateReport; memory: GitMemory }>}
 */
export async function state(root, previous) {
  const out = await git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], root);
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
  const all = [...files];
  const truncated = all.length > HOOK_LIMITS.maxDivergentPaths;
  const divergent = truncated ? all.slice(0, HOOK_LIMITS.maxDivergentPaths) : all;
  /** @type {GitStateReport} */
  const report = { divergent, upstream: null, truncated, pushed: null };
  if (previous === null) report.baseline = divergent;
  return { report, memory: { comparison: previous?.comparison ?? null, divergent } };
}

/**
 * Stub: the stale-copy check arrives with the full Git module.
 * @param {string} _root
 * @param {string | null} _branch
 * @param {LastPush[]} _lastPush
 * @returns {Promise<string[]>}
 */
export async function staleWarnings(_root, _branch, _lastPush) {
  return [];
}

export default { identity, normalize, state, staleWarnings };
