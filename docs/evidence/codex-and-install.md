# Evidence: codex-and-install (Wave 3, W6)

The Codex adapter (`cli/hook/codex.mjs`) and every CLI command of ARCHITECTURE.md §17 (`cli/hivemind.mjs`, `cli/commands/`). Plain ESM JavaScript with JSDoc types, checked by `tsc`; the CLI's one runtime dependency is `smol-toml`. All tests use temporary home and project folders and a stubbed `claude`/`codex` runner; nothing touched a real `~/.claude`, `~/.claude.json`, `~/.codex` or `~/.hivemind`, and no real `claude` or `codex` session was started.

## Files

| File | What it is |
|---|---|
| `cli/hook/codex.mjs` | `parse` (apply_patch paths, `source` passthrough) and `format` (fixed field list per event). Keeps the `shared/hook-modules.ts` interface. |
| `cli/hivemind.mjs` | Entry and dispatch. `main(argv, ctx)` is exported for tests. |
| `cli/commands/context.mjs` | `createContext` (every outside dependency in one object: output, input, runner, fetch, home folders, node path), `paths`, `CliError`, the default runner. |
| `cli/commands/admin.mjs` | `room create/delete`, `invite`, `revoke`, `rotate`. |
| `cli/commands/join.mjs`, `install.mjs` | `join`, `update`, `leave`, and the shared install/uninstall logic with its install record. |
| `cli/commands/hooks-merge.mjs`, `registrations.mjs`, `codex-config.mjs`, `markers.mjs` | The config editors and the exact registration contents. |
| `cli/commands/project.mjs`, `room-control.mjs`, `doctor.mjs` | `init`/`off`/`on`; `mode`/`unlock`; `doctor` and the self-test prompt. |
| `cli/commands/headers-helper.mjs` | Claude's `headersHelper` script; copied next to the hook files. |
| `cli/commands/{api,args,files,secrets}.mjs` | Server calls, argument parsing, atomic file writes, hidden input. |
| `cli/commands/testkit.mjs` | Test harness (fake laptop, stub runner, fake server on 8790). Not a test file. |
| `*.test.mjs` | `cli/commands/commands.test.mjs`, `cli/commands/merge.test.mjs`, `cli/hook/codex.test.mjs`. |

## Codex adapter

- **Paths.** `apply_patch` `tool_input.command` is scanned for `*** Add File:`, `*** Update File:`, `*** Delete File:` and `*** Move to:` lines, so a move reports both source and target. Paths are returned as written (absolute Windows or POSIX, or relative); `git.normalize` in the hook resolves them against `cwd`. CRLF, repeated files, spaces in names, and `+*** Add File:` content lines are handled. `Edit`/`Write` aliases with `file_path` are read too (the registered matcher includes them).
- **`source`** is passed through on `SessionStart` exactly as `claude.mjs` does; a test proves `hook.mjs codex` keeps the baseline on resume.
- **Output** is built from a fixed list of fields per event, in the order the accepted samples use. `codex.test.mjs` classifies every file in `shared/fixtures/hooks/codex/output/` (a new fixture fails the test until classified): the seven accepted shapes Hivemind emits are reproduced byte for byte; the thirteen others (legacy block, `systemMessage`, `continue:false`, unknown fields, exit codes, invalid JSON, plain text, timeout) are asserted never to be produced; and a sweep over every event/decision/reason/context combination asserts that only whitelisted keys ever appear.
- **End to end:** `hook.mjs codex` runs as a child process against a fake server for the `SessionStart` briefing, an `apply_patch` deny (all five patched paths arrive repo-relative from absolute ones), deny with context, `Stop` block, and all 19 Codex input fixtures (exit 0, empty stderr).

## What `join` writes

| Where | What |
|---|---|
| `$HIVEMIND_HOME/config.json` | `{ server, room, person, token, repos }`, mode 600 (folder 700) where the OS has modes. The same room adds this repo's root commit; another room replaces the mapping. |
| `$HIVEMIND_HOME/hook/` | `hook.mjs claude.mjs codex.mjs git.mjs limits.mjs` and `headers-helper.mjs` only (no tests), written only when content differs. |
| `$HIVEMIND_HOME/install.json` | What join added (no secrets), so `leave` removes exactly that. |
| `~/.claude/settings.json` | Six hooks (matchers and timeouts as in §6.2; `command` = absolute node, `args` = `[hook.mjs, "claude"]`) and `permissions.allow: ["mcp__hivemind"]`. |
| `~/.claude.json` | `claude mcp add-json --scope user hivemind '<json>'` with `type` http, `url` `<server>/mcp` and a `headersHelper` command. The JSON has no token; the helper prints the `Authorization` header from `../config.json`. On Windows the command is one word, the wrapper `hook/headers-helper.cmd` (it holds the node path), written with forward slashes and each space as `" "`; that exact string was run under `powershell.exe`, `cmd.exe` and Git Bash (see Tests). Elsewhere it is `"<node>" "<headers-helper.mjs>"` for `sh`. |
| `~/.codex/hooks.json` | Six hooks. `PreToolUse` matcher `apply_patch\|Edit\|Write\|mcp__hivemind__.*`, `PostToolUse` matcher `Bash\|apply_patch`. `command` is `"<node>" "<hook.mjs>" codex`; `commandWindows` is `& "<node>" "<hook.mjs>" codex; exit $LASTEXITCODE`; `timeout` 5, and 3 for `SessionEnd`. |
| `~/.codex/config.toml` | A marker-delimited block with `[mcp_servers.hivemind]`: `url`, `http_headers = { Authorization = "Bearer <token>" }`, `default_tools_approval_mode = "approve"`, `tool_timeout_sec = 60`. Inserted before the file's first table header (after the root keys); a file with no tables gets it at the end. Always mode 600 on POSIX, even if the file was 0644 before. |

`CLAUDE_CONFIG_DIR` and `CODEX_HOME` are honoured if set. Quoting is tested with a node path containing spaces, `$` and `"`; a path with a line break is refused.

**Not clobbering.** Hook merging replaces only handlers whose command names exactly `$HIVEMIND_HOME/hook/hook.mjs` as a whole word (another folder's hivemind hook, or `hook.mjs.bak`, is not ours), in place, so other handlers (even in the same group), events, matchers, permissions, `env` and unknown keys survive. On `update`, a Hivemind handler left in an event the registrations no longer use is removed; the user's handlers there stay. A settings or hooks file that is not valid JSON, or has an unexpected shape, is left untouched with an error naming the file and the line and column (never the parser's quote of the file), and the other app is still registered. The TOML block is placed by text insertion, never a parse and stringify round trip (that would drop the user's comments). `smol-toml` checks after every change that the file reads as before plus our table, trying each header-looking line in turn (a `[x]` inside a multi-line string or array is rejected by that check). Removal deletes only the lines between the markers, after checking they parse as exactly our table (no extra key, no other table), plus the one blank line it added; if text after the end marker would change meaning (a key appended there belongs to our table as far as TOML goes) it refuses and says why. A hand-written `[mcp_servers.hivemind]` outside the markers is refused, with no write to either Codex file. A Claude MCP server named `hivemind` is replaced only when it is recognisably ours (its output names this install's exact `headers-helper.mjs` or `.cmd` path, or the install record says join added it); `leave` removes it only when it names this install's exact helper path, whatever the record says. Otherwise `join` and `update` refuse with a message and `leave` leaves it alone. Files that are rewritten keep their mode and a symlinked dotfile is written through the link (the link survives join, update and leave).

**Idempotent.** Every write compares content first. A second `join` leaves the same bytes and the same mtimes everywhere under the fake home (file-by-file snapshot plus mtimes) and makes no `add-json`/`remove` call (it asks `claude mcp get hivemind` and skips when URL and helper match).

**`leave`** removes what the install record says join added: our hooks (pruning only groups, events and keys it emptied), the allow rule only if join added it, the MCP server, the TOML block, settings/hooks/config files that join created and that are now empty, and our files in `$HIVEMIND_HOME` (other files there stay). The test seeds rich existing config, runs join then leave, and gets the original JSON deep-equal and the original TOML byte-identical. Project files are never touched. If any registration cannot be removed (a settings file that is not valid JSON, an edited TOML block, a failed `claude mcp remove`), `leave` removes the others, keeps `$HIVEMIND_HOME` whole (hook files, `config.json`, the install record), names what to fix and exits 1; after the fix, running `leave` again finishes the job.

## Secrets

- **Agent token:** hidden raw-mode prompt in a terminal, or one piped line with `join --token-stdin`; never an argument (`--token` is an unknown option) and no longer an environment variable (`HIVEMIND_AGENT_TOKEN` is ignored). **Admin secret:** `HIVEMIND_ADMIN_TOKEN`, the hidden prompt, or `--token-stdin`; never an argument. Without a terminal and without `--token-stdin` a secret is refused with a message saying so; end of input or a closed stream in raw mode is an error and restores the terminal. Prompts go to stderr.
- **Child processes:** `claude` and `codex` are started with `HIVEMIND_*TOKEN`/`*SECRET` variables and any variable whose value is a Hivemind token removed (`scrubEnv`, applied to every runner call). The Windows `cmd.exe` fallback for `.cmd` shims refuses an argument containing `% ^ & | < >`.
- The token travels only in an `Authorization` header, to an `https://` server (or `http://` for localhost). Error messages never contain it (tested with a rejected token and a wrong admin secret).
- **Tests prove:** across a full join (with seeded config) no recorded runner argv contains the token; stdout and stderr do not; the only files under the fake home that contain it are `.hivemind/config.json` and `.codex/config.toml` (not `settings.json`, not `.claude.json`); and `update`, `doctor`, `mode`, `unlock`, `init`, `off`, `on`, `leave` print nothing secret. `room create`, `invite` and `rotate --viewer` each print their token or link exactly once on stdout, nothing on stderr, and never the admin secret; `rotate --agents` prints no token. The helper script was executed and prints the header from `config.json`.

## Other commands

- `room create` prints `<server>/r/<room>#v=<viewer token>` (the dashboard reads the token from the fragment). `room delete` needs `--yes`, or the room name typed in a terminal.
- `init` writes `.hivemind/project.json` with the §9 defaults only if absent, and the protocol text from `shared/protocol.md` between `<!-- hivemind:start -->` and `<!-- hivemind:end -->` in `AGENTS.md` and `CLAUDE.md` (appended, or replaced in place; a lone marker is an error).
- `doctor` checks Node, config.json (and its permissions), `/whoami`, the repo mapping, hook files, the recorded node path, all six hooks in each app with valid paths (Codex also needs `commandWindows` with the exit-code suffix), the allow rule, the Claude MCP entry (present, ours, right URL), `config.toml`, whether the Codex node and hook script paths exist, and the age of the last `hook.log` line, then prints the self-test prompt. Exit 1 on any failure.
- `mode` and `unlock` use the agent token from config.json; `unlock <path>` sends the repo id (root commit) and the repo-relative POSIX path. `off`/`on` create/delete `$HIVEMIND_HOME/off`, the file the hook checks.

## Tests

`npm run test:cli`, `npm run test:hook` (including `codex.test.mjs`), `npm run typecheck` and the root `vitest run` pass locally on Windows. The tests that need POSIX file modes or symlinks (config.toml 0600 over an existing 0644 file, mode preservation, the symlinked-dotfile round trip) skip on this machine and are written to run on the Linux CI job; they were reviewed but not executed here. Review fixes added:

- **headersHelper.** The exact string from `~/.claude.json` is executed under `powershell.exe`, `cmd.exe` and Git Bash (Windows) or `sh` (POSIX), for a plain folder, a folder with a space and (POSIX) one with `$`, backticks and quotes, and prints the header. The by-hand `claude mcp add-json` commands (PowerShell, Command Prompt, sh) are run through the real shells with a stand-in program and arrive as exactly the JSON.
- **Secret input** with fake streams: non-TTY refusal, `--token-stdin`, backspace and no echo, end/close/Ctrl-D/Ctrl-C in raw mode with the raw mode restored.
- **Environment** of every `claude`/`codex` call during join, update, doctor and leave; **leave** with a malformed settings file, a failed `mcp remove`, and an edited TOML block, then a second `leave` that finishes; a user's own `hivemind` MCP server through join, update, doctor and leave; TOML placement, round trip, multi-line strings and arrays, edited-block refusal, CRLF; indented `apply_patch` headers; stale-event cleanup; exact hook-path matching; JSON and TOML errors that name a line and never quote the file; doctor on a foreign MCP entry and on missing Codex paths.

`commands.test.mjs` is the only file that binds the fake server port 8790. `codex.test.mjs` uses an ephemeral port, because it runs in parallel with the CLI tests (same approach as `hook.test.mjs`).

Covered: join (everything above, plus a second repo, rejected token, bad token shape, not a repo, remote `http://`, app not installed, `claude` missing, broken JSON, hand-written TOML table, odd paths, and the installed hook folder running on its own and printing the exact recorded Codex and Claude `SessionStart` output); admin commands; mode and unlock; init idempotence; update (restores a deleted file, moves to a new node path without duplicating hooks, leave still cleans up); doctor (passes after join; flags a missing hook file, a bad path, a missing MCP entry, an unmapped repo, a rejected token, a paused laptop); the executable's help and exit codes. `merge.test.mjs` covers the editors in isolation.

## Not verified / notes

- **Nothing was run against a real `claude` or `codex`.** The real output of `claude mcp get` is unknown. Ownership of an existing `hivemind` entry is decided by the helper path in that output, or by the install record when the output does not show it; if it does not echo the helper command, `join` removes and re-adds our own entry each time (same result, just not a no-op).
- **Which shell Claude uses for `headersHelper`** is not known, so the command is one word that was verified under PowerShell, cmd and Git Bash (manual check M2 still has to confirm Claude runs it). A Hivemind folder whose path has characters outside letters, digits, spaces and `. _ - / : , + = @ ~` is refused for the Claude MCP step with a message to set `HIVEMIND_HOME` to a simpler folder.
- **Windows `.cmd` shims:** the runner spawns without a shell and retries through the shell with quoted arguments only when the program is not found. Untested against a real npm shim.
- **Hook home folder.** Fixed on main by PR #16 (the hook finds its home from its own install folder); merged into this branch.
- Codex hooks still need one-time approval with `/hooks` after `join` and `update`; both say so.
- The tests ran while the machine's system drive was full (unrelated cause). Temp folders and the npm cache were pointed at another drive, and this worktree's `node_modules` was moved there and linked back with a junction. Nothing of that is committed. Remove the junction first when deleting the worktree (parallel-sessions.md §4).

## Requests for the architect

1. Manual check M2 should also cover: the output of `claude mcp get hivemind` after `join` (does it echo `headersHelper`?), and that Claude runs the helper command exactly as `join` writes it on Windows and macOS.
