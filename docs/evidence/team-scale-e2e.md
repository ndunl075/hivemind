# Team-scale end-to-end test

## What was built

- `test/e2e/team-scale.test.ts`: one room, 6 people x 2 laptops (12 clones, each with its own `HIVEMIND_HOME`), 18 agents (9 Claude, 9 Codex: each person has a Claude and a Codex laptop, plus a second agent sharing laptop "a"'s checkout). It drives the real `hook.mjs` with recorded payloads against `wrangler dev` (port 8788).
- `test/harness.ts` (additive): `Team.agent(..., { laptop, alongside })` for several laptops per person and a second agent on a laptop; `Agent.heard` (every context a hook call returned, so deliveries can be counted); optional request counting (`startTally`, `tally`, `tallyLines`).
- `test/count-fetch.mjs`: test-only `node --import` preload that logs each request a hook makes (loaded only while a tally file is set).

## The scripted hour

1. Join: 18 SessionStarts (12 distinct checkouts, 18 distinct callsigns).
2. Tasks: 19 added; 18 agents claim a distinct task each; 6 agents (one per person) race for the 19th: exactly one `ok`, five `taken` naming the winner.
3. Edits: each agent edits its own file (task gate on, `requireTask: true`): 18 allowed, 18 locks.
4. Collisions: 4 cross-person pairs, 2 same-person-two-laptops pairs (denied, different checkouts), three simultaneous races of 5, 3 and 4 agents on a fresh file (exactly one allowed each, the rest denied naming it), one more late collision.
5. Throttle probe: 6 status-tool events in a row cost 0 requests (a heartbeat was recent); after a real 15.5 s pause, 6 more cost exactly 1.
6. Pushes: 9 pushes (6 own files + 3 raced files), each from its own clone through a real `git push` and the `PostToolUse` Bash event. After each, the lock is gone. Every other agent on another checkout is told of each push exactly once; the pusher never is. A freed file can be taken by one agent, and a third is denied naming it.
7. Messages: 6 direct messages and 2 broadcasts. Each is delivered exactly once to its recipients (direct: only the recipient; broadcast: everyone but the sender) across `UserPromptSubmit` and `Stop` events; the inbox is empty afterwards.
8. Finish: 6 tasks marked done, 6 agents end.

## Invariants asserted

- Every PreToolUse answer feeds a ledger; at no time are two agents allowed the same file (`violations` stays empty), and the ledger equals the server's lock table (via the dashboard socket) at three checkpoints and at the end.
- A pushed file is unlocked by the time the pusher's shell hook returns; ended agents hold no locks.
- Task board: 19 tasks, ids unique, each owned as scripted; done stay done; tasks of ended agents (including the race winner) return to `open` with no owner.
- Every push notice and message delivered exactly once.

## Measurements (one run; repeat runs gave identical counts)

Scenario: 47-64 s of work (the test body, including the one 15.5 s sleep, about 55-65 s; the suite adds about 30 s for wrangler start and stop).

| Requests during the scenario | Count |
|---|---|
| Hook requests (`POST /hook`) | 185: SessionStart 18, PreToolUse 39, PostToolUse 32 (all carried Git state), UserPromptSubmit 72, Stop 18, SessionEnd 6 |
| MCP calls (`POST /mcp`) | 41: task_claim 24, post 8, task_update 6, inbox 2, task_add 1 |
| Dashboard sockets, invites, room setup | 14 + 12 + 2 (not agent traffic) |
| Worker log by route | `/hook` 185, `/mcp` 41: the same as the client-side counts |
| Room budget counter (server side) | 268; 16 more than the routes listed in the log, from admin and dashboard requests |

Per-event cost: PreToolUse 1 request per edit check (39 of 39), MCP 1 per call, prompt/stop/session events 1 each, heartbeat at most 1 per 15 s (probe above). Not in §16's table: a first edit of a file Git has not reported yet, and every shell command, send an extra heartbeat at once (all 32 PostToolUse requests were such forced ones, or at least carried Git state).

### Extrapolation: this team, 18 agents, 12 working hours, default 15 s heartbeat

| Source | Per agent a day | 18 agents a day |
|---|---|---|
| Heartbeats (4 a minute) | 2,880 | 51,840 |
| Edit checks (1.5 a minute) | 1,080 | 19,440 |
| MCP calls (20 an hour) | 240 | 4,320 |
| Session, prompt, stop (15 an hour) | 180 | 3,240 |
| Forced heartbeats (assume 6 new files + 2 shell commands an hour) | 96 | 1,728 |
| **Total** | | **80,568 (81% of the 100,000 cap)** |

With the budget guard (30 s heartbeats from 60,000): about 74,000 (74%).

## Comparison with ARCHITECTURE.md §16

- §16's table is correct arithmetic (8 agents: 36,000) and scales linearly: 16 agents at 3 edits a minute would be 88,000, consistent with the test's 18 agents at 1.5 a minute giving 80,568.
- Not contradicted, but one sentence was missing: forced heartbeats are in addition to the throttled ones, not replacing them ("barely changes" holds: about +2%). I added a short measured paragraph to §16 after "That's why there's a guard", stating this and what the 18-agent team costs.
- Practical reading: a six-person team with all 18 agents working all day at §16's rates fits the free tier (under the 95% `warn` switch) only because of the guard's 30 s step (it starts after about 9 of the 12 hours); at 24 agents the day would reach about 107,000 unguarded. The row-write and Durable Object compute estimates were not measured here.

## How tested

`npm run test:e2e` (all three suites, 28 tests) and `npm run typecheck` pass locally. `HIVEMIND_GIT_BUDGET_MS` defaults to 15000 inside this test for slow runners. Set `HIVEMIND_E2E_REPORT=<file>` to write the measurements as JSON. `test:smoke` and real agents were not run.

## Not done

- Row-write and Durable Object compute figures from §16 are not measured.
- Two agents sharing one checkout are not tested against each other for the same file (only against other checkouts).
