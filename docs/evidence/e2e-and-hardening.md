# Evidence: e2e-and-hardening

End-to-end tests of the real hook against the real server, and a smoke script with real `claude` and `codex` sessions.
Everything is under `test/`; nothing outside `test/` and this file was changed (the `test:e2e` and `test:smoke` scripts in `package.json` already worked, so they are untouched).

## What was built

| File | What it is |
|---|---|
| `test/harness.ts` | Not a test. Starts `wrangler dev` on port 8788 (throwaway secrets, throwaway persistence folder, builds the dashboard first if `dashboard/dist` is missing). A `Team` is a room plus a bare "origin" repo; an `Agent` is a person with their own clone, their own `HIVEMIND_HOME` and their own session. Agents run the real `cli/hook/hook.mjs claude\|codex` with payloads made from the recorded fixtures in `shared/fixtures/hooks` (Claude `Edit`, Codex `apply_patch`, `Bash`, `SessionStart`, ...) and call `/mcp` like an MCP client. Also helpers to write a stopped server's Room SQLite file. |
| `test/e2e/coordination.test.ts` | 16 scenarios on one server, one room each. |
| `test/e2e/resilience.test.ts` | 11 scenarios: fail-open, breaker, outage notice, takeover, budget guard. |
| `test/smoke/smoke.test.ts`, `test/smoke/project.ts` | The real-agent smoke test and its setup. |
| `test/vitest.config.ts` | `fileParallelism: false` (the files share port 8788 and the hook has a 1.5 s network budget) and a 120 s hook timeout. |

Run: `npm run build` once (the server serves `dashboard/dist`), then `npm run test:e2e` (about 2 minutes: two server starts and two 16 s waits for the one-heartbeat lock age rule). CI already has `npm run test:e2e` after `npm run build` in the `test` job, so no CI change is needed.

## Scenarios (all pass locally on Windows)

Coordination (`coordination.test.ts`):
- **Blocked edit.** Claude holds `a.txt`; a Codex `apply_patch` on it is denied with the section 9 text, in the shape Codex accepts (only `hookSpecificOutput`); the other files stay editable; the holder may edit again; the `status` tool lists who holds what; a reserved folder blocks files inside it and a second reservation is all or nothing; advisory paths (`package.json`) are never denied.
- **Release by push.** After a push, the other agent's next hook says "claude-ana pushed main (1 file: a.txt). Pull before editing that file."; a lock younger than one heartbeat interval stays until the next report, then a `wait` for `release:a.txt` wakes with `release`; the stale clone gets the "Before you edit" warning; after `git pull` it does not. Release by revert (`git checkout`). All locks go when the agent ends, and a message to it bounces.
- **Shell edits.** A file changed by a shell command is locked for that agent afterwards (rule 4) and blocks the other agent. Two checkouts that both changed a file get a conflict notice each, and the dashboard snapshot has a `blocked` edge.
- **Tasks.** The task gate (no `.hivemind/project.json`, so `requireTask` is on): denied without a task, allowed after `task_add` with `claim`. 40 simultaneous claims of one task by 20 people (10 Claude, 10 Codex, registered without hooks) leave exactly one owner and 39 `taken` answers naming that owner.
- **Messages.** Direct and broadcast messages arrive through the next hook, once; the inbox is empty afterwards; a third agent gets the broadcast but not the direct message; `inbox` works for an agent that missed its hooks; `wait` wakes on a message.
- **Room modes.** `warn` turns a denial into a heads-up and the room is told; `off` checks nothing; `enforce` denies again; the mode reaches the hook state; an invalid mode is a 400.
- **Emergency unlock.** By path and by agent; the room is told; giving both is a 400.
- **Dashboard socket.** A snapshot on connect shows the agents, locks and mode; a forged viewer token gets 401.

Resilience (`resilience.test.ts`):
- **Fail-open and the breaker.** With the server unreachable: failures 1 and 2 allow the edit with no output; failure 3 allows it and prints the outage notice once ("Can't reach the server (3 failed attempts)..."); with the breaker open there is no network attempt (`lastAttemptAt` unchanged), no repeat of the notice and no output; SessionEnd exits 0.
- **Recovery.** After the 60 s window (simulated by editing the hook's state file) and with the server back, the next event reaches the server and `status` shows the outage length (`outageMs` over 60 s).
- **Silent server.** A server that accepts and never answers: the hook gives up inside 4.5 s, allows the edit, counts one failure.
- **Refused token.** Not counted as an outage; the edit is allowed.
- **Nothing to do.** Broken JSON, non-payload JSON, no config, a non-https non-loopback server, a folder that is not a repo, and the `off` file all exit 0 with no output.
- **Takeover.** The room's SQLite file is edited while wrangler is stopped (holder silent for 20 minutes), then wrangler is started again, so the server code that reacts is the real one. The blocked agent is told it "may `take`"; `take` needs a reason, then works; the old holder is told and is now blocked; `task_claim` shows the owner as takeable and `take: true` moves the task. A holder who is working is refused.
- **Budget guard.** One room per threshold, each with its counter set to one request below the line: 60% gives a 30 s heartbeat, 80% a 60 s heartbeat, 95% turns heartbeats off (the hook's PostToolUse then makes no network call), switches the room to warn with the announcement, and a teammate setting `enforce` afterwards wins over the guard. A room the guard switched yesterday is put back by the first request of a new day, with the announcement.

## Smoke run with real agents

`npm run test:smoke` (one `claude -p` with `--model haiku`, one `codex exec` at `model_reasoning_effort=low`, two checkouts of one throwaway repo in a temporary folder outside this repo, project-level hooks and MCP config, `HIVEMIND_HOME` pointing at local wrangler dev). Claude edits `shared.txt` and waits for a message while holding the lock; Codex is asked to edit the same file and, if blocked, to post a message containing `SMOKE-PING` to the holder.

Two real runs were made (the limit), with the `real-agents` and `user-config` locks held and released afterwards.

1. **Run 1: failed, no Codex tokens spent.** The test timed out at 120 s (my per-test timeout was missing; the config default applied). While looking at what had happened, Codex's own session log showed the real cause: the machine's default Codex model is not supported with a ChatGPT-plan account ("The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account", HTTP 400 before any work). The same log showed that Codex's project-level hooks did run (the Hivemind briefing reached the model). A free-of-tokens check with `codex mcp list` in a throwaway folder then showed that the project's `.codex/config.toml` MCP server only loads once the project is trusted.
2. **Run 2: passed** (the test took 43 s; the whole run 95 s). Changes after run 1: a 900 s test timeout, a progress log kept outside the repo, `-m gpt-5.6-luna` (the model the spike recorded for Codex; override with `SMOKE_CODEX_MODEL`), and the script itself appends the trusted-project entry to the Codex user config after backing it up, restoring it in a `finally`.

Result of run 2 (from the progress log):
- Agents: `claude-ana` (claude), `codex-bo` (codex).
- Dashboard pulses: exactly one `denied` (`codex-bo` to `claude-ana`, `shared.txt`) and one `message` (`codex-bo` to `claude-ana`).
- Codex printed `hook: PreToolUse Blocked` for its `apply_patch`, the Section 9 denial text, then `mcp: hivemind/post (completed)`. It used about 26,000 tokens.
- Claude's final answer was the delivered message: "SMOKE-PING: shared.txt is locked; please handle the requested old->codex replacement."
- Claude's checkout has `claude` in `shared.txt`; Codex's still has `old` (the blocked edit did not happen).
- Both hook logs: 6 lines, 0 failed.

Touched outside the temporary folder: only `~/.codex/config.toml` (project trust entry added, then restored; the checksum matches the original, printed by the test and checked by hand). `~/.claude/settings.json` has the same checksum before and after. No user-level hook or MCP config was written, and nothing but `127.0.0.1` and the two model backends was contacted. The Codex output also showed errors about the user's other, unrelated MCP servers; those are not part of this test.

Deviation to note: the brief says not to change the Codex model. On this machine the default model fails outright on the owner's plan (run 1), so the script passes the cheap model the spike used. `SMOKE_CODEX_MODEL` changes it.

## Findings outside `test/` (issues filed, not fixed)

- #20: a push within one heartbeat interval of the edit is not recognised by the hook, so no push notice and no stale-copy data (the lock is still released). The e2e test inserts one heartbeat between edit and push to get the notice, and says why.
- #21: `repoNameOf` shows the path for a Windows local-path origin (display only).

## Notes and limits

- The tests use `node:sqlite` (Node 22.13+, prints an ExperimentalWarning) to seed the stopped server's Room database; this is the only way to reach "quiet for 20 minutes" and "95,000 requests" without waiting or flooding. The table and column names it writes (`agents.last_event`, `meta` keys `budget:<date>`, `mode`, `mode_by_guard`, `guard_switch_date`) are server internals: if they change, `resilience.test.ts` must follow.
- The Windows CI job runs only the root `vitest run`, so e2e runs on Linux in CI; it was run on Windows here. The Linux path (`detached` process group kill, `git init -b`) was not run locally.
- Not covered: the 12-hour ended threshold and the 24-hour push TTL (server unit tests cover them with fake clocks), and a real heartbeat-driven `UserPromptSubmit` from a live agent (the smoke run shows hooks firing in real sessions).

## Requests for the architect

None. CI already runs `npm run test:e2e` after `npm run build`. If e2e is slow on CI runners, `timeout-minutes: 20` on the `test` job still leaves room (about 2 minutes locally).
