/**
 * Interfaces of the hook's modules (ARCHITECTURE.md §6.3). Architect-owned.
 * cli/hook/hook.mjs loads these with dynamic import() inside its top-level try.
 */
import type {
  GitStateReport, HookEvent, HookResponse, LastPush, RepoId, RepoPath,
} from './contracts';

/** What hook.mjs needs from a raw stdin payload, whichever tool sent it. */
export interface ParsedHookInput {
  event: HookEvent;
  session: string;
  cwd: string;
  tool: string | null;
  /** Absolute or cwd-relative paths an edit tool is about to touch (§6.3 step 7). Empty for non-edits. */
  editPaths: string[];
  /** True for shell tools (Bash, PowerShell). */
  isShell: boolean;
  /** tool_input.me for mcp__hivemind__ calls, else null. */
  me: string | null;
  isHivemindTool: boolean;
  stopActive: boolean;
  endReason: string | null;
}

/** What hook.mjs decided, before tool-specific formatting. */
export interface HookOutcome {
  decision: HookResponse['decision'];
  reason: string | null;
  context: string | null;
}

/** claude.mjs and codex.mjs. */
export interface ToolAdapter {
  parse(raw: unknown): ParsedHookInput;
  /**
   * Exact output for this tool and event, or null for no output.
   * Must match the tool's schema exactly: Codex treats unknown fields as a failed hook (§6.2).
   */
  format(event: HookEvent, outcome: HookOutcome): string | null;
}

export interface Identity {
  /** Absolute path of the checkout root. */
  root: string;
  repo: RepoId;
  repoName: string | null;
  branch: string | null;
  head: string | null;
}

/** Remembered between heartbeats in the session state file. */
export interface GitMemory {
  comparison: { name: string; sha: string } | null;
  divergent: RepoPath[];
}

/** git.mjs. Every Git call runs with GIT_OPTIONAL_LOCKS=0. */
export interface GitModule {
  /** null when cwd isn't inside a Git repo with at least one commit. */
  identity(cwd: string): Promise<Identity | null>;
  /** Convert absolute or cwd-relative paths to repo-relative POSIX paths, dropping anything outside or under .git/. */
  normalize(root: string, cwd: string, paths: string[]): RepoPath[];
  /** §12 Git state, plus the memory to keep for next time. `previous` is null on SessionStart. */
  state(root: string, previous: GitMemory | null): Promise<{ report: GitStateReport; memory: GitMemory }>;
  /** §12 stale-copy check. Returns warning lines; never throws. */
  staleWarnings(root: string, branch: string | null, lastPush: LastPush[]): Promise<string[]>;
}
