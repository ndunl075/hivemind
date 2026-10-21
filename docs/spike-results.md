# Spike results (ARCHITECTURE.md §21, worker items)

Answers for every §21 item whose "Who" is W0, with evidence and the fallback for anything that failed. Items assigned to Nico are in [manual-checks.md](manual-checks.md); the architect records their results at the bottom of this file. How each check was run, and what was touched on the machine, is in [evidence/spike.md](evidence/spike.md).

## Versions and environment

| Thing | Version |
|---|---|
| Claude Code (`claude`) | 2.1.287 |
| Codex CLI (`codex`) | codex-cli 0.159.3 |
| Node | v22.23.2 |
| OS | Windows 11 (10.0.26200), Git Bash and Windows PowerShell 5.1 |
| Claude model used | `haiku` (hooks do not depend on the model) |
| Codex model used | `gpt-5.6-luna`, reasoning effort low |

Everything ran with `claude -p` and `codex exec` in a throwaway git project outside this repository, using only project-level config there (`.claude/settings.json`, `.mcp.json`, `.codex/config.toml`, `.codex/hooks.json`), plus `--settings`/`--mcp-config` files for Claude. macOS and Linux were not available; anything that needs them is in manual-checks.md.

## Summary

| # | Verdict | One line |
|---|---|---|
| 1 | confirmed | Both tools work with a stateless, JSON-only MCP server (405 on GET is tolerated). |
| 2 | confirmed (interactive-only parts are Nico's) | Fixtures recorded for every §6.2 event and tool variant that fires, from both tools, in non-interactive mode. |
| 3 | confirmed, with Codex strictness rules | Output shapes recorded. Codex failed open on unknown fields in PreToolUse and PostToolUse output. |
| 4 | confirmed | Codex fires `PreToolUse` for `apply_patch`; a deny blocks in every Claude and Codex mode tried. |
| 5 | confirmed on Windows | Claude `command` + `args` runs with no shell, under both Git Bash and PowerShell. |
| 6 | confirmed, with required quoting | Codex uses `commandWindows` on Windows and runs it through PowerShell. |
| 7 | partly refuted | Static `Authorization` works and `approve` stops prompts, but there is no 60 s default tool timeout in 0.159.3. |
| 8 | partly confirmed | Works via `--mcp-config` / `--settings`; project scope in `-p` needs workspace trust; user scope pending M2. |
| 9 | partly confirmed | Codex `SessionEnd` is cut at about 3 s including PowerShell startup; subagent lifecycle events carry the parent's `session_id`; subagent tool hooks not observed. |
| 10 | confirmed for Claude, refuted for Codex on Windows | Out-of-session timings: a Claude hook process is about 40 ms; Codex on Windows adds about 1.1 s of PowerShell startup per hook. |

## Fixtures

`shared/fixtures/hooks/<tool>/<file>.json`, scrubbed (session, turn, prompt, tool-use and agent ids, transcript paths, working directory, prompt text, file contents and command output are placeholders; structure and field order are unchanged). Naming: `<event>`, `<event>.<tool_name>`, `SessionEnd.<reason>`, plus `SessionStart.<source>` for non-startup sources, `Stop.stop_hook_active` for the second Stop after a block, and `UserPromptSubmit.subagent` for the prompt fired inside a Codex subagent.

| Tool | Recorded |
|---|---|
| Claude | `SessionStart`, `SessionStart.resume`, `UserPromptSubmit`, `Stop`, `Stop.stop_hook_active`, `SessionEnd.other`; `PreToolUse.` and `PostToolUse.` for `Read`, `Write`, `Edit`, `NotebookEdit`, `Bash`, `PowerShell`, `Glob`, `Grep`, `mcp__hivemind__status`; `PostToolUse.ToolSearch` |
| Codex | `SessionStart`, `SessionStart.resume`, `UserPromptSubmit`, `UserPromptSubmit.subagent`, `Stop`, `Stop.stop_hook_active`, `SessionEnd.other`, `SubagentStart`, `SubagentStop`; `PreToolUse.` and `PostToolUse.` for `apply_patch` (one patch with Add, Update, Delete and Move), `Bash`, `mcp__hivemind__status`, `spawn_agent`, `multi_agent_v1wait_agent` |

Output samples: `shared/fixtures/hooks/<tool>/output/<case>.json` (34 files). Each records the event, the exact stdout string and exit code (`null` for a timeout), the observed effect, and `verdict`: `accepted` means the tool honoured the output as intended, `rejected` means it ignored it or flagged the hook as failed and carried on.

**Provenance and scrubbing.** All payloads come from `claude -p` and `codex exec` runs (non-interactive; Codex with `--dangerously-bypass-hook-trust` and a sandbox or bypass flag, Claude with allow-lists or permission-mode flags). Interactive sessions may differ (for example `permission_mode` or extra fields). Everything was recorded on Windows, so paths are Windows paths, scrubbed to `C:\proj\...` (shown JSON-escaped in the files); no POSIX variant was recorded (M7 asks Nico for one on a Mac). Response shapes are kept faithful: Codex `apply_patch` keeps its `Exit code: 0\nWall time: ...\nOutput:\n...` string, Codex `Bash` keeps a plain string with the text replaced by `<stdout>`, and MCP results keep `{content:[{type,text}]}`.

Facts a hook author needs, taken from the fixtures:

- **Claude** payloads carry `session_id`, `transcript_path`, `cwd`, `scratchpad_dir`, `prompt_id`, `permission_mode`, `hook_event_name`; tool events add `tool_name`, `tool_input`, `tool_use_id`; `PostToolUse` adds `tool_response` (always an object or array) and `duration_ms`; MCP tools add `mcp_server: {name, source}`. `Stop` carries `stop_hook_active`, `last_assistant_message`, `background_tasks`, `session_crons`. `SessionEnd` has `reason` (`other` for `-p`) and no `scratchpad_dir`.
- **Codex** payloads carry `session_id`, `transcript_path`, `cwd`, `hook_event_name`, `model`, `permission_mode`; turn-scoped events add `turn_id`. `tool_response` is a plain string for `Bash` and `apply_patch` (`"Exit code: 0 ... Success. Updated the following files:\nA p.txt\n..."`) and an MCP result object (`{content:[...]}`) for MCP tools. `SessionEnd` has no `turn_id`.
- **Codex tool names:** `Bash` (shell and unified exec), `apply_patch`, `mcp__<server>__<tool>`, `spawn_agent`, `multi_agent_v1wait_agent`. File reads are done through `Bash`; there is no `Read`, `Glob` or `Grep` tool.
- **Codex `apply_patch`** `tool_input` is `{ "command": "*** Begin Patch\n*** Add File: ...\n*** Update File: ...\n*** Move to: ...\n*** Delete File: ...\n*** End Patch" }`. The paths in it were **absolute** in the recorded run, so §6.3 step 7 must handle absolute and relative paths (it already says relative paths resolve against `cwd`).
- **Claude tool names:** `Edit`, `Write`, `NotebookEdit` (`tool_input.notebook_path`), `Bash`, `PowerShell` (exists on Windows; a separate tool from `Bash`), `Read`, `Glob`, `Grep`, `ToolSearch`. **`MultiEdit` does not exist in 2.1.287.** Leaving it in the matcher is harmless. `Edit`/`Write` use `file_path`.
- **Claude `PostToolUse` also fires for `ToolSearch`**, an internal tool, so a `.*` matcher is noisier than it looks.
- **`permission_mode` in `codex exec`** reads `bypassPermissions` when run with `--dangerously-bypass-hook-trust` and a sandbox flag, and `default` under `--approve-for-me`. Do not branch on it.
- **A Codex session fires `UserPromptSubmit` again for a subagent's prompt**, with `agent_id` and `agent_type` added. The parent's has neither.

## 1. Stateless JSON-only Streamable HTTP: confirmed

A 60-line Node server answered every `POST /mcp` with `Content-Type: application/json`, returned `202` for notifications, `405` for `GET`, never sent an `Mcp-Session-Id`, and never streamed. Both tools initialised, listed tools and called them (`status`, and a `wait` tool that slept up to 130 s).

- Claude sent `Accept: application/json, text/event-stream`, protocol `2025-11-25`, plus a `GET /mcp` with `Accept: text/event-stream` after initialisation (it accepted the `405`). Before `initialize` it sends a probe `POST` with method `server/discover` and protocol header `2026-07-28`; the stub answered with a JSON-RPC error (`-32601`, HTTP 200) and Claude fell back to `initialize`. **The real server must answer unknown methods with a JSON-RPC error and not crash on this probe.**
- Codex sent `Accept: text/event-stream, application/json`, protocol `2025-06-18`, and only `POST`s.
- Fallback (single-event SSE): not needed.

## 2. Hook payloads: confirmed

See Fixtures above. Not recorded here because they need an interactive session (moved to manual-checks.md, M1): `SessionStart` sources `clear`, `compact` (both tools) and `fork` (Codex); `SessionEnd` reasons other than `other` (`clear`, `resume`, `prompt_input_exit`; `logout` is deliberately not exercised); Claude `SubagentStart/Stop`-style events are outside §6.2. `SessionStart.resume` was recorded for both tools through `claude -p --resume` and `codex exec resume --last`.

Events that never fired: none of the §6.2 events. Claude's `SessionEnd` fires with reason `other` at the end of `-p`.

## 3. Output shapes: confirmed, with strictness rules

Full detail is in the output samples. Rules the output builders need:

**Claude Code** (lenient: unknown fields are ignored)
- `PreToolUse` deny: `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"..."}}` blocks and shows the reason. Adding `additionalContext` to the same object delivers both. Exit code 2 with stderr also blocks.
- `PostToolUse`: `hookSpecificOutput.additionalContext` is delivered; `decision:"block"` + `reason` is delivered as feedback but the tool result is still shown.
- `Stop`: `{"decision":"block","reason":"..."}` continues the turn with the reason; the next `Stop` has `stop_hook_active: true`.
- `SessionStart` and `UserPromptSubmit`: `hookSpecificOutput.additionalContext` is delivered.
- Exit 1, malformed JSON (treated as plain text) and a timeout are all non-blocking: the tool runs.

**Codex** (strict, as tested on `PreToolUse` and `PostToolUse`: an unsupported or unknown field fails the hook and the action continues. `SessionStart`, `UserPromptSubmit` and `Stop` were only tested with valid output, so their handling of unknown fields is untested)
- Same `hookSpecificOutput` shapes as Claude for `SessionStart`, `UserPromptSubmit`, `PreToolUse` (deny, `additionalContext`), `PostToolUse` (`additionalContext`) and `Stop` (`decision:"block"`).
- **An unknown field in `PreToolUse` output turns a deny into an allow.** `{"hookSpecificOutput":{...deny...},"bogusTop":true}` and a deny with an extra key inside `hookSpecificOutput` both showed the hook as `Failed` and the tool ran. The same happened in `PostToolUse` (the context was not delivered). `continue:false` / `stopReason` on `PreToolUse` fail the hook the same way. The builders must emit only the fields listed in the output samples.
- Allowed together with a deny: `systemMessage`, and `additionalContext` (the model saw both the reason and the context).
- Legacy `{"decision":"block","reason":"..."}` also blocks on `PreToolUse`. On `PostToolUse` it **replaces the tool result** with the reason, and the context still arrives.
- Exit 2 with stderr blocks, but see item 6: on Windows it only works if the command propagates the exit code.
- Plain text, malformed JSON, exit 1 and a timeout are non-blocking (the first two are silently ignored, the last two show `Failed`).
- A second `Stop` arrives with `stop_hook_active: true` after a block, as in Claude.

Fallback: none needed. The design in §6.2 stands, with the builder rule above made explicit: **build Codex output from a fixed whitelist of fields per event** (also the safe assumption for the three events not tested with extra fields).

## 4. Edit denial in each mode: confirmed

- **Codex fires `PreToolUse` for `apply_patch`** (`tool_name: "apply_patch"`). The matcher `apply_patch|Edit|Write|mcp__hivemind__.*` fired for `apply_patch` and the MCP tool and not for `Bash`. (The `Edit` and `Write` aliases were not tested on their own; `apply_patch` matched.)
- A `PreToolUse` deny blocked `apply_patch` and `Bash` in Codex under `-s workspace-write`, `-s read-only`, `--dangerously-bypass-approvals-and-sandbox` (full access) and `--approve-for-me` (automatic review); the file was never created. `--full-auto` no longer exists in 0.159.3.
- Claude's deny blocked `Edit` under `--permission-mode` `bypassPermissions`, `acceptEdits`, `auto` and the default; the file never changed.
- Not tested (needs the interactive TUI): Codex's interactive approval prompts, in manual-checks.md (M6). Shell-based writes are advisory by design (§9 rule 4); the `Bash` deny also worked, which is bonus coverage.
- Fallback: not needed. If a surface turns out not to run hooks, the existing "advisory" path applies.

## 5. Claude `command` + `args` without a shell: confirmed on Windows

- `"command": "C:\\Program Files\\nodejs\\node.exe"` with `args: ["C:\\Users\\...\\rec.mjs", "claude"]` ran; so did forward-slash paths. The path contains a space and needs no quoting.
- Arguments arrive untouched: `a b` stays one argument, and `$HOME`, `x&y` and `%PATH%` stay literal. The parent of the hook process is Claude itself (no `cmd.exe`, no `bash`).
- Identical behaviour when `claude` was launched from Git Bash and from PowerShell.
- For contrast, the shell form (`command` as one string, no `args`) is run by Git Bash: `$HOME` was expanded and `x\ y` became `x y`.
- Not tested: macOS and Linux (manual-checks.md, M7). The documented exec form needs a real `.exe` on Windows, which `node.exe` is.
- Fallback: not needed for Windows.

## 6. Codex `command` and `commandWindows`: confirmed, with required quoting

- **Windows uses `commandWindows` and ignores `command`** (the `command` copy tagged `codex-posix` never ran).
- **Windows runs it through Windows PowerShell 5.1.** Evidence: `cmd /c echo %CD% > file` produced a UTF-16 file (PowerShell's redirection), and a command made of a quoted path followed by arguments (`"C:\...\node.exe" "C:\...\rec.mjs" codex`) fails: in PowerShell that is a string followed by tokens, a parse error.
- **Working form:** `& "C:\Program Files\nodejs\node.exe" "C:\Users\...\hook.mjs" codex` (call operator, double quotes, backslashes).
- **Exit codes:** PowerShell reports 1 for any failing child unless the command ends with `; exit $LASTEXITCODE`. Without it, a hook's exit code 2 (block) arrives as 1 (a failed, non-blocking hook). `hook.mjs` blocks with JSON and exits 0, so it is not affected, but `join` should still write the suffix.
- **Feature flag:** none. `codex features list` shows `hooks` stable and on by default (`codex_hooks` is the old key).
- **Trust gates for project-level hooks** (the docs say user-level hooks in `~/.codex/hooks.json`, which is what `join` writes, load even in untrusted projects but still need hook review; **this was never tested** and is part of M3): the project must be trusted, and each hook definition must be reviewed (`/hooks`) or the run uses `--dangerously-bypass-hook-trust`. In `codex exec` an unreviewed or untrusted project hook is skipped **silently**. Side effect worth knowing: running `codex exec -s workspace-write` in an untrusted project appended `[projects.'<path>'] trust_level = "trusted"` to `~/.codex/config.toml`; that file was backed up and restored under the `user-config` lock.
- **A hook that crashes, exits non-zero or times out** is shown as `Failed`, does not block, and the action continues (exit 2 aside, see item 3). A timeout kills the hook at its `timeout`; Codex counts PowerShell's own startup against it.
- **Not tested:** macOS/Linux shell and the POSIX `command` form (manual-checks.md, M7).
- Fallback chosen: `join` writes Codex's `commandWindows` as `& "<node>" "<hook.mjs>" codex; exit $LASTEXITCODE` and the POSIX `command` as `"<node>" "<hook.mjs>" codex` with POSIX quoting. Paths containing a double quote or `$` need extra escaping (not tested).

## 7. Codex MCP config: partly refuted

- **Static `Authorization` in `http_headers`: confirmed.** The server received `Authorization: Bearer ...` and the custom header from the project `config.toml`.
- **`default_tools_approval_mode = "approve"` stops prompts: confirmed.** With `"prompt"` the call failed with "MCP tool call requires approval, but approval policy is never" (`codex exec` cannot ask). With `"approve"` it ran.
- **Default tool timeout of 60 s: refuted.** The docs say 60, but a `wait` call of 75 s and one of 130 s both completed with no timeout. The setting is enforced when given: `-c mcp_servers.hivemind.tool_timeout_sec=20` failed a 45 s call with "timed out awaiting tools/call after 20s".
- Fallback chosen: `join` writes `tool_timeout_sec = 60` explicitly, so the 45 s `wait` cap (§7) holds whatever the default is. Nothing else changes.
- Side finding: the current Codex docs list `http_headers_helper` (a command that prints a JSON header object, like Claude's `headersHelper`). 0.159.3 rejected it ("invalid transport"), so it is newer than this version. If a later Codex supports it, `join` could keep the token out of `config.toml`.

## 8. `claude mcp add-json` with `headersHelper`: partly confirmed

- `claude mcp add-json --scope project hivemind '{"type":"http","url":"...","headersHelper":"node <script>"}'` was accepted and wrote `.mcp.json`. The helper's JSON (`Authorization`, `X-Spike`) arrived as request headers on every request.
- **Allow rule (partly confirmed):** `permissions.allow: ["mcp__hivemind"]` (server-level) passed with `--settings <file>` let the tool run with no prompt; without it the call was denied (`permission_denials`). The same rule in the project's own `settings.json` is ignored in `-p` mode until the workspace is trusted, and the user-level placement `join` uses was not tested (M2).
- **Trust caveat:** in `-p` mode a **project**-scoped `permissions.allow` and a `.mcp.json` `headersHelper` are ignored until the workspace is trusted ("Ignoring 1 permissions.allow entry ... workspace has not been trusted"; "headersHelper not run"). That trust is recorded in `~/.claude.json`, which this spike did not edit. The same settings passed with `--settings <file>` and the server passed with `--mcp-config <file>` worked without trust. The user-scope setup `join` uses was not tested here (it needs a write to `~/.claude.json`); it is part of manual-checks.md M2.
- Fallback: static header written by `join` only if M2 shows the user-scope `headersHelper` failing.

## 9. Codex `SessionEnd` limits and subagent session ids: partly confirmed

- **SessionEnd:** per the Codex docs (not tested), 1 s by default and at most 3 s. Observed on Windows, with `timeout` 3 or 5: a hook that took 1.5 s completed; one that took 2.0 s (timeout 3) was killed; one that took 4.5 s (timeout 5) was killed. The PowerShell startup (item 10) counts against the budget, so the usable time for `hook.mjs` is about 1.5 to 1.9 s on this machine. Its 800 ms network cap plus Node and Git startup fits, but only because the registration sets `timeout: 3`; the docs' 1 s default would kill it. Per the Claude docs (also not tested), Claude's `SessionEnd` hooks share a 1.5 s budget that a longer per-hook `timeout` raises.
- **Subagents:** `SubagentStart`, `SubagentStop` and the `UserPromptSubmit` fired for the subagent's prompt carry the **parent's** `session_id`, plus `agent_id` and `agent_type`. **The subagent made no tool calls of its own, so whether its own `PreToolUse`/`PostToolUse` carry the parent's `session_id` or an `agent_id` was not observed** (M4 step 7 asks Nico). Until then, assume only that lifecycle events carry `agent_id`.
- The parent session's `SessionEnd` has reason `other` only.

## 10. Hook latency on Windows: confirmed for Claude, refuted for Codex

Measured on this Windows laptop **out of session**: `spawnSync` of a bare recorder script, not hooks timed inside a running Claude or Codex session (30 runs each, 10 for PowerShell):

| What | Median | Notes |
|---|---|---|
| `node -e 0` | 33 ms | bare Node startup |
| the recorder hook (`node rec.mjs`, read stdin, write a file) | 39 ms | Claude runs this directly |
| `git rev-parse --show-toplevel` | 18 ms | §6.3 step 4 does two Git calls |
| `powershell.exe -NoProfile -Command '& node rec.mjs'` | 1,125 ms | what Codex does on Windows |
| the same without `-NoProfile` | 1,172 ms | |

- **Claude:** about 40 ms for a hook plus about 40 ms of Git, so the 300 ms Windows target holds with the network call excluded.
- **Codex on Windows:** each hook pays about 1.1 s for PowerShell alone (this machine has Microsoft Defender active; `codex doctor` warns about it, so another laptop may be faster, but the order of magnitude is PowerShell's startup). Every `PreToolUse` and `PostToolUse` therefore adds about a second. The 300 ms target cannot be met on Codex/Windows.
- **Matcher exclusion in Claude: confirmed.** `^(?!(Read|Glob|Grep)$).*` on `PostToolUse` fired for `Bash` and not for `Read`, `Glob` or `Grep`.
- **Matcher exclusion in Codex: not possible with lookahead.** The same pattern never matched anything in Codex (not even `Bash`). Codex has no `Read`/`Glob`/`Grep` tools anyway, so use plain alternation.
- Fallback chosen: (a) on Codex use narrow matchers: `PreToolUse` as in §6.2 and `PostToolUse` limited to `Bash|apply_patch` (skipping MCP and housekeeping tools such as `spawn_agent`); (b) request for the architect, below: register Codex's `PostToolUse` heartbeat with `"async": true` so the 1.1 s does not block the model (documented to run in the background; not tested here). (c) Document that Codex on Windows is slower per tool call. macOS numbers: M7.

## Requests for the architect

1. §6.2/§6.3: Codex output must come from a per-event whitelist; any extra field fails the hook and turns a deny into an allow (item 3).
2. §6.2 Codex registration: write `commandWindows` as `& "<node>" "<hook.mjs>" codex; exit $LASTEXITCODE`; keep `command` POSIX (item 6).
3. §6.1/§7: write `tool_timeout_sec = 60` into the Codex MCP table (item 7), and treat `http_headers_helper` as a future option.
4. §6.2: consider `"async": true` for Codex's `PostToolUse` heartbeat, and a narrower Codex `PostToolUse` matcher (item 10).
5. §7: the real MCP server must answer the `server/discover` probe (an unknown method) with a JSON-RPC error and not a transport error (item 1).
6. §6.3 step 7: `apply_patch` paths can be absolute; Claude has no `MultiEdit` in 2.1.287 (items 2 and 4).
7. §6.2: Codex subagent lifecycle events carry the parent's `session_id` and an `agent_id`; subagent tool hooks are unobserved (item 9).

## Results of the manual checks

_To be recorded here by the architect after Nico runs docs/manual-checks.md._
