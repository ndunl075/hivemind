# Worker briefs

Paste-ready briefs for the worker sessions in [ARCHITECTURE.md §20](../ARCHITECTURE.md#20-build-plan-architect-and-workers). The architect owns this file. Before launching a wave, the architect:

1. checks that `main` and CI are green and nothing is half-merged,
2. folds approved contract requests into `shared/contracts.ts` (the contract checkpoint),
3. fills in `<main-sha>` and pastes the common block into each brief.

Each worker is launched only when Nico says so.

## Installed in Wave 0

The Wave 0 scaffold installs these and defines these scripts, so no worker touches the root `package.json` or lockfile.

| Package | Used by |
|---|---|
| `typescript`, `vitest` | everyone |
| `wrangler`, `@cloudflare/workers-types`, `@cloudflare/vitest-pool-workers` | W1, W3, W4, W6, W7 |
| `esbuild`, `@playwright/test` (with Chromium) | W2, W6 |
| `smol-toml` | W5 |
| `ws` (WebSocket client for Node 20) | W7 |

Scripts: `typecheck`, `test` (everything except e2e and smoke), `test:workers`, `test:hook`, `test:cli`, `test:dashboard`, `test:e2e`, `test:smoke`, `deploy`. Each test script runs a fixed set of folders, never a substring filter.

## Common block (goes into every brief)

```text
Repo: https://github.com/ndunl075/hivemind  (main at <main-sha>)
Stack: server and dashboard in TypeScript (npm workspaces, Vitest, @cloudflare/vitest-pool-workers, esbuild, Wrangler);
CLI and hook in plain ESM JavaScript with JSDoc types (checked by tsc), no build step.
Read first: ARCHITECTURE.md (the design) and docs/parallel-sessions.md (rules for parallel sessions; follow them exactly).
Work in your own worktree on branch w/<task>, then run `npm ci` there. Auto mode on.
shared/contracts.ts is frozen. Don't edit it; put requests under "Requests for the architect" in your PR description.
Every dependency you need is already installed. If one is missing, request it instead of adding it.
Stop condition: an open PR against main; CI green (or the failure explained); `npm run typecheck`, `npm test`
and the tests below passing locally; docs/evidence/<task>.md written. Never merge. Then stop and report one line.
```

## W0: spike (Wave 0)

```text
[worker] spike: run the worker-checkable verifications in ARCHITECTURE.md §21
Model: Sonnet, high effort.
<common block>, task = spike
Task: answer §21 items 1–14 with evidence, and record which fallback applies to each item that fails.
- Run real Claude Code and Codex sessions (claude -p, codex exec) in a THROWAWAY project folder outside this repo,
  using only project-level config there (.claude/settings.json and .mcp.json; .codex/config.toml and .codex/hooks.json).
  Never edit user-level hook or MCP config (~/.claude/settings.json, ~/.claude.json, ~/.codex/hooks.json,
  ~/.codex/config.toml). If marking the throwaway project as trusted in Codex writes to ~/.codex/config.toml, take the
  "user-config" lock first, back the file up, and restore it when done.
- Put spike scripts, hooks and servers in that throwaway folder. They are never committed.
- Record the stdin payload of every hook event in §6.2 from both tools, one file per event and tool variant, as
  shared/fixtures/hooks/<tool>/<event>[.<tool_name>].json (for example claude/PreToolUse.Edit.json,
  codex/PreToolUse.apply_patch.json, claude/PreToolUse.mcp.json, claude/PostToolUse.Bash.json).
  Scrub each fixture: replace usernames, home paths, hostnames, emails, session ids and transcript paths with
  placeholders; replace prompt text and file contents with short placeholders; keep the structure exact.
- Note the exact claude and codex versions.
You own: docs/spike-results.md, shared/fixtures/hooks/**, docs/evidence/spike.md.
Stay out of: everything else.
Locks: "real-agents" while any real session runs; "user-config" for any user-level config write.
Done: every item 1–14 marked confirmed or refuted, with evidence and the fallback; fixtures for every event and tool
variant in §6.2 exist and contain no personal data.
Tests: none beyond `npm run typecheck`; the fixtures are consumed by later workers.
```

## W1: skeleton (Wave 1)

```text
[worker] skeleton: Worker, Room, Claude hook and file locks, deployable
Model: Sonnet, high effort (persistence, concurrency, locking).
<common block>, task = skeleton
Task: build the walking skeleton described in ARCHITECTURE.md §20.3 Wave 1:
- server/src/worker.ts: routes in §8.1 (/hook, /whoami, /health, /admin/rooms create/delete/invite/revoke;
  /mcp with only the status tool; /r/<room>/ws may return 501 for now), token verification in the Worker (§13).
- server/src/room.ts: schema created in code, memory load, atomic mutations, memory-first writes (§8.2).
- server/src/pipeline.ts: a hook pipeline and MCP tool registry with extension points; one stub module in each of
  server/src/features/{locks,tasks,messages,git,snapshot,mcp}/ that later slices fill in.
- Locks: §9 rules 1, 2, 3 (release when not divergent, using a divergent list sent by the hook) and 11.
- Briefing (§6.6) and denial text (§9). The status tool (§7).
- cli/hook/hook.mjs for Claude Code: SessionStart, edit PreToolUse, PostToolUse heartbeat with divergent files
  from `git status --porcelain` only, fail-open and outage notice (§6.3), hook.log format (§6.3).
  Stub modules cli/hook/codex.mjs and cli/hook/git.mjs that later slices fill in.
- npm run deploy (wraps wrangler deploy).
You own (this wave only): server/**, cli/hook/**, docs/evidence/skeleton.md.
Stay out of: dashboard/**, cli/hivemind.mjs, cli/commands/**, shared/**, test/**.
Port: 8787 for wrangler dev.
Done:
- npm run test:workers passes, including:
  - 100 concurrent edit checks on one path → exactly one holder;
  - a lock is released when the holder's divergent list drops the file;
  - state survives a Room restart;
  - a bad token is rejected without touching the Room.
- npm run test:hook passes, using shared/fixtures/hooks/claude/*:
  - exact Claude output shapes;
  - server down, slow or returning garbage → exit 0 within the timeout;
  - the outage notice after 3 failures.
- A manual run with wrangler dev and a real Claude Code CLI session blocks an edit (take the "real-agents" lock),
  recorded in the evidence file.
```

## W2: dashboard (Wave 1)

```text
[worker] dashboard: view-only live hive dashboard on fixture data
Model: Sonnet, medium effort.
<common block>, task = dashboard
Task: build dashboard/ per ARCHITECTURE.md §14: top bar with mode and banners, hive graph (nodes, states, five edge
types, pulse animations, force layout), Tasks/Locks/Activity panels, footer usage, token prompt, reconnect banner,
visual tokens (§14.4), self-hosted Inter and Geist Mono, assets/logo.svg and assets/favicon.svg (read-only), and a
_headers file with the CSP in §13. Render all agent-supplied text with textContent. Isolate the data source in
dashboard/src/live/: for now it reads shared/fixtures/snapshot.json and a fake pulse stream you write in
dashboard/src/live/fake.ts. W6 replaces it with the live socket later.
You own: dashboard/**, docs/evidence/dashboard.md, docs/evidence/dashboard/*.png.
Stay out of: server/**, cli/**, shared/**, assets/**.
Port: 5173 for the dev server.
Done:
- npm run test:dashboard passes (layout logic, state derivation from timestamps, text escaping: a task title
  containing <img onerror> renders as text).
- Screenshots at 1440 px and 390 px (taken with Playwright) in docs/evidence/dashboard/, linked from the
  evidence file.
- Text contrast of at least 4.5:1 for body text and visible keyboard focus, checked and recorded in the evidence
  file.
```

## W3: tasks-and-messages (Wave 2)

```text
[worker] tasks-and-messages: task board, messaging and every MCP tool
Model: Sonnet, high effort (concurrency, permissions).
<common block>, task = tasks-and-messages
Task: implement in server/src/features/{tasks,messages,mcp}/:
- §10 completely: states, owner-only updates, the task gate (a pipeline stage on edits), dependencies, duplicates,
  areas (reserving them through the locks feature's exported API), takeover, and ended owners.
- §11 completely: delivery paths (heartbeat, UserPromptSubmit, Stop block rules, deny reasons, inbox, wait),
  bounces, quoted framing, rate limits, retention.
- §7: every tool except status (already built), with the descriptions and instructions text.
You own: server/src/features/tasks/**, server/src/features/messages/**, server/src/features/mcp/**,
docs/evidence/tasks-and-messages.md.
Stay out of: every other path, including server/src/pipeline.ts, room.ts and worker.ts (hotspots; request changes).
Done:
- npm run test:workers passes with tests for:
  - 50 concurrent claims → one owner;
  - owner-only updates;
  - the gate denies an edit without a task and allows it after task_add with claim: true;
  - dependency refusal;
  - duplicate thresholds;
  - Stop blocks once for a direct message and never for a broadcast or when stop_hook_active;
  - a bounce to an ended agent;
  - the rate limit;
  - wait resolves on a message and times out at 45 s (fake timers).
- MCP conformance tests for every tool.
```

## W4: git-layer (Wave 2)

```text
[worker] git-layer: divergence, push detection, stale copies and the remaining lock rules
Model: Sonnet, high effort (locking).
<common block>, task = git-layer
Task: implement ARCHITECTURE.md §12 and §9 rules 4–12:
- cli/hook/git.mjs: repo identity, divergent files (status, staged, untracked, unpushed vs upstream or default
  branch, 500-path cap), push detection, blob SHAs, the stale-copy check and its three messages, and read-only Git
  commands only.
- server/src/features/git/: pushes table, push notices to active agents in the repo, lastPush in /hook responses.
- server/src/features/locks/: shell-edit attribution, conflicts across checkouts, checkout-mates, folder
  reservations, takeable holders and take, ended holders, advisory and ignore paths, room modes, and the
  exported API that the tasks feature uses for areas.
You own: cli/hook/git.mjs, server/src/features/git/**, server/src/features/locks/**, docs/evidence/git-layer.md.
Stay out of: every other path, including cli/hook/hook.mjs (hotspot; request wiring changes).
Done:
- npm run test:hook passes with scripted temporary Git repos covering:
  - unpushed commits, untracked files and no upstream;
  - a push from the shell and a push made outside the agent (both detected);
  - a fetch followed by a push (no misattribution);
  - stale copies: unknown commit, same branch, other branch, squash merge (no warning when blobs match).
- npm run test:workers passes for each of lock rules 4–12 and all three modes.
```

## W5: codex-and-install (Wave 2)

```text
[worker] codex-and-install: Codex adapter and every CLI command
Model: Sonnet, high effort (credentials, config files).
<common block>, task = codex-and-install
Task:
- cli/hook/codex.mjs: Codex payload parsing (apply_patch paths) and output builders with the exact Codex shapes
  from shared/fixtures/hooks/codex/* (unknown fields make Codex ignore the hook, so test exact shapes).
- cli/hivemind.mjs and cli/commands/: every command in ARCHITECTURE.md §17 (room create/delete, invite, revoke,
  init, join, doctor with the per-app self-test prompt, mode, unlock, off/on, update, leave).
  - Merge into existing ~/.claude/settings.json, ~/.codex/hooks.json, ~/.codex/config.toml (using smol-toml),
    AGENTS.md and CLAUDE.md (marker-delimited) without clobbering anything, and idempotently.
  - Record the absolute node path; write command and commandWindows for Codex.
  - Register the Claude MCP server with `claude mcp add-json --scope user` using headersHelper, so no token is
    ever in argv.
  - Hidden token input; owner-only file permissions; never print or log a token after it's entered.
You own: cli/hook/codex.mjs, cli/hivemind.mjs, cli/commands/**, docs/evidence/codex-and-install.md.
Stay out of: every other path, including cli/hook/hook.mjs (hotspot; request wiring changes).
Port: 8790 for any fake server in tests.
Done:
- npm run test:cli passes, with temporary home and project folders and a stubbed command runner for `claude`
  and `codex`. Never touch the real ~/.claude, ~/.claude.json, ~/.codex or ~/.hivemind; take the "user-config"
  lock if a manual check needs them, and restore them after.
- Tests prove:
  - running join twice changes nothing;
  - existing hooks and MCP servers survive;
  - leave removes only what join added;
  - no token appears in any argv, log or stdout.
- npm run test:hook passes for codex fixtures.
```

## W6: dashboard-live (Wave 2)

```text
[worker] dashboard-live: snapshot builder and the live socket
Model: Sonnet, medium effort.
<common block>, task = dashboard-live
Task:
- server/src/features/snapshot/: the dashboard snapshot (shape in shared/contracts.ts) and pulse events, debounced
  to at most 4 per second, sent over the WebSocket Hibernation API with the viewer token as a subprotocol (§8.2,
  §13); per-day usage for the footer.
- dashboard/src/live/: replace the fixture source with the live socket, with reconnect and backoff, keeping fake.ts
  for development.
You own: server/src/features/snapshot/**, dashboard/src/live/**, docs/evidence/dashboard-live.md.
Stay out of: every other path.
Ports: 8789 for wrangler dev, 5174 for the dashboard dev server.
Done:
- npm run test:workers passes:
  - a viewer gets a snapshot on connect and after a change;
  - debouncing holds under 100 rapid changes;
  - a bad viewer token is refused before the Room is touched.
- npm run test:dashboard passes.
- A manual run shows a live change within 1 s, recorded in the evidence file.
```

## W7: e2e-and-hardening (Wave 3)

```text
[worker] e2e-and-hardening: end-to-end tests and the real-agent smoke script
Model: Sonnet, medium effort.
<common block>, task = e2e-and-hardening
Task:
- test/e2e: wrangler dev on port 8788 plus scripted hook.mjs calls (using the recorded fixtures as templates)
  covering:
  - a blocked edit, release by push, a shell-edit conflict and a takeover;
  - task claim races, message delivery, a push notice;
  - the budget guard thresholds, fail-open, and the outage notice;
  - room modes and emergency unlock.
- test/smoke: a script that creates a throwaway project with project-level config pointing at local wrangler dev,
  runs one real `claude -p` and one real `codex exec` session asked to edit the same file, and asserts that exactly
  one is blocked and that a message is delivered.
- File GitHub issues for anything broken outside test/. Don't fix it.
You own: test/**, docs/evidence/e2e-and-hardening.md.
Stay out of: everything else.
Locks: "real-agents" for the smoke run.
Done:
- npm run test:e2e passes locally and in CI.
- npm run test:smoke passes once, recorded in the evidence file.
- Issues filed and linked in the PR description.
```
