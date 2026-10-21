# Evidence: hook-core (Wave 1, W3)

`cli/hook/hook.mjs` and `cli/hook/claude.mjs` for Claude Code (ARCHITECTURE.md §6.2 to §6.4), plus a basic `git.mjs`, a `codex.mjs` stub and `limits.mjs`. Plain ESM JavaScript with JSDoc types, checked by `tsc`; no build step, no dependencies, Node 20 or newer (global `fetch`).

## Files

| File | What it is |
|---|---|
| `cli/hook/hook.mjs` | The entry point. Only `node:` built-ins are imported statically; the adapter, `git.mjs` and `limits.mjs` are loaded with `import()` inside the top-level `try`. |
| `cli/hook/claude.mjs` | `parse` and `format` (shared/hook-modules.ts `ToolAdapter`). Output built from fixed field lists, matching `shared/fixtures/hooks/claude/output/*`. |
| `cli/hook/codex.mjs` | Stub. Parses the common fields, finds no edit paths, prints nothing. The Codex wave replaces it. |
| `cli/hook/git.mjs` | Basic `GitModule`: identity, `normalize`, divergent files from `git status` only. `staleWarnings` is a no-op. Every Git call goes through one wrapper with `GIT_OPTIONAL_LOCKS=0`. |
| `cli/hook/limits.mjs` | Hook-local copy of the `LIMITS` values the hook uses. `hook.test.mjs` imports `shared/contracts.ts` and asserts every key matches. |
| `cli/hook/*.test.mjs` | Tests, next to the code. |

The hook accepts a module either as named exports or as a `default` object, so the replacement `git.mjs` and `codex.mjs` may use either.

## `$HIVEMIND_HOME/config.json` (read by the hook, written by `join`)

```json
{
  "server": "<https url>",
  "room": "<room>",
  "person": "<name>",
  "token": "<agent token>",
  "repos": ["<root commit sha>"]
}
```

`HIVEMIND_HOME` defaults to `~/.hivemind`. The hook uses `server` (must start with `http://` or `https://`; a trailing slash is dropped), `token` and `repos`; `room` and `person` are informational. The hook is active only when the checkout's root commit is in `repos`. A missing or malformed file means exit 0 with no output. `$HIVEMIND_HOME/off` is the local kill switch. `hook.log` lives in the same folder.

## Behavior as built

Flow (§6.3): read stdin, `off`, config, load adapter, parse, resolve the checkout, mapped check, local fast paths, circuit breaker, request, response handling, output. Anything that throws exits 0 with no output and logs one line.

- **Events:** all six of §6.2. Request fields follow §6.4 and server/src/validate.ts: `git` (divergent, `baseline` on SessionStart only, upstream, truncated, pushed) on SessionStart, UserPromptSubmit, Stop and due PostToolUse; `paths` on PreToolUse edits; `stopActive`; `endReason`; `settings`; `outageMs`; `repoName`.
- **Edit paths:** Claude `Edit`, `Write`, `MultiEdit` use `file_path`; `NotebookEdit` uses `notebook_path`. Paths are normalized to repo-relative POSIX by `git.normalize` (symlink-safe, drops anything outside the checkout or under `.git/`). If none remain, no request is made. A PreToolUse for any non-edit, non-Hivemind tool makes no request.
- **me check:** `PreToolUse` on `mcp__hivemind__*` compares `tool_input.me` with the callsign cached in the session state; a mismatch denies locally (no network) and names the right callsign. No cached callsign, or no `me`, means no output. It runs before the circuit breaker, so it also works during an outage.
- **Session state:** one JSON file per session under `<os tmpdir>/hivemind-hook/` (the name is a hash of the session id): cached identity per `cwd` (refreshed after 10 s for any request), callsign, `heartbeatMs`, `lastHeartbeat`, `shellSinceHeartbeat`, Git memory, settings hash, failure counter, outage timestamps. Written atomically. Deleted on `SessionEnd` unless the reason is `clear` or `resume`. Files untouched for two days are pruned on `SessionStart`.
- **Baseline:** `SessionStart` calls `git.state(root, null)` and sends the divergent files as `baseline` (the hook adds `baseline` itself if the module didn't).
- **Heartbeats:** `PostToolUse` sends a request only when `now >= lastHeartbeat + heartbeatMs`, or when `shellSinceHeartbeat` is set (a `Bash` or `PowerShell` PostToolUse sets it, so that same call sends). Any request that carries Git state resets `lastHeartbeat` and clears the flag, but only after the server accepted it, and the Git memory (`previous` for push detection) is likewise saved only on success. With `heartbeatMs: 0` from the server, `PostToolUse` exits before any network, and `UserPromptSubmit` and `Stop` still send their request but without `git`. `SessionStart` always reports its baseline.
- **Settings:** `.hivemind/project.json` is read at the checkout root (max 64 KB, must be a JSON object), sent on `SessionStart` and whenever its hash changes; the hash is committed only after a successful request.
- **Stale-copy check:** after a PreToolUse answer that is not a deny and carries `lastPush`, the hook calls `git.staleWarnings(root, branch, lastPush)` inside its own `try`. A failure drops only the warning. The module returns plain sentences; the hook adds the header `[Hivemind] Before you edit:` and one `- ` bullet per line, appended to the server's context.
- **Circuit breaker and outage:** every failed attempt (network, timeout, non-2xx, bad JSON, bad shape, or any other error after the session is known) increments the counter. At 3, and until 60 s after the last attempt, the network is skipped. The notice from §6.3 step 14 is printed once per outage, as `additionalContext`, on the first event that can carry context (`SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`; `Stop` and `SessionEnd` cannot, so the notice waits). After 60 s one attempt goes out with `outageMs` (time since the first failure of the streak); the first success resets the counter and the notice flag.
- **Timeouts:** 1,500 ms network, 800 ms for `SessionEnd`; a 3.5 s watchdog exits 0 whatever else hangs.
- **hook.log:** one JSON line `{ts, event, tool, ok, ms, error?}` per network attempt and per caught error; `tool` is the tool name (null for non-tool events). Tokens are redacted from error text, message text is never logged, and the file rotates to `hook.log.1` above 1 MB. Nothing is written if `$HIVEMIND_HOME` doesn't exist.
- **Subagents:** events carrying `agent_id` are treated as the parent session's (`session_id` is used as is).
- **Claude only:** `MultiEdit` stays in the edit set (harmless); `PostToolUse` for `ToolSearch` is just another throttled PostToolUse.

## Tests

`npm run test:hook` (4 files, 104 tests) runs the real `hook.mjs` as a child process against a fake `/hook` server on an ephemeral port, with `HIVEMIND_HOME` and the OS temp dir in temporary folders and a throwaway Git repo as the checkout.

- **Exact output for every fixture** (`claude.test.mjs`): each `output/*` fixture is either reproduced byte for byte by `format` or listed as a shape Hivemind never emits (exit codes, invalid JSON, timeout, unknown fields); a new fixture fails the test until classified. Every input fixture parses, and runs through `hook.mjs` and exits 0 with no stderr. End-to-end tests print the recorded `stdout` for SessionStart, UserPromptSubmit, PreToolUse (deny, deny with context, context), PostToolUse and Stop.
- **me check** denies a wrong callsign with the request count unchanged.
- **Fail-open:** server down, 500, garbage, wrong shape, unknown decision, a server that never answers (returns at about 1.5 s), SessionEnd faster than that, bad stdin, unknown event or tool, and seven module-load failures (syntax error, missing file, throw on load, wrong exports for claude, git and limits): all exit 0 with no output within 3 s.
- **Circuit breaker:** closes after 3 failures with the notice once, skips the network (also against a hanging server), half-opens after 60 s (state back-dated), reports `outageMs` on the retry and after recovery, and gives a second outage its own notice. Non-network errors count too.
- **Stubbed `git.mjs`** (a private copy of the hook folder): `git.pushed` in the SessionStart and UserPromptSubmit requests, the stale-copy warning in the PreToolUse output, a throwing `staleWarnings` dropping only the warning, no warning on a deny, Git memory saved only after success, a throwing `state()` sending the request without `git`.
- **Also:** heartbeat throttling, the forced heartbeat after Bash or PowerShell, `heartbeatMs` 0, settings, unmapped repo, `off` file, missing config, `HIVEMIND_HOME`, `SessionEnd` state cleanup, hook.log content and rotation.
- **LIMITS copy:** imports `shared/contracts.ts` and asserts every key of `HOOK_LIMITS` equals `LIMITS`.
- `git.test.mjs`: identity (subdirectory, remote name, no commits, outside a repo), `normalize`, divergent files including untracked files in new folders and renames.

Not tested: the real effect of `GIT_OPTIONAL_LOCKS=0` (the wrapper is the only place Git runs, and the variable is asserted as a constant), macOS and Linux, and a real `claude -p` against the deployed server (the architect's first-session check).

## Latency (this Windows laptop, local fake server, 12 runs)

`UserPromptSubmit` including identity, `git status` and one request: about 105 to 160 ms (first run 158 ms). A throttled `PostToolUse` (no network, cached identity): about 45 ms. The target is 300 ms on Windows.

## Notes for the architect

- Tests sit next to the code in `cli/hook/`, so `join`'s copy of the hook folder should skip `*.test.mjs` (the five runtime files are `hook.mjs`, `claude.mjs`, `codex.mjs`, `git.mjs`, `limits.mjs`).
- The `git.mjs` here is deliberately basic: no comparison point, so `git.pushed` is always null and `staleWarnings` returns nothing until the full module replaces it.
- `claude.mjs` does not special-case subagent `Stop` events; Claude's subagent end is a separate event not registered in §6.2.
