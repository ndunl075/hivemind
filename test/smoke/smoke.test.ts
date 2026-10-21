/**
 * Smoke test with REAL agents: one `claude -p` and one `codex exec` session, in two throwaway checkouts of one
 * throwaway repo (outside this repository), with project-level hooks and MCP config pointing at a local
 * `wrangler dev` (port 8788) through HIVEMIND_HOME. Both are asked to edit the same file. Claude goes first and then
 * waits for a message while holding the lock; Codex is blocked by the hook and tells Claude. The test asserts that
 * exactly one of the two was blocked and that the message was delivered.
 *
 * It spends model tokens (Claude: haiku; Codex: the default model at low reasoning effort), so it is run by hand with
 *   npm run test:smoke
 * and never in CI. Take the `real-agents` lock first (docs/parallel-sessions.md section 5).
 *
 * SMOKE_AGENTS=claude runs only the Claude half (no blocking can be checked then); useful to debug the setup without
 * spending Codex tokens. Codex may record the throwaway project as trusted in ~/.codex/config.toml; this test backs that
 * file up first and puts it back afterwards (and says whether the checksum matches).
 *
 * Only project-level hook and MCP config is written, and only inside the temporary folder. User-level Claude and Codex
 * hook or MCP config is never touched. Everything talks to 127.0.0.1 only.
 */
import { appendFileSync, copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SERVER, Team, makeTemp, removeTemp, sleep, startServer, type RunningServer } from '../harness';
import { makeProject, run, watch, type RunResult } from './project';

const AGENTS = (process.env.SMOKE_AGENTS ?? 'claude,codex').split(',').map((s) => s.trim());
const WITH_CODEX = AGENTS.includes('codex');
const SHARED = 'shared.txt';
const CLAUDE_TIMEOUT_MS = 300_000;
const CODEX_TIMEOUT_MS = 300_000;
/** The default model of this machine's Codex config is not available on every plan; this one is the cheap one the spike used. */
const CODEX_MODEL = process.env.SMOKE_CODEX_MODEL ?? 'gpt-5.6-luna';
const LOG = join(tmpdir(), 'hivemind-smoke-last.log');

/** Prints a line and keeps it in a log outside the repository, so a timeout or crash does not lose what happened. */
function report(...parts: unknown[]): void {
  const line = parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ');
  console.log(line);
  try { appendFileSync(LOG, `${line}
`); } catch { /* the console has it */ }
}

let base: string;
let persist: string;
let server: RunningServer;
let team: Team;

const sha = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');

const lastSnapshot = (frames: any[]) => [...frames].reverse().find((f) => f.type === 'snapshot');

const codexHome = () => process.env.CODEX_HOME || join(homedir(), '.codex');

beforeAll(async () => {
  writeFileSync(LOG, '');
  base = makeTemp('hm-smoke-');
  persist = join(base, 'wrangler-state');
  server = await startServer(persist);
  team = new Team('smoke');
  // `base` of the Team is its own temp folder, outside the repository like everything else here.
  await team.open({ [SHARED]: 'old\n', 'README.md': '# throwaway\n' }, { requireTask: false });
});

afterAll(async () => {
  await server?.stop();
  team?.dispose();
  removeTemp(base);
});

describe('real agents', () => {
  it('blocks exactly one of two agents editing the same file, and delivers the message that follows', async () => {
    const claudeP = await makeProject(team, 'ana');
    const codexP = WITH_CODEX ? await makeProject(team, 'bo') : null;
    const watcher = watch(team, SERVER, team.viewerToken);
    await sleep(500);

    // ---- Claude: edit the file, then stay alive (holding the lock) until a message arrives.
    const claudePrompt = [
      `Use the Edit tool to replace the word "old" with "claude" in ${SHARED}.`,
      'Then call the hivemind wait tool with me set to your callsign (it is in your Hivemind briefing), seconds 45 and for "message";',
      'if it times out without a message, call it again, at most five times in all.',
      'Finally reply with the exact text of any message you received, or NO MESSAGE.',
    ].join(' ');
    const claudeRun = run(
      'claude',
      ['-p', '--setting-sources', 'project', '--settings', 'perm.json', '--mcp-config', 'mcp.json', '--strict-mcp-config', '--model', 'haiku', '--output-format', 'json'],
      claudeP.dir, claudeP.home, claudePrompt, CLAUDE_TIMEOUT_MS,
    );

    // ---- Wait until Claude holds the lock, then start Codex.
    const started = Date.now();
    let holding = false;
    while (Date.now() - started < 120_000) {
      const snap = lastSnapshot(watcher.frames);
      if (snap?.locks?.some((l: any) => l.path === SHARED)) { holding = true; break; }
      await sleep(500);
    }
    expect(holding, 'claude never took the lock on the shared file').toBe(true);

    let codexResult: RunResult | null = null;
    let codexBackup: { path: string; copy: string; hash: string } | null = null;
    if (WITH_CODEX && codexP) {
      const cfg = join(codexHome(), 'config.toml');
      if (existsSync(cfg)) {
        const copy = join(base, 'codex-config.toml.bak');
        copyFileSync(cfg, copy);
        codexBackup = { path: cfg, copy, hash: sha(cfg) };
      }
      // Project-level .codex/config.toml (the MCP server) and hooks only load in a trusted project. Codex records that
      // itself in the user config on first use; doing it here makes it certain, and the backup above puts the file back.
      appendFileSync(cfg, `
[projects.'${codexP.dir}']
trust_level = "trusted"
`);
      const codexPrompt = `Use apply_patch to replace the word "old" with "codex" in ${SHARED}, and if Hivemind blocks that edit then call the hivemind post tool with me set to your callsign (from your Hivemind briefing) to tell the agent holding the file, by the callsign in the block message, a short message containing the word SMOKE-PING, and then stop without retrying.`;
      try {
        codexResult = await run(
          'codex', ['exec', '-m', CODEX_MODEL, '-c', 'model_reasoning_effort=low', '-s', 'workspace-write', '--dangerously-bypass-hook-trust', '-'],
          codexP.dir, codexP.home, codexPrompt, CODEX_TIMEOUT_MS,
        );
      } finally {
        if (codexBackup) {
          copyFileSync(codexBackup.copy, codexBackup.path);
          report(`codex config restored, checksum ${sha(codexBackup.path) === codexBackup.hash ? 'matches' : 'DIFFERS from'} the original`);
        }
      }
    }

    const claudeResult = await claudeRun;
    await sleep(1000); // last frames
    watcher.close();

    // ---- What happened (printed so a failure can be read without re-running).
    const snap = lastSnapshot(watcher.frames);
    const agents = (snap?.agents ?? []) as { callsign: string; kind: string }[];
    const claudeCs = agents.find((a) => a.kind === 'claude')?.callsign;
    const codexCs = agents.find((a) => a.kind === 'codex')?.callsign;
    const pulses = watcher.frames.filter((f) => f.type === 'pulse');
    report('agents:', agents.map((a) => `${a.callsign}(${a.kind})`).join(', '));
    report('pulses:', pulses.map((p) => `${p.kind} ${p.from}->${p.to ?? '*'} ${p.path ?? ''}`).join(' | '));
    report('activity:', (snap?.activity ?? []).map((a: any) => a.text).slice(-12).join(' | '));
    report('claude exit', claudeResult.code, claudeResult.timedOut ? '(timed out)' : '', 'result:', safeResult(claudeResult.stdout));
    if (codexResult) {
      report('codex exit', codexResult.code, codexResult.timedOut ? '(timed out)' : '');
      report('codex output tail:', `${codexResult.stdout}
${codexResult.stderr}`.trim().slice(-2500));
      report('codex hook lines:', codexResult.stdout.split(/\r?\n/).concat(codexResult.stderr.split(/\r?\n/)).filter((l) => /^hook:/i.test(l.trim())).join(' | '));
    }
    for (const p of [claudeP, codexP]) {
      if (!p) continue;
      const log = join(p.home, 'hook.log');
      if (existsSync(log)) {
        const lines = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
        report(`${p.person} hook.log: ${lines.length} lines, ${lines.filter((l) => !l.ok).length} failed`);
      }
    }

    // ---- Assertions.
    expect(claudeCs, 'claude registered with the server').toBeTruthy();
    expect(readFileSync(join(claudeP.dir, SHARED), 'utf8'), 'claude changed the file').toContain('claude');
    expect(pulses.filter((p) => p.kind === 'denied' && p.from === claudeCs), 'claude was never blocked').toHaveLength(0);
    if (!WITH_CODEX) return;

    expect(codexCs, 'codex registered with the server').toBeTruthy();
    const blocked = new Set(pulses.filter((p) => p.kind === 'denied').map((p) => p.from));
    expect([...blocked], 'exactly one agent was blocked, and it was codex').toEqual([codexCs]);
    expect(readFileSync(join(codexP!.dir, SHARED), 'utf8'), 'the blocked edit did not happen').toBe('old\n');
    const sent = pulses.filter((p) => p.kind === 'message' && p.from === codexCs && p.to === claudeCs);
    expect(sent.length, 'codex messaged claude').toBeGreaterThan(0);
    expect(claudeResult.stdout, 'claude received the message').toContain('SMOKE-PING');
  }, 900_000);
});

function safeResult(stdout: string): string {
  try {
    const j = JSON.parse(stdout);
    return String(j.result ?? j.error ?? stdout).slice(0, 400);
  } catch {
    return stdout.slice(0, 400);
  }
}

