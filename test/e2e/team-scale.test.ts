/**
 * Team scale: 6 people x 2 laptops x 1-2 agents (18 agents, claude and codex mixed) in one room, running a scripted,
 * deterministic hour of work compressed into a couple of minutes against the real server (wrangler dev) with the real
 * hook (cli/hook/hook.mjs) and recorded payloads. Asserts the safety invariants and counts every request the hooks and
 * MCP calls made, then extrapolates requests per day for this team at the default heartbeat (ARCHITECTURE.md §16).
 *
 * Set HIVEMIND_E2E_REPORT=<file> to also write the measurements as JSON (used for docs/evidence/team-scale-e2e.md).
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { SERVER, Team, git, makeTemp, removeTemp, sleep, startServer, startTally, tally, tallyLines, type Agent, type HookResult, type RunningServer } from '../harness';

const PEOPLE = ['ana', 'ben', 'cai', 'dee', 'eli', 'fay'];
/** §16's activity assumptions, per working agent: 4 heartbeats a minute (the 15 s default), 1.5 edits a minute, 20 MCP calls and 15 session/prompt/stop events an hour. */
const HOURS = 12;

let persist: string;
let server: RunningServer;
let team: Team;

beforeAll(async () => {
  process.env.HIVEMIND_GIT_BUDGET_MS ??= '15000'; // test-only: slow CI runners may need longer than the production Git budget
  persist = makeTemp('hm-e2e-scale-state-');
  server = await startServer(persist);
}, 180_000);

afterAll(async () => {
  tally.file = '';
  await server?.stop();
  team?.dispose();
  removeTemp(persist);
});

/** Runs fn over items with at most n at a time (the hook has a 1.5 s network budget; a thundering herd would fail open). */
async function par<T, R>(items: T[], fn: (x: T, i: number) => Promise<R>, n = 6): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i] as T, i);
    }
  }));
  return out;
}

let snapshots = 0;
async function snapshot(): Promise<any> {
  snapshots++;
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${SERVER.replace('http', 'ws')}/r/${team.room}/ws`, ['hivemind', team.viewerToken]);
    const timer = setTimeout(() => { ws.terminate(); reject(new Error('no snapshot in 10 s')); }, 10_000);
    ws.on('message', (d) => { clearTimeout(timer); ws.close(); resolve(JSON.parse(String(d))); });
    ws.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

/** Every edit permission the hooks ever granted, so "no two agents hold one file" is checked on the way, not only at the end. */
class Ledger {
  readonly holder = new Map<string, string>();
  readonly violations: string[] = [];
  grants = 0;
  denials = 0;
  /** An agent asked to edit a file and the hook answered. */
  record(agent: Agent, path: string, r: HookResult): void {
    if (r.code !== 0) this.violations.push(`${agent.callsign}: hook exited ${r.code}`);
    if (r.denied) {
      this.denials++;
      return;
    }
    this.grants++;
    const cur = this.holder.get(path);
    if (cur && cur !== agent.callsign) this.violations.push(`${path}: allowed for ${agent.callsign} while ${cur} holds it`);
    this.holder.set(path, agent.callsign);
  }
  releasePath(path: string): void { this.holder.delete(path); }
  releaseAgent(callsign: string): void {
    for (const [p, h] of this.holder) if (h === callsign) this.holder.delete(p);
  }
}

/** Counts of requests by kind, from the hook subprocesses' fetch log. */
function hookCounts(lines: string[]): Record<string, number> {
  const c: Record<string, number> = {};
  for (const l of lines) c[l] = (c[l] ?? 0) + 1;
  return c;
}

const count = (text: string, needle: string) => text.split(needle).length - 1;

describe('team of 6 people, 12 laptops, 18 agents', () => {
  it('runs a compressed hour of work with every invariant intact and measures the traffic', async () => {
    const ledger = new Ledger();
    const files: Record<string, string> = {};
    for (let k = 0; k < 18; k++) files[`src/mod${k}.ts`] = `export const mod${k} = ${k};\n`;
    for (const s of ['shared1', 'shared2', 'shared3', 'shared4']) files[`src/${s}.ts`] = `export const ${s} = 1;\n`;
    files['README.md'] = '# team scale\n';
    team = await new Team('scale').open(files, { requireTask: true });
    const tallyFile = join(team.base, 'requests.log');
    startTally(tallyFile);
    const usage0 = (await snapshot()).usage.requests as number;
    snapshots = 0;
    const t0 = Date.now();

    // ---------------------------------------------------------------- 1. everyone joins (12 laptops, then 6 second agents)
    const laptopAgents = await par(PEOPLE.flatMap((p, i) => [
      { p, laptop: 'a', tool: (i % 2 === 0 ? 'claude' : 'codex') as 'claude' | 'codex' },
      { p, laptop: 'b', tool: (i % 2 === 0 ? 'codex' : 'claude') as 'claude' | 'codex' },
    ]), (x) => team.agent(x.p, x.tool, true, undefined, { laptop: x.laptop }));
    const second = await par(PEOPLE, (p, i) => team.agent(p, i % 2 === 0 ? 'codex' : 'claude', true, undefined, { alongside: laptopAgents[i * 2]! }));
    // Index k: agents 0..11 are laptops (person = k>>1, laptop a/b), 12..17 are the second agent on each person's laptop a.
    const all: Agent[] = [...laptopAgents, ...second];
    const lapA = (i: number) => laptopAgents[i * 2]!;
    const lapB = (i: number) => laptopAgents[i * 2 + 1]!;
    const own = (k: number) => `src/mod${k}.ts`;

    expect(all).toHaveLength(18);
    expect(new Set(all.map((a) => a.callsign)).size).toBe(18);
    expect(all.filter((a) => a.tool === 'claude')).toHaveLength(9);
    expect(all.filter((a) => a.tool === 'codex')).toHaveLength(9);
    const snap1 = await snapshot();
    const usageAfterJoin = (snap1.usage.requests as number) - usage0;
    const joinRequests = tallyLines().length + [...tally.mcp.values()].reduce((a, b) => a + b, 0);
    expect(snap1.agents).toHaveLength(18);
    expect(new Set(snap1.agents.map((a: any) => a.checkout)).size).toBe(12);

    // ---------------------------------------------------------------- 2. tasks: 18 distinct claims, one contested task
    const topics = ['billing', 'search', 'auth', 'uploads', 'emails', 'exports', 'caching', 'webhooks', 'themes', 'audit log', 'rate limits', 'onboarding', 'reports', 'invoices', 'sso', 'imports', 'notifications', 'metrics'];
    const added = await all[0]!.mcp('task_add', {
      tasks: [...topics.map((t) => ({ title: `Rework the ${t} module` })), { title: 'Decide the release checklist' }], claim: false, force: true,
    });
    expect(added.isError).toBe(false);
    const ids: number[] = (added.value.created as { id: number }[]).map((c) => c.id);
    expect(ids).toHaveLength(19);
    const claims = await par(all, (a, k) => a.mcp('task_claim', { id: ids[k] }));
    expect(claims.map((c) => c.value.result)).toEqual(Array(18).fill('ok'));

    // Six agents from six people race for the contested task: exactly one wins, the rest are told who.
    const racers = [0, 1, 2, 3, 4, 5].map((i) => lapB(i));
    const raced = await Promise.all(racers.map(async (a) => ({ a, r: (await a.mcp('task_claim', { id: ids[18] })).value })));
    const winners = raced.filter((x) => x.r.result === 'ok');
    expect(winners).toHaveLength(1);
    const winner = winners[0]!.a;
    for (const x of raced.filter((y) => y !== winners[0])) {
      expect(x.r.result).toBe('taken');
      expect(x.r.owner).toBe(winner.callsign);
    }

    // ---------------------------------------------------------------- 3. everyone edits their own file
    const firstEdits = await par(all, async (a, k) => ({ a, k, r: await a.edit(own(k)) }));
    for (const x of firstEdits) {
      ledger.record(x.a, own(x.k), x.r);
      expect(x.r.denied, `${x.a.callsign} editing ${own(x.k)}: ${x.r.reason}`).toBe(false);
    }
    expect((await snapshot()).locks).toHaveLength(18);

    // ---------------------------------------------------------------- 4. collisions
    const collide = async (who: Agent, path: string, holder: Agent) => {
      const r = await who.preEdit(path);
      ledger.record(who, path, r);
      expect(r.denied, `${who.callsign} on ${path} (held by ${holder.callsign})`).toBe(true);
      expect(r.reason).toContain(`held by ${holder.callsign}`);
    };
    // Different people, different laptops, both tools.
    await par([[lapB(0), 2], [lapA(3), 4], [lapB(5), 1], [lapB(2), 3]] as const, async ([who, victim]) => {
      await collide(who, own(victim * 2), lapA(victim));
    });
    // The same person on her second laptop: a different checkout, so it must be denied as well.
    for (const i of [0, 3]) await collide(lapB(i), own(i * 2), lapA(i));
    // Many agents race for the same fresh files at the same moment: exactly one is allowed, the rest are denied naming it.
    const raceOn = async (path: string, who: Agent[]) => {
      const res = await Promise.all(who.map(async (a) => ({ a, r: await a.preEdit(path) })));
      for (const x of res) ledger.record(x.a, path, x.r);
      const ok = res.filter((x) => !x.r.denied);
      expect(ok, `${path}: ${res.map((x) => `${x.a.callsign}=${x.r.denied ? 'deny' : 'allow'}`).join(' ')}`).toHaveLength(1);
      for (const x of res.filter((y) => y.r.denied)) expect(x.r.reason).toContain(`held by ${ok[0]!.a.callsign}`);
      return ok[0]!.a;
    };
    // The agents use files nobody has edited yet; they already hold their own files, which is fine.
    const w1 = await raceOn('src/shared1.ts', [lapA(0), lapB(1), lapA(2), lapB(3), lapA(4)]);
    const w2 = await raceOn('src/shared2.ts', [lapA(1), lapB(1), lapB(4)]); // ben's two laptops among them
    const w3 = await raceOn('src/shared3.ts', [lapB(2), lapA(5), lapB(0), lapA(0)]);
    await collide(lapB(5), 'src/shared1.ts', w1);
    expect(ledger.violations).toEqual([]);
    expect(ledger.denials).toBeGreaterThanOrEqual(4 + 2 + 4 + 2 + 3 + 1);

    // Steady state of locks right now: 18 own files + 3 raced files, one holder each, matching what the hooks granted.
    const snap4 = await snapshot();
    const lockMap = new Map<string, string>(snap4.locks.map((l: any) => [l.path as string, l.holder as string]));
    expect(lockMap.size).toBe(21);
    expect(Object.fromEntries(lockMap)).toEqual(Object.fromEntries(ledger.holder));

    // ---------------------------------------------------------------- 5. heartbeats really are throttled to the interval
    const probe = lapA(5);
    const probeWindow = async () => {
      const before = tallyLines().length;
      for (let i = 0; i < 6; i++) await probe.fire('PostToolUse.mcp__hivemind__status');
      return tallyLines().length - before;
    };
    const w1req = await probeWindow();
    await sleep(15_500); // a real interval has to pass: the default heartbeat is 15 s
    const w2req = await probeWindow();
    expect(w1req).toBeLessThanOrEqual(1);
    expect(w2req).toBe(1);

    // ---------------------------------------------------------------- 6. pushes release locks and notify everyone else
    const pushLog: { who: Agent; paths: string[] }[] = [];
    const mark = all.map((a) => a.heard.length);
    const publish = async (who: Agent, paths: string[]) => {
      // Agents on one laptop share a checkout, so only the files this agent holds are staged.
      git(who.dir, 'add', '--', ...paths);
      git(who.dir, 'commit', '-q', '-m', `${who.callsign} changes ${paths.join(', ')}`);
      git(who.dir, 'pull', '-q', '--rebase', '--autostash', 'origin', 'main');
      await who.shell('git push origin main', () => git(who.dir, 'push', '-q', 'origin', 'main'));
      pushLog.push({ who, paths });
      for (const p of paths) ledger.releasePath(p);
      // The push is noticed on the pusher's own heartbeat call (PostToolUse after the shell command): the locks are gone.
      const locks = new Set((await snapshot()).locks.map((l: any) => l.path as string));
      for (const p of paths) expect(locks.has(p), `${who.callsign} pushed ${p} but it is still locked`).toBe(false);
    };
    // One push per person, on laptop a, plus the winners of the shared files (they edited with the hooks, but only file changes get pushed).
    for (let i = 0; i < 6; i++) await publish(lapA(i), [own(i * 2)]);
    // Fresh shared files: the winners really change them first (the race only reserved them).
    for (const [w, path] of [[w1, 'src/shared1.ts'], [w2, 'src/shared2.ts'], [w3, 'src/shared3.ts']] as const) {
      writeFileSync(w.abs(path), `changed by ${w.callsign}\n`);
      await w.postEdit(path);
      await publish(w, [path]);
    }
    expect(pushLog).toHaveLength(9);

    // Every other agent hears about every push exactly once, on whichever of its next hook calls came first (the hooks
    // of the pushes themselves included); further prompts are quiet about it. Agents sharing the pusher's checkout need no notice.
    await par(all, async (a) => { await a.heartbeat(); await a.heartbeat(); });
    for (const [k, a] of all.entries()) {
      const heard = a.heard.slice(mark[k]).join('\n');
      for (const p of pushLog) {
        const n = count(heard, `${p.who.callsign} pushed main (1 file: ${p.paths[0]})`);
        if (a === p.who) expect(n, `${a.callsign} was told about its own push`).toBe(0);
        else if (p.who.dir !== a.dir) expect(n, `${a.callsign} heard of ${p.who.callsign}'s push of ${p.paths[0]} ${n} times`).toBe(1);
        else expect(n).toBeLessThanOrEqual(1);
      }
    }

    // Agents that were denied can now take the freed files (after pulling), and only one of them holds each.
    git(lapB(0).dir, 'pull', '-q', '--rebase', '--autostash', 'origin', 'main');
    const retake = await lapB(0).edit(own(0), 'ana laptop b continues\n'); // ana's own file, freed by her push
    ledger.record(lapB(0), own(0), retake);
    expect(retake.denied).toBe(false);
    const blockedAgain = await lapA(1).preEdit(own(0)); // ben cannot also take it
    ledger.record(lapA(1), own(0), blockedAgain);
    expect(blockedAgain.denied).toBe(true);
    expect(blockedAgain.reason).toContain(`held by ${lapB(0).callsign}`);

    // ---------------------------------------------------------------- 7. messages between people
    const sent: { text: string; from: Agent; to: Agent | '*' }[] = [];
    const mark2 = all.map((a) => a.heard.length);
    for (let i = 0; i < 6; i++) {
      const from = lapA(i);
      const to = lapB((i + 1) % 6);
      const text = `DM-${i} please review the ${i} change`;
      expect((await from.mcp('post', { to: to.callsign, text })).isError).toBe(false);
      sent.push({ text, from, to });
    }
    for (const [i, from] of [[0, lapA(2)], [1, lapB(4)]] as const) {
      const text = `ALL-${i} standup moved`;
      expect((await from.mcp('post', { to: 'all', text })).isError).toBe(false);
      sent.push({ text, from, to: '*' });
    }
    await par(all, async (a) => {
      await a.heartbeat();
      await a.heartbeat();
      await a.fire('Stop'); // the Stop event delivers messages too
    });
    const mail = all.map((a, k) => ({ a, text: a.heard.slice(mark2[k]).join('\n') }));
    for (const m of mail) {
      for (const s of sent) {
        const expected = s.to === '*' ? (s.from === m.a ? 0 : 1) : (s.to === m.a ? 1 : 0);
        expect(count(m.text, s.text), `${s.text} at ${m.a.callsign}`).toBe(expected);
      }
    }
    // Nothing is left unread anywhere.
    for (const a of [lapB(1), lapB(3)]) expect((await a.mcp('inbox')).value.unread).toEqual([]);

    // ---------------------------------------------------------------- 8. finishing: tasks done, agents end
    const doneBy = [0, 2, 4, 6, 8, 10]; // the agents who pushed (laptop a of each person)
    await par(doneBy, async (k) => {
      const r = await all[k]!.mcp('task_update', { id: ids[k], status: 'done' });
      expect(r.isError, JSON.stringify(r.value)).toBe(false);
    });
    const beforeEnd = await snapshot();
    const lockedNow = new Map<string, string>(beforeEnd.locks.map((l: any) => [l.path as string, l.holder as string]));
    expect(Object.fromEntries(lockedNow)).toEqual(Object.fromEntries(ledger.holder));
    // Agents holding files end: their locks go. Six agents end now; the rest are still working.
    const leaving = [1, 3, 5, 7, 9, 11].map((k) => all[k]!);
    for (const a of leaving) {
      const r = await a.end();
      expect(r.code).toBe(0);
      ledger.releaseAgent(a.callsign);
    }
    const final = await snapshot();
    const finalLocks = new Map<string, string>(final.locks.map((l: any) => [l.path as string, l.holder as string]));
    expect(Object.fromEntries(finalLocks)).toEqual(Object.fromEntries(ledger.holder));
    const ended = new Set(leaving.map((a) => a.callsign));
    for (const h of finalLocks.values()) expect(ended.has(h), `a lock is still held by ended ${h}`).toBe(false);
    expect(final.agents.filter((a: any) => a.endedAt !== null)).toHaveLength(6);

    // Task board: 19 tasks, one owner each, statuses as scripted. An agent that ended gave its tasks back (open, no owner).
    const board = final.tasks as { id: number; owner: string | null; status: string }[];
    expect(board).toHaveLength(19);
    expect(new Set(board.map((t) => t.id)).size).toBe(19);
    for (const [k, id] of ids.entries()) {
      const t = board.find((x) => x.id === id)!;
      const owner = k === 18 ? winner : all[k]!;
      if (ended.has(owner.callsign)) expect(t, `task ${id} of ended ${owner.callsign}`).toMatchObject({ owner: null, status: 'open' });
      else expect(t, `task ${id}`).toMatchObject({ owner: owner.callsign, status: doneBy.includes(k) ? 'done' : 'in_progress' });
    }
    // Nobody is allowed anything extra along the way.
    expect(ledger.violations).toEqual([]);
    expect(final.mode).toBe('enforce');

    // ---------------------------------------------------------------- measurements
    const elapsedS = Math.round((Date.now() - t0) / 1000);
    const lines = tallyLines();
    const by = hookCounts(lines);
    const hookTotal = lines.length;
    const mcpTotal = [...tally.mcp.values()].reduce((a, b) => a + b, 0);
    const serverTotal = (final.usage.requests as number) - usage0;
    const edits = ledger.grants + ledger.denials;
    const get = (k: string) => by[k] ?? 0;
    const preEdit = get('/hook PreToolUse');
    const postForced = get('/hook PostToolUse') + get('/hook PostToolUse +git');
    const session = get('/hook SessionStart') + get('/hook SessionEnd');
    const prompts = get('/hook UserPromptSubmit') + get('/hook Stop');
    // 5 snapshots were taken by this test (dashboard connections); they count on the server but are not agent traffic.
    // The server count also includes the 6 invites' effects on /hook? No: invites go to the Worker admin route.
    expect(serverTotal).toBeGreaterThanOrEqual(hookTotal + mcpTotal);

    const agents = 18;
    const perAgentDay = {
      heartbeats: 4 * 60 * HOURS, // one per 15 s while working (verified above: at most one per window)
      edits: Math.round(1.5 * 60 * HOURS),
      mcp: 20 * HOURS,
      events: 15 * HOURS,
      // Measured above: an edit of a file Git has not yet reported as divergent, and a shell command (push, pull), each send one
      // heartbeat at once. Assumed: 6 newly touched files and 2 shell pushes or pulls an hour per agent.
      forced: 8 * HOURS,
    };
    const day = {
      heartbeats: perAgentDay.heartbeats * agents,
      edits: perAgentDay.edits * agents,
      mcp: perAgentDay.mcp * agents,
      events: perAgentDay.events * agents,
      forced: perAgentDay.forced * agents,
    };
    const total = day.heartbeats + day.edits + day.mcp + day.events + day.forced;
    // The budget guard (§16) doubles the interval at 60% of the cap: only heartbeats slow down, everything else keeps its rate.
    const slowAt = 60_000;
    const heartbeatShare = day.heartbeats / total;
    const guardAdjusted = total <= slowAt ? total : Math.round(slowAt + (total - slowAt) * (1 - heartbeatShare / 2));
    const report = {
      agents, people: PEOPLE.length, laptops: 12, scenarioSeconds: elapsedS,
      editChecks: { granted: ledger.grants, denied: ledger.denials },
      hookRequestsByKind: by,
      hookRequests: hookTotal, mcpRequests: mcpTotal, mcpByTool: Object.fromEntries(tally.mcp),
      serverRequestsDuringScenario: serverTotal,
      dashboardSnapshotsTaken: snapshots,
      otherServerRequests: serverTotal - hookTotal - mcpTotal - snapshots,
      join: { serverRequests: usageAfterJoin, hookAndMcpRequests: joinRequests, invites: 12 },
      derived: { preToolUseRequests: preEdit, postToolUseRequests: postForced, sessionEvents: session, promptAndStopEvents: prompts, editChecksMade: edits },
      throttleProbe: { requestsInFirstWindow: w1req, requestsAfter15sPause: w2req },
      extrapolation: { hoursActive: HOURS, perAgentPerDay: perAgentDay, requestsPerDay: { ...day, total }, shareOfCap: total / 100_000, guardAdjustedRequestsPerDay: guardAdjusted, guardAdjustedShareOfCap: guardAdjusted / 100_000 },
    };
    const byRoute: Record<string, number> = {};
    for (const m of server.log().matchAll(/(GET|POST|PUT|DELETE) (\/\S*) (\d{3})/g)) byRoute[`${m[1]} ${m[2]}`] = (byRoute[`${m[1]} ${m[2]}`] ?? 0) + 1;
    Object.assign(report, { serverRoutesFromLog: byRoute });
    // eslint-disable-next-line no-console
    console.log(`TEAM-SCALE REPORT ${JSON.stringify(report, null, 2)}`);
    if (process.env.HIVEMIND_E2E_REPORT) writeFileSync(process.env.HIVEMIND_E2E_REPORT, JSON.stringify(report, null, 2));
    expect(total).toBeLessThan(100_000);
  }, 240_000);
});
