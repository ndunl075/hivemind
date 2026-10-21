/** Request validation. Returns a clean value or an error string; never throws. */
import { canonicalPath } from './util';
import { LIMITS, type GitStateReport, type HookEvent, type HookRequest, type ProjectSettings, type RoomMode } from '../../shared/contracts';

type Obj = Record<string, unknown>;

const EVENTS: readonly HookEvent[] = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'SessionEnd'];
const MAX_STR = 1024;
const MAX_PATHS = 500;

export function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown, max = MAX_STR): string | null {
  return typeof v === 'string' && v.length > 0 && v.length <= max ? v : null;
}

function strOrNull(v: unknown, max = MAX_STR): string | null | undefined {
  if (v === null || v === undefined) return null;
  return typeof v === 'string' && v.length <= max ? v : undefined;
}

function pathList(v: unknown, cap: number): { list: string[]; truncated: boolean } | null {
  if (!Array.isArray(v)) return null;
  const list: string[] = [];
  for (const p of v) {
    if (typeof p !== 'string' || p.length > MAX_STR) return null;
    const c = canonicalPath(p);
    if (c === null) return null; // absolute, or escaping the repo
    if (c.length > 0) list.push(c);
  }
  return list.length > cap ? { list: list.slice(0, cap), truncated: true } : { list, truncated: false };
}

export function sanitizeSettings(raw: unknown): ProjectSettings | null {
  if (!isObj(raw)) return null;
  const out: ProjectSettings = {};
  if (typeof raw.requireTask === 'boolean') out.requireTask = raw.requireTask;
  for (const key of ['advisory', 'ignore'] as const) {
    const v = raw[key];
    if (Array.isArray(v)) {
      out[key] = v.filter((p): p is string => typeof p === 'string' && p.length > 0 && p.length <= 200).slice(0, 100);
    }
  }
  return out;
}

function parseGit(v: unknown): GitStateReport | null | string {
  if (v === null || v === undefined) return null;
  if (!isObj(v)) return 'git must be an object';
  const div = pathList(v.divergent, LIMITS.maxDivergentPaths);
  if (!div) return 'git.divergent must be a list of paths';
  let baseline: string[] | undefined;
  if (v.baseline !== undefined) {
    const b = pathList(v.baseline, LIMITS.maxDivergentPaths);
    if (!b) return 'git.baseline must be a list of paths';
    baseline = b.list;
  }
  const upstream = strOrNull(v.upstream, 200);
  if (upstream === undefined) return 'git.upstream must be a string or null';
  let pushed: GitStateReport['pushed'] = null;
  if (v.pushed !== null && v.pushed !== undefined) {
    const p = v.pushed;
    if (!isObj(p) || !str(p.branch, 300) || !str(p.sha, 80) || !Array.isArray(p.files)) return 'git.pushed is malformed';
    const files: { path: string; blob: string }[] = [];
    for (const f of p.files.slice(0, MAX_PATHS)) {
      if (!isObj(f) || !str(f.path) || !str(f.blob, 80)) return 'git.pushed.files is malformed';
      const fp = canonicalPath(f.path as string);
      if (!fp) return 'git.pushed.files has an invalid path';
      files.push({ path: fp, blob: f.blob as string });
    }
    pushed = { branch: p.branch as string, sha: p.sha as string, files };
  }
  return {
    divergent: div.list,
    ...(baseline ? { baseline } : {}),
    upstream,
    truncated: v.truncated === true || div.truncated,
    pushed,
  };
}

export function parseHookRequest(raw: unknown): HookRequest | string {
  if (!isObj(raw)) return 'body must be a JSON object';
  if (raw.v !== 1) return 'unsupported version';
  if (!EVENTS.includes(raw.event as HookEvent)) return 'unknown event';
  if (raw.agent !== 'claude' && raw.agent !== 'codex') return 'agent must be claude or codex';
  const session = str(raw.session, 200);
  const repo = str(raw.repo, 200);
  const checkout = str(raw.checkout, 200);
  if (!session || !repo || !checkout) return 'session, repo and checkout are required';
  const branch = strOrNull(raw.branch, 300);
  const head = strOrNull(raw.head, 100);
  if (branch === undefined || head === undefined) return 'branch and head must be strings or null';
  const req: HookRequest = {
    v: 1, event: raw.event as HookEvent, agent: raw.agent, session, repo, checkout, branch, head,
  };
  if (raw.tool !== undefined) {
    const tool = str(raw.tool, 200);
    if (!tool) return 'tool must be a string';
    req.tool = tool;
  }
  if (raw.paths !== undefined) {
    const paths = pathList(raw.paths, MAX_PATHS);
    if (!paths) return 'paths must be a list of strings';
    req.paths = paths.list;
  }
  const git = parseGit(raw.git);
  if (typeof git === 'string') return git;
  req.git = git;
  if (raw.shellSinceHeartbeat !== undefined) req.shellSinceHeartbeat = raw.shellSinceHeartbeat === true;
  if (raw.settings !== undefined && raw.settings !== null) {
    const s = sanitizeSettings(raw.settings);
    if (!s) return 'settings must be an object';
    req.settings = s;
  }
  if (raw.stopActive !== undefined) req.stopActive = raw.stopActive === true;
  const endReason = strOrNull(raw.endReason, 200);
  if (endReason === undefined) return 'endReason must be a string or null';
  req.endReason = endReason;
  if (typeof raw.outageMs === 'number' && Number.isFinite(raw.outageMs) && raw.outageMs > 0) req.outageMs = Math.floor(raw.outageMs);
  const repoName = strOrNull(raw.repoName, 200);
  if (repoName) req.repoName = repoName;
  return req;
}

export function isRoomMode(v: unknown): v is RoomMode {
  return v === 'enforce' || v === 'warn' || v === 'off';
}
