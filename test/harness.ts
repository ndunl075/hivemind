/**
 * Shared helpers for test/e2e and test/smoke (not a test file).
 *  - startServer: `wrangler dev` on a fixed port with throwaway secrets and a throwaway persistence folder.
 *  - Team: creates a room and bare "origin" repo, and hands out Agents (a person with a clone and a Hivemind home).
 *  - Agent: runs the real hook (`node cli/hook/hook.mjs claude|codex`) with payloads built from the recorded fixtures
 *    in shared/fixtures/hooks, and talks to /mcp like the agent's MCP client would.
 * Everything lives in temporary folders and uses HIVEMIND_HOME; nothing touches the real user config.
 */
import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const HOOK = join(REPO_ROOT, 'cli', 'hook', 'hook.mjs');
export const PORT = 8788;
export const SERVER = `http://127.0.0.1:${PORT}`;
/** Throwaway secrets for the local dev server only. They are not real credentials. */
export const ADMIN_TOKEN = 'e2e-admin-secret-not-real';
export const TOKEN_SECRET = 'e2e-signing-secret-not-real';

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ------------------------------------------------------------------------------------------------ the server

export interface RunningServer {
  url: string;
  persistDir: string;
  stop(): Promise<void>;
  log(): string;
}

async function healthy(url: string): Promise<boolean> {
  try {
    const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(1000) });
    return res.ok;
  } catch {
    return false;
  }
}

/** Kills a process and its children (workerd is a child of wrangler). */
function killTree(child: ChildProcess): Promise<void> {
  return new Promise((done) => {
    if (child.exitCode !== null || child.pid === undefined) return done();
    child.once('exit', () => done());
    try {
      if (process.platform === 'win32') execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      else process.kill(-child.pid, 'SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
    setTimeout(done, 5000).unref();
  });
}

/** Starts wrangler dev for server/wrangler.toml. Builds the dashboard first if it has not been built. */
export async function startServer(persistDir: string, port = PORT): Promise<RunningServer> {
  const url = `http://127.0.0.1:${port}`;
  if (await healthy(url)) throw new Error(`port ${port} is already serving something; stop it first`);
  if (!existsSync(join(REPO_ROOT, 'dashboard', 'dist', 'index.html'))) {
    execFileSync(process.execPath, [join(REPO_ROOT, 'dashboard', 'build.mjs')], { cwd: REPO_ROOT, stdio: 'ignore' });
  }
  mkdirSync(persistDir, { recursive: true });
  let output = '';
  const child = spawn(
    process.execPath,
    [
      join(REPO_ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js'), 'dev', '-c', 'server/wrangler.toml',
      '--port', String(port), '--ip', '127.0.0.1', '--persist-to', persistDir,
      '--var', `ADMIN_TOKEN:${ADMIN_TOKEN}`, '--var', `TOKEN_SECRET:${TOKEN_SECRET}`,
    ],
    { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32', env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1' } },
  );
  child.stdout?.on('data', (d) => { output += String(d); });
  child.stderr?.on('data', (d) => { output += String(d); });
  const started = Date.now();
  for (;;) {
    if (child.exitCode !== null) throw new Error(`wrangler exited early (${child.exitCode}):\n${output.slice(-2000)}`);
    if (await healthy(url)) break;
    if (Date.now() - started > 90_000) {
      await killTree(child);
      throw new Error(`wrangler did not become healthy in 90 s:\n${output.slice(-2000)}`);
    }
    await sleep(300);
  }
  return { url, persistDir, stop: () => killTree(child), log: () => output };
}

export async function admin(path: string, body?: unknown, method = 'POST', server = SERVER): Promise<Record<string, any>> {
  const res = await fetch(`${server}${path}`, {
    method,
    headers: { authorization: `Bearer ${ADMIN_TOKEN}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${text}`);
  return JSON.parse(text) as Record<string, any>;
}

// ------------------------------------------------------------------------------------------------ git

export function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    'git', ['-c', 'user.name=E2E', '-c', 'user.email=e2e@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false', ...args],
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } },
  ).trim();
}

export function makeTemp(prefix: string): string {
  // realpath: the temp folder may be a short (8.3) or linked path.
  return realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
}

export function removeTemp(dir: string): void {
  try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* best effort */ }
}

/** A bare "origin" with `main` holding the given files, and the root commit's SHA (the repo id). */
export function makeOrigin(root: string, files: Record<string, string>): { origin: string; repoId: string } {
  const origin = join(root, 'origin.git');
  const seed = join(root, 'seed');
  mkdirSync(seed, { recursive: true });
  git(seed, 'init', '-q', '-b', 'main');
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(dirname(join(seed, p)), { recursive: true });
    writeFileSync(join(seed, p), text);
  }
  git(seed, 'add', '-A');
  git(seed, 'commit', '-q', '-m', 'initial');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  git(seed, 'remote', 'add', 'origin', origin);
  git(seed, 'push', '-q', 'origin', 'main');
  const repoId = git(seed, 'rev-list', '--max-parents=0', 'HEAD').split('\n').sort()[0] as string;
  return { origin, repoId };
}

// ------------------------------------------------------------------------------------------------ the hook

export type Tool = 'claude' | 'codex';

export interface HookResult {
  code: number | null;
  stdout: string;
  stderr: string;
  ms: number;
  /** Parsed stdout, or null when the hook printed nothing. */
  json: any;
  denied: boolean;
  blocked: boolean;
  /** permissionDecisionReason (deny) or block reason. */
  reason: string;
  /** additionalContext, '' when none. */
  context: string;
}

export function runHook(tool: Tool, home: string, payload: unknown, extraEnv: Record<string, string> = {}): Promise<HookResult> {
  return new Promise((done, fail) => {
    const t0 = Date.now();
    const child = spawn(process.execPath, [HOOK, tool], {
      env: { ...process.env, HIVEMIND_HOME: home, ...extraEnv }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += String(d); });
    child.stderr.on('data', (d) => { stderr += String(d); });
    const timer = setTimeout(() => { child.kill('SIGKILL'); fail(new Error('hook did not finish in 15 s')); }, 15_000);
    child.on('error', fail);
    child.on('close', (code) => {
      clearTimeout(timer);
      let json: any = null;
      try { json = stdout.trim() ? JSON.parse(stdout) : null; } catch { json = null; }
      const inner = json?.hookSpecificOutput;
      done({
        code, stdout, stderr, ms: Date.now() - t0, json,
        denied: inner?.permissionDecision === 'deny',
        blocked: json?.decision === 'block',
        reason: String(inner?.permissionDecisionReason ?? json?.reason ?? ''),
        context: String(inner?.additionalContext ?? ''),
      });
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

const fixtureCache = new Map<string, any>();
export function fixture(tool: Tool, name: string): any {
  const key = `${tool}/${name}`;
  if (!fixtureCache.has(key)) {
    fixtureCache.set(key, JSON.parse(readFileSync(join(REPO_ROOT, 'shared', 'fixtures', 'hooks', tool, `${name}.json`), 'utf8')));
  }
  return structuredClone(fixtureCache.get(key));
}

export const sha = (s: string) => createHash('sha256').update(s).digest('hex');

export function sessionStatePath(home: string, session: string): string {
  return join(home, 'state', `${sha(session).slice(0, 32)}.json`);
}

export function writeHookConfig(home: string, cfg: { server: string; room: string; person: string; token: string; repos: string[] }): void {
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, 'config.json'), JSON.stringify(cfg));
}

// ------------------------------------------------------------------------------------------------ MCP

let rpcId = 1;

export async function mcpCall(server: string, token: string, name: string, args: Record<string, unknown>): Promise<{ value: any; isError: boolean }> {
  const res = await fetch(`${server}/mcp`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method: 'tools/call', params: { name, arguments: args } }),
  });
  const body = (await res.json()) as any;
  if (body.error) return { value: body.error.message, isError: true };
  const text = body.result.content[0].text as string;
  if (body.result.isError) return { value: text, isError: true };
  try { return { value: JSON.parse(text), isError: false }; } catch { return { value: text, isError: false }; }
}

// ------------------------------------------------------------------------------------------------ agents

export interface AgentOptions {
  room: string;
  person: string;
  tool: Tool;
  server?: string;
  origin: string;
  repoId: string;
  base: string;
  /** Skip the real token and use this server URL in the hook config (for outage tests). */
  hookServer?: string;
}

/** One person with one agent in its own clone, its own Hivemind home and session. */
export class Agent {
  readonly person: string;
  readonly tool: Tool;
  readonly dir: string;
  readonly home: string;
  readonly session: string;
  readonly server: string;
  token = '';
  callsign = '';

  private constructor(private readonly o: AgentOptions) {
    this.person = o.person;
    this.tool = o.tool;
    this.server = o.server ?? SERVER;
    this.dir = join(o.base, `${o.person}-${o.tool}`);
    this.home = join(o.base, `home-${o.person}-${o.tool}`);
    this.session = `e2e-${o.room}-${o.person}-${o.tool}`;
  }

  static async create(o: AgentOptions): Promise<Agent> {
    const a = new Agent(o);
    git(o.base, 'clone', '-q', o.origin, a.dir);
    const invite = await admin(`/admin/rooms/${o.room}/invite`, { person: o.person }, 'POST', a.server);
    a.token = invite.agentToken as string;
    writeHookConfig(a.home, { server: o.hookServer ?? a.server, room: o.room, person: o.person, token: a.token, repos: [o.repoId] });
    return a;
  }

  abs(rel: string): string {
    return join(this.dir, ...rel.split('/'));
  }

  /** A payload built from a recorded fixture, pointed at this agent's checkout and session. */
  payload(name: string, patch?: (p: any) => void): any {
    const p = fixture(this.tool, name);
    p.session_id = this.session;
    p.cwd = this.dir;
    patch?.(p);
    return p;
  }

  fire(name: string, patch?: (p: any) => void): Promise<HookResult> {
    return runHook(this.tool, this.home, this.payload(name, patch));
  }

  async start(): Promise<HookResult> {
    const r = await this.fire('SessionStart');
    const m = /\b((?:claude|codex)-[a-z0-9-]+)\b/.exec(r.context);
    const st = this.state();
    this.callsign = (st?.callsign as string | undefined) ?? m?.[1] ?? '';
    if (!this.callsign) throw new Error(`no callsign after SessionStart: ${JSON.stringify(r)}`);
    return r;
  }

  state(): any {
    try { return JSON.parse(readFileSync(sessionStatePath(this.home, this.session), 'utf8')); } catch { return null; }
  }

  /** PreToolUse for an edit of one file (Edit/Write for Claude, apply_patch for Codex). Does not touch the disk. */
  preEdit(rel: string): Promise<HookResult> {
    if (this.tool === 'claude') {
      return this.fire('PreToolUse.Edit', (p) => { p.tool_input.file_path = this.abs(rel); });
    }
    return this.fire('PreToolUse.apply_patch', (p) => {
      p.tool_input.command = `*** Begin Patch\n*** Update File: ${this.abs(rel)}\n@@\n-x\n+y\n*** End Patch`;
    });
  }

  postEdit(rel: string): Promise<HookResult> {
    if (this.tool === 'claude') {
      return this.fire('PostToolUse.Edit', (p) => { p.tool_input.file_path = this.abs(rel); });
    }
    return this.fire('PostToolUse.apply_patch', (p) => {
      p.tool_input.command = `*** Begin Patch\n*** Update File: ${this.abs(rel)}\n@@\n-x\n+y\n*** End Patch`;
    });
  }

  /**
   * What the agent does to edit a file: ask the hook first; when allowed, change the file and tell the hook afterwards.
   * Returns the PreToolUse result (denied: the file is left alone).
   */
  async edit(rel: string, text = `edited by ${this.person}\n`): Promise<HookResult> {
    const pre = await this.preEdit(rel);
    if (pre.denied) return pre;
    mkdirSync(dirname(this.abs(rel)), { recursive: true });
    writeFileSync(this.abs(rel), text);
    await this.postEdit(rel);
    return pre;
  }

  /** Runs a real shell command in the checkout, then reports PostToolUse for Bash. */
  async shell(command: string, run: () => void): Promise<HookResult> {
    run();
    return this.fire(this.tool === 'claude' ? 'PostToolUse.Bash' : 'PostToolUse.Bash', (p) => { p.tool_input.command = command; });
  }

  /** The commands an agent would run to publish its work. */
  commitAndPush(message = 'work'): void {
    git(this.dir, 'add', '-A');
    git(this.dir, 'commit', '-q', '-m', message);
    git(this.dir, 'push', '-q', 'origin', 'main');
  }

  mcp(name: string, args: Record<string, unknown> = {}): Promise<{ value: any; isError: boolean }> {
    return mcpCall(this.server, this.token, name, name === 'register' ? args : { me: this.callsign, ...args });
  }

  /** An event that always carries Git state and can carry context back: a heartbeat on demand. */
  heartbeat(): Promise<HookResult> {
    return this.fire('UserPromptSubmit');
  }

  async end(reason = 'other'): Promise<HookResult> {
    return this.fire('SessionEnd.other', (p) => { p.reason = reason; });
  }
}

/** A room, a bare origin with some files, and the agents of the people in it. */
export class Team {
  readonly base: string;
  readonly room: string;
  origin = '';
  repoId = '';
  viewerToken = '';
  private agents: Agent[] = [];

  constructor(room: string, readonly server = SERVER) {
    this.room = room;
    this.base = makeTemp(`hm-e2e-${room}-`);
  }

  async open(files: Record<string, string> = { 'a.txt': 'x\n', 'b.txt': 'x\n', 'src/app.ts': 'x\n', 'README.md': '# test\n' }, settings: object | null = { requireTask: false }): Promise<this> {
    const created = await admin('/admin/rooms', { room: this.room }, 'POST', this.server);
    this.viewerToken = created.viewerToken as string;
    const seeded = { ...files };
    if (settings) seeded['.hivemind/project.json'] = `${JSON.stringify(settings, null, 2)}\n`;
    const o = makeOrigin(this.base, seeded);
    this.origin = o.origin;
    this.repoId = o.repoId;
    return this;
  }

  async agent(person: string, tool: Tool = 'claude', start = true, hookServer?: string): Promise<Agent> {
    const a = await Agent.create({
      room: this.room, person, tool, server: this.server, origin: this.origin, repoId: this.repoId, base: this.base, ...(hookServer ? { hookServer } : {}),
    });
    this.agents.push(a);
    if (start) await a.start();
    return a;
  }

  async mode(agent: Agent, mode: 'enforce' | 'warn' | 'off'): Promise<void> {
    const res = await fetch(`${this.server}/mode`, {
      method: 'POST', headers: { authorization: `Bearer ${agent.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ mode }),
    });
    if (!res.ok) throw new Error(`mode: ${res.status} ${await res.text()}`);
  }

  async unlock(agent: Agent, body: unknown): Promise<any> {
    const res = await fetch(`${this.server}/unlock`, {
      method: 'POST', headers: { authorization: `Bearer ${agent.token}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`unlock: ${res.status} ${await res.text()}`);
    return res.json();
  }

  dispose(): void {
    removeTemp(this.base);
  }
}

/** The Room's SQLite file for one room under a wrangler persistence folder. Only read it while the server is stopped. */
async function sqlite(): Promise<typeof import('node:sqlite')> {
  try {
    return await import('node:sqlite');
  } catch {
    throw new Error('seeding a stopped server needs node:sqlite, which needs Node 22.13 or newer');
  }
}

export async function roomDatabase(persistDir: string, room: string): Promise<string> {
  const dir = join(persistDir, 'v3', 'do', 'hivemind-Room');
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.sqlite') || f === 'metadata.sqlite') continue;
    const path = join(dir, f);
    const db = new (await sqlite()).DatabaseSync(path, { readOnly: true });
    try {
      const row = db.prepare("SELECT value FROM meta WHERE key = 'room'").get() as { value?: string } | undefined;
      if (row?.value === room) return path;
    } catch { /* not a Room database */ } finally {
      db.close();
    }
  }
  throw new Error(`no Room database for "${room}" in ${dir}`);
}

/** Runs SQL against a stopped server's Room database (used to put a room into a state that would take hours or 95k requests). */
export async function seedRoom(persistDir: string, room: string, run: (db: DatabaseSync) => void): Promise<void> {
  const { DatabaseSync } = await sqlite();
  const db = new DatabaseSync(await roomDatabase(persistDir, room));
  try { run(db); } finally { db.close(); }
}
