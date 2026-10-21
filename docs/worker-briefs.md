# Worker briefs

Paste-ready briefs for the worker sessions in [ARCHITECTURE.md §20](../ARCHITECTURE.md#20-build-plan-architect-and-workers). The architect owns this file. Before launching a wave, the architect:

1. checks that `main` and CI are green and nothing is half-merged,
2. folds approved contract requests into `shared/` (the contract checkpoint),
3. fills in `<main-sha>` and pastes the common block into each brief.

Each worker is launched only when Nico says so.

## Installed in Wave 0

The Wave 0 scaffold installs these and defines these scripts, so no worker touches the root `package.json` or lockfile.

| Package | Used by |
|---|---|
| `typescript`, `vitest`, `@types/node` | everyone |
| `wrangler`, `@cloudflare/workers-types`, `@cloudflare/vitest-pool-workers` | W1, W4, W5, W7, W8 |
| `esbuild`, `happy-dom` (DOM for dashboard tests), `@playwright/test` | W3, W7 |
| `@fontsource-variable/inter`, `@fontsource/geist-mono` (self-hosted fonts) | W3 |
| `smol-toml` (a runtime dependency of the CLI) | W6 |
| `ws` (WebSocket client for Node 20) | W8 |

The glob matcher for `advisory` and `ignore` (§9) is written in-house, so it has no package. Playwright's browser isn't installed by `npm ci`: workers that take screenshots run `npx playwright install chromium` once in their worktree.

Scripts, defined in Wave 0:

| Script | Runs |
|---|---|
| `typecheck` | `tsc` over the whole repo, including `cli/` via `checkJs` |
| `test` | everything below except `test:e2e` and `test:smoke` |
| `test:workers` | `server/src` |
| `test:hook` | `cli/hook` |
| `test:cli` | `cli/commands` |
| `test:dashboard` | `dashboard/src` |
| `test:e2e` | `test/e2e` |
| `test:smoke` | `test/smoke` (manual) |
| `build` | the dashboard into `dashboard/dist` |
| `dev` | `wrangler dev` plus the dashboard in watch mode |
| `deploy` | `build`, then `wrangler deploy -c server/wrangler.toml` |

## Common block (goes into every brief except W0)

```text
Repo: https://github.com/ndunl075/hivemind  (main at <main-sha>)
Stack: server and dashboard in TypeScript (npm workspaces, Vitest, @cloudflare/vitest-pool-workers, esbuild, Wrangler);
CLI and hook in plain ESM JavaScript with JSDoc types (checked by tsc), no build step.
Read first: ARCHITECTURE.md (the design) and docs/parallel-sessions.md (rules for parallel sessions; follow them exactly).
Work in your own worktree on branch w/<task>, then run `npm ci` there. Auto mode on.
Everything in shared/ is frozen, including the internal interfaces your code meets other features through. Don't edit
it; put requests under "Requests for the architect" in your PR description.
Every dependency you need is already installed. If one is missing, request it instead of adding it.
Tests go next to the code they test; owning a file includes its tests.
Stop condition: an open PR against main; CI green (or the failure explained); `npm run typecheck`, `npm test`
and the tests below passing locally; docs/evidence/<task>.md written. Never merge PRs. Then stop and report one line.
```

## W0: spike (Wave 0, after the scaffold lands)

```text
[worker] spike: run the worker items in ARCHITECTURE.md §21
Model: Sonnet, high effort.
Repo: https://github.com/ndunl075/hivemind  (main at <main-sha>)
Read first: ARCHITECTURE.md and docs/parallel-sessions.md. Work in your own worktree on branch w/spike. Auto mode on.
Task: answer every §21 item whose "Who" is W0, with evidence, and record the fallback for each item that fails.
- Run real Claude Code and Codex sessions (claude -p, codex exec) in a THROWAWAY project folder outside this repo,
  using only project-level config there (.claude/settings.json and .mcp.json; .codex/config.toml and .codex/hooks.json).
  Never edit user-level hook or MCP config (~/.claude/settings.json, ~/.claude.json, ~/.codex/hooks.json,
  ~/.codex/config.toml). If marking the throwaway project as trusted in Codex writes to ~/.codex/config.toml, take the
  "user-config" lock, back the file up first, and restore it when done.
- Spike scripts, hooks and servers stay in that throwaway folder and are never committed.
- Record the stdin payload of every hook event in §6.2 from both tools as shared/fixtures/hooks/<tool>/<file>.json,
  where <file> is <event>, <event>.<tool_name> for tool events (MCP tools as <event>.mcp__hivemind__status), or
  SessionEnd.<reason>. Scrub each fixture: replace usernames, home paths, hostnames, emails, session ids and transcript
  paths with placeholders; replace prompt text and file contents with short placeholders; keep the structure exact.
- Write docs/manual-checks.md: step-by-step instructions for every §21 item whose "Who" is Nico, including the full
  text of any throwaway hook script or config needed (inline, since nothing else is committed), and what to record.
- Note the exact claude and codex versions.
You own: docs/spike-results.md, docs/manual-checks.md, shared/fixtures/hooks/**, docs/evidence/spike.md.
Stay out of: everything else.
Locks: "real-agents" while any real session runs; "user-config" for any user-level config write.
Done: every W0 item in §21 marked confirmed or refuted with evidence and the fallback; fixtures for every event and tool
variant in §6.2 that fires; no personal data in any file; docs/manual-checks.md ready for Nico.
Stop condition: an open PR against main with only the files above; CI green (or the failure explained). No npm steps
are needed. Never merge PRs. Then stop and report one line.
```

## W1: server-core (Wave 1)

```text
[worker] server-core: Worker, Room and basic features, deployable
Model: Sonnet, high effort (persistence, concurrency, locking, permissions).
<common block>, task = server-core
Task: build the server half of the walking skeleton (ARCHITECTURE.md §20.3 Wave 1):
- server/src/worker.ts: every route in §8.1, token verification before any Room is touched (§13), the WebSocket
  upgrade with the viewer token as a subprotocol.
- server/src/room.ts: §8.2 completely: schema in code, memory load, atomic mutations, memory-first writes, the
  WebSocket plumbing (snapshot on connect and on change, debounced, pulses) calling SnapshotApi, the wait registry,
  limits, the budget guard (§16), room modes and emergency unlock.
- server/src/pipeline.ts: the hook and tool pipeline with extension points.
- Basic implementations behind every interface in shared/contracts.ts, each in its feature folder:
  - locks: §9 rules 1–3, 6, 7, 8 and 11, plus modes;
  - messages: notify() with delivery on heartbeats;
  - tasks: a stub with the gate off;
  - snapshot: agents, locks and mode only;
  - mcp: the status tool.
- The briefing (§6.6) and the denial text (§9), using shared/state.ts and shared/protocol.md.
- server/wrangler.toml: the Room class, static assets from ../dashboard/dist with the single-page-app fallback.
You own (this wave only): server/**, docs/evidence/server-core.md.
Stay out of: dashboard/**, cli/**, shared/**, test/**.
Port: 8787 for wrangler dev.
Done (npm run test:workers):
- 100 concurrent edit checks on one path → exactly one holder;
- a lock is released when the holder's divergent list drops the file, and never by a truncated list;
- folder reservation, take on a takeable holder, and ended holders behave per §9;
- state survives a Room restart;
- a bad agent or viewer token is rejected without touching the Room;
- the budget guard thresholds, including the switch to warn at 95%;
- wait resolves on notify() and times out at 45 s (fake timers);
- a viewer receives a snapshot on connect and after a change.
`npx wrangler deploy --dry-run -c server/wrangler.toml` succeeds (the architect does the real deploy after merging).
```

## W2: hook-core (Wave 1)

```text
[worker] hook-core: the hook for Claude Code
Model: Sonnet, high effort (permissions, fail-open).
<common block>, task = hook-core
Task: build cli/hook/hook.mjs and cli/hook/claude.mjs per ARCHITECTURE.md §6.2–§6.4:
- every event in §6.2 for Claude Code, with exact output shapes from shared/fixtures/hooks/claude/*;
- the local me check;
- dynamic loading of modules inside the top-level try;
- HIVEMIND_HOME;
- settings from .hivemind/project.json;
- the SessionStart baseline and shellSinceHeartbeat;
- heartbeat throttling, the circuit breaker, the outage notice and hook.log;
- GIT_OPTIONAL_LOCKS=0 on every Git call.
Also build basic cli/hook/git.mjs (repo identity; divergent files from `git status` only) and a cli/hook/codex.mjs stub,
both implementing shared/hook-modules.d.ts.
You own (this wave only): cli/hook/**, docs/evidence/hook-core.md.
Stay out of: server/**, dashboard/**, cli/hivemind.mjs, cli/commands/**, shared/**, test/**.
Done (npm run test:hook, using a fake server and HIVEMIND_HOME in a temporary folder):
- exact Claude output for every fixture;
- the me check denies a wrong callsign without any network call;
- server down, slow or returning garbage, or a module that fails to load → exit 0 within the timeout;
- the circuit breaker opens after 3 failures and skips the network for 60 s;
- the outage notice and outageMs reporting;
- an unmapped repo or the off file → exit 0 with no output and no network.
The first real-session check (a real `claude -p` blocked by the deployed skeleton) is done by the architect after W1 and
W2 merge.
```

## W3: dashboard (Wave 1)

```text
[worker] dashboard: view-only live hive dashboard on fixture data
Model: Sonnet, medium effort.
<common block>, task = dashboard
Task: build dashboard/ per ARCHITECTURE.md §14:
- the top bar with mode and banners;
- the hive graph: nodes, states from shared/state.ts, the five edge types, pulse animations, force layout;
- the Tasks, Locks and Activity panels and the footer usage;
- the token prompt and the reconnect banner;
- the visual tokens (§14.4) with self-hosted Inter and Geist Mono;
- assets/logo.svg and assets/favicon.svg, read-only;
- a _headers file with the CSP in §13.
Render all agent-supplied text with textContent. Build into dashboard/dist (npm run build). Isolate the data source in
dashboard/src/live/: for now it reads shared/fixtures/snapshot.json and a fake pulse stream in dashboard/src/live/fake.ts.
W7 replaces it with the live socket later.
You own: dashboard/** (except dashboard/dist, which is gitignored), docs/evidence/dashboard.md,
docs/evidence/dashboard/*.png.
Stay out of: server/**, cli/**, shared/**, assets/**.
Port: 5173 for the dev server.
Done:
- npm run test:dashboard passes: layout logic, state display, and text escaping (a task title containing
  <img onerror> renders as text).
- Screenshots at 1440 px and 390 px (Playwright) in docs/evidence/dashboard/, linked from the evidence file.
- Body text contrast of at least 4.5:1 and visible keyboard focus, checked and recorded in the evidence file.
```

## W4: tasks-and-messages (Wave 2)

```text
[worker] tasks-and-messages: task board, messaging and every MCP tool
Model: Sonnet, high effort (concurrency, permissions).
<common block>, task = tasks-and-messages
Task: replace the basic tasks and messages features and complete the MCP feature, behind the interfaces in
shared/contracts.ts:
- §10 completely: states, owner-only updates, the task gate, dependencies, duplicates, areas (reserved through LocksApi),
  takeover, and ended owners.
- §11 completely: every delivery path, the Stop rules, bounces, quoted framing, rate limits, retention.
- §7: every tool, with the descriptions, and the instructions text from shared/protocol.md.
Your features' own text (task and message notices) lives in your folders.
You own: server/src/features/tasks/**, server/src/features/messages/**, server/src/features/mcp/**,
docs/evidence/tasks-and-messages.md.
Stay out of: every other path. Use LocksApi as it is; W5 is changing the locks feature behind it at the same time.
Done (npm run test:workers):
- 100 concurrent claims → one owner;
- owner-only updates;
- the gate denies an edit without a task and allows it after task_add with claim: true;
- dependency refusal, and dropped dependencies counting as satisfied;
- duplicate thresholds;
- Stop blocks once for a direct message and never for a broadcast or when stop_hook_active;
- a bounce to an ended agent;
- the rate limit;
- MCP conformance for every tool.
```

## W5: git-layer (Wave 2)

```text
[worker] git-layer: comparison points, push detection, stale copies and the remaining lock rules
Model: Sonnet, high effort (locking).
<common block>, task = git-layer
Task:
- cli/hook/git.mjs: §12 completely: repo identity, comparison points, divergent files (500-path cap), push detection,
  blob SHAs, the stale-copy check and its three messages; read-only Git with GIT_OPTIONAL_LOCKS=0. Keep the
  shared/hook-modules.d.ts interface.
- server/src/features/git/: pushes, push notices to active agents in the repo through MessagesApi.notify(), lastPush
  in /hook responses.
- server/src/features/locks/: §9 rules 4, 5, 9, 10 and 12 (shell-edit attribution with baseline, conflicts across
  checkouts, checkout-mates, advisory and ignore paths with the built-in glob matcher, branches), keeping LocksApi
  unchanged and its existing tests passing.
You own: cli/hook/git.mjs, server/src/features/git/**, server/src/features/locks/**, docs/evidence/git-layer.md.
Stay out of: every other path.
Done:
- npm run test:hook passes with scripted temporary Git repos covering:
  - unpushed commits, untracked files, no upstream, and a push to a same-named remote branch;
  - pushes from the shell and from outside the agent (both detected);
  - a fetch followed by a push (only the agent's own files count);
  - a revert, stash or reset (lock released, no push notice);
  - stale copies: unknown commit, same branch, other branch, squash merge (no warning when blobs match).
- npm run test:workers passes for lock rules 4, 5, 9, 10 and 12 and for push notices.
```

## W6: codex-and-install (Wave 2)

```text
[worker] codex-and-install: Codex adapter and every CLI command
Model: Sonnet, high effort (credentials, config files).
<common block>, task = codex-and-install
Task:
- cli/hook/codex.mjs: Codex payload parsing (apply_patch paths) and output builders with the exact Codex shapes from
  shared/fixtures/hooks/codex/*. Codex ignores a hook whose output has unknown fields, so test exact shapes. Keep the
  shared/hook-modules.d.ts interface.
- cli/hivemind.mjs and cli/commands/: every command in ARCHITECTURE.md §17: room create/delete, invite, revoke,
  rotate, init, join, doctor (with the per-app self-test prompt), mode, unlock, off/on, update, leave.
  - Merge into existing ~/.claude/settings.json, ~/.codex/hooks.json, ~/.codex/config.toml (with smol-toml),
    AGENTS.md and CLAUDE.md (marker-delimited, text from shared/protocol.md) without clobbering anything, and
    idempotently.
  - Copy cli/hook/ to $HIVEMIND_HOME/hook/. Record the absolute node path; write command and commandWindows for Codex.
  - Register the Claude MCP server with `claude mcp add-json --scope user` using headersHelper.
  - Hidden input for the agent token and the admin secret (or HIVEMIND_ADMIN_TOKEN); owner-only file permissions.
  - A token appears on screen only once, when room create or invite issues it, and never in argv or logs.
You own: cli/hook/codex.mjs, cli/hivemind.mjs, cli/commands/**, docs/evidence/codex-and-install.md.
Stay out of: every other path.
Port: 8790 for any fake server in tests.
Done:
- npm run test:cli passes, with temporary home and project folders and a stubbed runner for `claude` and `codex`.
  Never touch the real ~/.claude, ~/.claude.json, ~/.codex or ~/.hivemind.
- Tests prove:
  - running join twice changes nothing;
  - existing hooks and MCP servers survive;
  - leave removes only what join added;
  - no token appears in any argv or log, and only once in stdout for room create and invite.
- npm run test:hook passes for every codex fixture.
```

## W7: dashboard-live (Wave 2)

```text
[worker] dashboard-live: full snapshot and the live socket
Model: Sonnet, medium effort.
<common block>, task = dashboard-live
Task:
- server/src/features/snapshot/: the full dashboard snapshot (shape in shared/contracts.ts) behind SnapshotApi,
  including tasks, messages, edges, pulses and per-day usage. The Room's WebSocket plumbing (built in Wave 1) calls it.
- dashboard/src/live/: replace the fixture source with the live socket, with reconnect and backoff, keeping fake.ts
  for development.
You own: server/src/features/snapshot/**, dashboard/src/live/**, docs/evidence/dashboard-live.md.
Stay out of: every other path.
Ports: 8789 for wrangler dev, 5174 for the dashboard dev server.
Done:
- npm run test:workers passes: the snapshot matches the contract for a seeded room, and pulses are emitted for
  messages, denials and pushes.
- npm run test:dashboard passes.
- A manual run shows a live change within 1 s, recorded in the evidence file.
```

## W8: e2e-and-hardening (Wave 3)

```text
[worker] e2e-and-hardening: end-to-end tests and the real-agent smoke script
Model: Sonnet, medium effort.
<common block>, task = e2e-and-hardening
Task:
- test/e2e: wrangler dev on port 8788 plus scripted hook.mjs calls (using the recorded fixtures as templates and
  HIVEMIND_HOME in a temporary folder) covering:
  - a blocked edit, release by push, a shell-edit conflict and a takeover;
  - task claim races, message delivery, a push notice;
  - the budget guard thresholds, the circuit breaker, fail-open and the outage notice;
  - room modes and emergency unlock.
- test/smoke: a script that creates a throwaway project with project-level hooks and HIVEMIND_HOME pointing at local
  wrangler dev, runs one real `claude -p` and one real `codex exec` session asked to edit the same file, and asserts
  that exactly one is blocked and that a message is delivered.
- File GitHub issues for anything broken outside test/. Don't fix it.
You own: test/**, docs/evidence/e2e-and-hardening.md.
Stay out of: everything else.
Locks: "real-agents" for the smoke run.
Done:
- npm run test:e2e passes locally and in CI.
- npm run test:smoke passes once, recorded in the evidence file.
- Issues filed and linked in the PR description.
```
