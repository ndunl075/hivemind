/**
 * Setup for the smoke test: a throwaway project with project-level hooks and MCP config for both tools, a way to run a
 * real agent with its prompt on stdin, and a dashboard watcher. Everything is written inside the Team's temporary
 * folder; user-level Claude and Codex config is never touched.
 */
import { spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import WebSocket from 'ws';
import { CLAUDE_SPECS, CODEX_SPECS, claudeHandler, codexHandler } from '../../cli/commands/registrations.mjs';
import { REPO_ROOT, SERVER, writeHookConfig, type Team } from '../harness';

export interface Project {
  dir: string;
  home: string;
  token: string;
  person: string;
}

/** A checkout of the throwaway repo with hooks and MCP registered for both tools, project-level only. */
export async function makeProject(team: Team, person: string): Promise<Project> {
  const a = await team.agent(person, 'claude', false); // gives us the clone, the invite and the config; we configure the rest here
  const dir = a.dir;
  const home = a.home;
  writeHookConfig(home, { server: SERVER, room: team.room, person, token: a.token, repos: [team.repoId] });
  // The hook folder, laid out as `hivemind join` lays it out: <home>/hook/hook.mjs, found by the hook itself.
  mkdirSync(join(home, 'hook'), { recursive: true });
  for (const f of ['hook.mjs', 'claude.mjs', 'codex.mjs', 'git.mjs', 'limits.mjs']) copyFileSync(join(REPO_ROOT, 'cli', 'hook', f), join(home, 'hook', f));
  const script = join(home, 'hook', 'hook.mjs');

  const group = (specs: typeof CLAUDE_SPECS, handler: (spec: (typeof CLAUDE_SPECS)[number]) => unknown) => {
    const hooks: Record<string, unknown[]> = {};
    for (const spec of specs) hooks[spec.event] = [{ ...(spec.matcher ? { matcher: spec.matcher } : {}), hooks: [handler(spec)] }];
    return { hooks };
  };
  mkdirSync(join(dir, '.claude'), { recursive: true });
  writeFileSync(join(dir, '.claude', 'settings.json'), JSON.stringify(group(CLAUDE_SPECS, (s) => claudeHandler(process.execPath, script, s)), null, 2));
  mkdirSync(join(dir, '.codex'), { recursive: true });
  writeFileSync(join(dir, '.codex', 'hooks.json'), JSON.stringify(group(CODEX_SPECS, (s) => codexHandler(process.execPath, script, s)), null, 2));
  writeFileSync(
    join(dir, '.codex', 'config.toml'),
    `[mcp_servers.hivemind]\nurl = "${SERVER}/mcp"\nhttp_headers = { Authorization = "Bearer ${a.token}" }\ndefault_tools_approval_mode = "approve"\ntool_timeout_sec = 60\n`,
  );
  writeFileSync(join(dir, 'mcp.json'), JSON.stringify({ mcpServers: { hivemind: { type: 'http', url: `${SERVER}/mcp`, headers: { Authorization: `Bearer ${a.token}` } } } }));
  writeFileSync(join(dir, 'perm.json'), JSON.stringify({ permissions: { allow: ['mcp__hivemind', 'Edit', 'Write'] } }));
  // Keep the config files out of Git's view so they are not "divergent files".
  writeFileSync(join(dir, '.git', 'info', 'exclude'), '.claude/\n.codex/\nmcp.json\nperm.json\n', { flag: 'a' });
  return { dir, home, token: a.token, person };
}

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** Runs a command with the prompt on stdin (no quoting problems with the model's prompt). */
export function run(cmd: string, args: string[], cwd: string, home: string, stdin: string, timeoutMs: number): Promise<RunResult> {
  return new Promise((done) => {
    const child = spawn(cmd, args, {
      cwd, env: { ...process.env, HIVEMIND_HOME: home }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
      // codex is a .cmd shim on Windows; the arguments here are plain words, so the shell does not change them.
      shell: process.platform === 'win32' && cmd === 'codex',
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.on('data', (d) => { stdout += String(d); });
    child.stderr.on('data', (d) => { stderr += String(d); });
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    child.on('close', (code) => { clearTimeout(timer); done({ code, stdout, stderr, timedOut }); });
    child.on('error', () => { clearTimeout(timer); done({ code: null, stdout, stderr: `${stderr}\nspawn error`, timedOut }); });
    child.stdin.end(stdin);
  });
}

/** Collects every dashboard frame (snapshots and pulses) of the room. */
export function watch(team: Team, url: string, viewerToken: string): { frames: any[]; close(): void } {
  const frames: any[] = [];
  const ws = new WebSocket(`${url.replace('http', 'ws')}/r/${team.room}/ws`, ['hivemind', viewerToken]);
  ws.on('message', (d) => { try { frames.push(JSON.parse(String(d))); } catch { /* ignore */ } });
  ws.on('error', () => undefined);
  return { frames, close: () => ws.close() };
}

