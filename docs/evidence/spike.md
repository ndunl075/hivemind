# Evidence: spike (Wave 0, W0)

Results and verdicts are in [../spike-results.md](../spike-results.md). This file records how they were obtained and what was touched.

## Method

- Throwaway project (a small git repo) and all spike scripts under a scratch folder outside this repository. Nothing from it is committed; only scrubbed fixtures are.
- **Recorder hook:** a 30-line Node script that saves stdin to a file named for the event, appends process metadata (parent pid, executable path, argv, shell variables) and can answer from a `behavior.json` (a canned stdout, exit code, stderr or sleep, optionally a list consumed one entry per call). All output samples came from this.
- **MCP stub:** a stateless Node server, JSON-only responses, 405 for GET, 202 for notifications, logging method, `Accept`, protocol version and masked `Authorization` for every request, with a `status` tool and a `wait` tool that sleeps.
- **Claude Code 2.1.287:** `claude -p ... --setting-sources project --settings <perm file> --mcp-config .mcp.json --strict-mcp-config --model haiku --output-format json`, with `--debug-file` where the hook outcome had to be read. The hooks came from the project's `.claude/settings.json`. `.mcp.json` was created with `claude mcp add-json --scope project`.
- **Codex 0.159.3:** `codex exec -m gpt-5.6-luna -c model_reasoning_effort=low`, with `-s read-only|workspace-write`, `--dangerously-bypass-approvals-and-sandbox` or `--approve-for-me`, `--dangerously-bypass-hook-trust`, and `-c` overrides for `tool_timeout_sec` and `default_tools_approval_mode`. Hooks came from the project's `.codex/hooks.json`, the MCP server from `.codex/config.toml`. Hook outcomes were read from the `hook: <Event> Completed|Failed|Blocked` lines Codex prints and from whether the target file existed afterwards.
- Documentation read for cross-checks: the Codex hooks, MCP and config-reference pages and the Claude Code hooks page (fetched as Markdown).
- Roughly 45 short real sessions in total (about 20 Claude, 25 Codex), all non-interactive (`claude -p`, `codex exec`), so the fixtures reflect those modes and may differ in interactive use. Prompts were tiny.

## Observations behind each verdict

| Item | Observation |
|---|---|
| 1 | Server log: Claude `server/discover` probe, `initialize`, `notifications/initialized`, `GET` (405), `tools/list`, `tools/call`; Codex `initialize`, `notifications/initialized`, `tools/list`, `tools/call`. Tool results reached the model in both. |
| 2 | 44 payload fixtures from both tools; list in spike-results.md. |
| 3 | 34 output samples. Codex strictness shown by two runs of eight-file `apply_patch` sequences where each call received a different canned output; the files that were created show which outputs failed open. |
| 4 | Deny canned for `apply_patch` and `Bash`, run under four Codex modes and four Claude permission modes; the target file never appeared or changed. |
| 5 | A hook with `args` `["...rec.mjs","claude-bs","a b","$HOME","x&y","%PATH%"]` logged those exact argv strings; parent pid was Claude. The same hook with a single-string command logged an expanded `$HOME`. Launched from Git Bash and PowerShell. |
| 6 | A `commandWindows` of `cmd /c echo %CD% > file` produced a UTF-16 file; the plain quoted-path command failed; `& "..." ...; exit $LASTEXITCODE` worked, and exit 2 blocked only with the suffix. |
| 7 | Server saw the static `Authorization` and custom header; `prompt` mode error text; `wait` of 75 s and 130 s completed; `tool_timeout_sec=20` failed a 45 s call. |
| 8 | `claude mcp add-json` output and `.mcp.json`; helper headers present in the server log; allow rule vs none. |
| 9 | SessionEnd sleeps of 0.7, 1.5, 2.0 and 4.5 s (the first two completed, the others were killed); subagent payload session ids compared. |
| 10 | Timing runs listed in spike-results.md; the lookahead matcher fired for `Bash` and not for `Read`/`Glob`/`Grep` in Claude and fired for nothing in Codex. |

## What was touched outside the repository

- **Locks:** `real-agents` taken before every batch of real sessions and released after; `user-config` taken whenever a Codex run could write the user config (see below) and released after each use. The architect removed a stale `real-agents` lock once after a usage-limit interruption; the lock was retaken before continuing.
- **`~/.codex/config.toml`:** `codex exec -s workspace-write` in the untrusted throwaway project appended a `[projects.'<throwaway path>']` entry marking it trusted. The file was backed up first (before any Codex run) and restored from the backup afterwards (three times, once per batch). After each restore the file's checksum matched the pre-spike checksum. `~/.codex/hooks.json` does not exist and was not created.
- **`~/.claude/settings.json`:** checksum identical before and after.
- **`~/.claude.json`:** never edited by the spike (no project entry or MCP server of the spike appears in it). Its checksum differs from the start of the spike because Claude Code rewrites it itself on every run (session statistics); it contains no entry for the throwaway project.
- The Codex runs also started the user's other, unrelated MCP servers as configured; those produced connection errors in the output that are not related to this spike and were ignored.
- No network service other than the two model backends and `127.0.0.1` was used. The scratch folder holds the throwaway project, the stub servers, raw captures (which contain prompts and local paths, so are never committed) and the config backup; it can be deleted.

## Scrubbing

The fixtures are produced by a script that replaces session, turn, prompt, tool-use and agent ids, transcript and scratch paths with placeholders, maps the throwaway project's path to `C:\proj`, and replaces prompt text, file contents and command output with short placeholders while keeping keys, their order and the shape of tool responses (for example the `Exit code: 0 ... Output:` string of `apply_patch`, and `{content:[...]}` MCP results).

The first version of the script only scrubbed values under known keys. A review found a real agent/thread UUID left in `tool_input.targets` of the Codex wait tool's payloads. The script now also replaces **any UUID found in any string** with `<agent-id>`, and it refuses to write a file when its output still contains a UUID-like string, the user name, the home path, repository folder names, e-mail-like strings or an unexpected drive-letter path. After the rebuild, a search of `shared/fixtures/hooks` and the three documents for UUIDs, the user name and those terms found nothing. The words `hello`, `world` and `x` that remain in `Grep` patterns, and patch text come from the test prompts and are synthetic.

## Not done / limits

- macOS and Linux (manual-checks.md M7); the desktop apps and IDE extensions (M2, M3); interactive-only events (M1, M4, M5, M6).
- The `Edit` and `Write` matcher aliases for Codex `apply_patch` were not isolated (the `apply_patch` name matched).
- `http_headers_helper` in Codex was rejected by 0.159.3 (`invalid transport`); not investigated further.
- Whether `"async": true` removes the Codex PowerShell cost from the critical path was not tested.
