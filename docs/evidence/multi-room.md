# Evidence: one laptop in several rooms

## What was built

- **config.json** (`cli/commands/rooms.mjs`, `install.mjs`): a `rooms` list, one entry per room (`server`, `room`, `person`, `token`, `repos`, `mcp`). The first room's `server`, `room`, `person`, `token` and `repos` are also written at the top level. A file with no `rooms` list is the old format and reads as one room; it is rewritten in the new shape the next time `join` or `update` writes it. Still written with mode 0600 in a 0700 folder.
- **Hook** (`cli/hook/hook.mjs`): reads all rooms and, once it knows the checkout's root commit, picks the first room whose `repos` include it. No match: exit 0, no output, no network, as before. A broken entry is skipped without losing the others. Every token is redacted from `hook.log`. `claude.mjs` / `codex.mjs` treat `mcp__hivemind__*` and `mcp__hivemind-<room>__*` as Hivemind tools (the `me` check). The hook matchers became `mcp__hivemind.*`.
- **MCP registration, one server per room.** Hook events carry the working directory, so the hook can choose by repo. The Claude `headersHelper` cannot: Claude Code runs it as a shell command for the server, and nothing in the repo's docs or spike results says it is given the project or even runs in the project's directory (spike item 8 and manual check M2 only confirm the user-scope helper runs). So the helper cannot be trusted to pick a room by repo. Instead each room gets its own server: the first room is `hivemind` (a one-room laptop is byte-for-byte what it was, tools stay `mcp__hivemind__<tool>`), later rooms are `hivemind-<room>` (`-2`, `-3` if that name is taken). The name is stored in the room entry and does not change when other rooms leave. Each server's `headersHelper` is passed its own name as an argument (the plain `hivemind` has none, so existing registrations are unchanged and `update` does not rewrite them); the helper prints that entry's token. The Windows wrapper forwards `%*`. Permission rules: `mcp__hivemind` and `mcp__hivemind-<room>` per room. Codex: one marker-delimited block per room in `config.toml` (`# hivemind:start <name> ...`); the first room's block text is unchanged.
- **Commands.** `join` adds or refreshes the current project's room and never touches the other entries; a repo already in another room moves (a room left empty is dropped, with its registrations). `leave` in a project removes that project's mapping (and the room once no repo uses it); `--room <name>` drops a whole room; `--all` everything; with one room it works from any folder as before. `update` refreshes all rooms and reconciles registrations (removes servers, rules and Codex blocks of rooms that are gone). `doctor` lists every room and checks the server token, Claude server and rule, and Codex block for each. `mode` and `unlock` use the room of the project they run in.
- **Manifest** (`install.json`): new `claude.mcpServers` and `claude.allowRules` lists; an older manifest (`mcp: true`, `allowAdded`) is read as `["hivemind"]` / `["mcp__hivemind"]`.

## Version skew

- Updated hook, old config: reads as one room (test `the old single-room format still works`).
- Old installed hook copy, new config: it reads `server`/`token`/`repos` at the top level, which are the first room, so it keeps working for that room only until `hivemind update` copies the new hook. An old CLI that rewrites the file would drop the extra rooms (it only knows the top-level fields); there is no way to prevent that from this side.
- Old installed helper, new config: prints the top-level (first room) token for any server; correct for `hivemind`, wrong for the others until `update`.
- New helper, old config: no argument or `hivemind` gives the one room; any other name fails with the usual message.
- Old Claude registration (`hivemind`, no argument) is exactly what the new CLI writes for the first room, so `update` makes no `claude mcp` change (tested).

## Tests

`npm run typecheck` and `npm test` pass (root 394 tests including the new ones, workers 218, dashboard 113).

- `cli/hook/hook.rooms.test.mjs` (real hook process, fake servers): room picked by repo with its own token, two rooms/two repos, no match, first match wins, broken entries skipped, `me` check for a `hivemind-<room>` tool, old format, new format, unusable files.
- `cli/commands/rooms.test.mjs`: format reading/writing and naming; Codex blocks (two side by side in either order, remove one, refresh is a no-op, CRLF, no-table file, user table of the same name); join adds a second room without touching the first (config entry, Claude entry, Codex block, allow rules, 0600); same room from a second repo; rejoin changes nothing; moving a repo; names stay stable; refusal to overwrite a user's own server; leave (current project, last room, shared room, `--room`, `--all`, unmapped project, single room from anywhere); update repair; doctor with two rooms and a broken one; `mode` per project; the installed helper run as a child process (per name, no argument, old config) and the command string from `~/.claude.json` run through a shell; manifest from before this change.
- Existing `commands.test.mjs` / `merge.test.mjs` updated for: the new config shape, the `mcp__hivemind.*` matcher, the wrapper's `%*`, doctor's per-room wording. A test that hand-edits the config now deletes `rooms` first, which also exercises the old format through `doctor`.

## Not done / notes

- `claude.test.mjs` and `codex.test.mjs` (hook adapters) still assert `startsWith('mcp__hivemind__')` against the recorded fixtures; they pass because no fixture uses a named server. The named-server case is covered in `hook.rooms.test.mjs`.
- ARCHITECTURE.md §6.2 still shows the matcher as `mcp__hivemind__.*` (outside the sections this task owns); it is now `mcp__hivemind.*`. Listed under requests for the architect.
- A Claude session sees every room's tools (the servers are user scope). An agent has to use the server for its own repo's room; the `me` check and the server reject a mismatch, but the protocol text (§6.5) does not say which server to use. The self-test prompt in `doctor` still says "the hivemind tool `status`".
- Not run against a real `claude` or `codex` (the stub runner stands in, as in the existing tests); whether Claude Code gives a `headersHelper` the project directory is therefore still unverified, which is why the design does not rely on it.
