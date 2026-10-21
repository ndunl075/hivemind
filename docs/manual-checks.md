# Manual checks (Nico, about an hour)

Step-by-step instructions for every §21 item (or part of one) that needs a person: interactive sessions, the desktop apps and IDE extensions, and a Mac. Hand the results to the architect, who records them in [spike-results.md](spike-results.md). Background on what the spike already found is in that file.

Rules for this session:

- Everything lives in a **throwaway folder** (`~/hm-spike` below). Hooks and MCP servers are registered **only in that project's own config**. The one exception is M2, which deliberately uses user scope and must be undone at the end.
- Don't run these while a worker is using the `real-agents` lock (see `docs/parallel-sessions.md` §5).
- Nothing here is committed. Delete `~/hm-spike` when finished.
- The recorder writes prompts and file contents to disk. Don't paste its output files anywhere public; write down only the answers the checks ask for.

## 0. One-time setup

### 0.1 Throwaway project

Windows PowerShell:

```powershell
mkdir $HOME\hm-spike\proj; cd $HOME\hm-spike\proj; git init
"hello" | Set-Content a.txt; git add -A; git -c user.name=x -c user.email=x@x commit -m init
```

macOS or Linux:

```sh
mkdir -p ~/hm-spike/proj && cd ~/hm-spike/proj && git init
echo hello > a.txt && git add -A && git -c user.name=x -c user.email=x@x commit -m init
```

Find the absolute path of Node (`where.exe node` on Windows, `which node` on a Mac) and call it `NODE` below. Call `~/hm-spike` expanded to an absolute path `SPIKE`.

### 0.2 The recorder script

Save as `SPIKE/rec.mjs`. It saves every hook payload and a small metadata record, and optionally answers with a canned output read from `SPIKE/behavior.json` (an empty `{}` means "say nothing").

```js
// rec.mjs - usage: node rec.mjs <label>
// Saves stdin to SPIKE/captures/<label>/<time>-<event>[.<tool>][.<source|reason>].json
// and appends one line to SPIKE/meta.jsonl. Replies from SPIKE/behavior.json:
//   { "<label>:<event>[.<tool>]": { "stdout": <string|object>, "exit": 0, "stderr": "", "sleepMs": 0 } }
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const label = process.argv[2] || 'x';
const t0 = Date.now();
let raw = '';
try { raw = fs.readFileSync(0, 'utf8'); } catch (e) { raw = 'STDIN_ERROR ' + e.message; }
let ev = {};
try { ev = JSON.parse(raw); } catch {}
const name = ev.hook_event_name || 'unknown';
const tn = ev.tool_name ? '.' + ev.tool_name : '';
const extra = ev.source ? '.' + ev.source : ev.reason ? '.' + ev.reason : '';
const dir = path.join(here, 'captures', label);
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, `${Date.now()}-${process.pid}-${name}${tn}${extra}.json`), raw);
let beh = {};
try { beh = JSON.parse(fs.readFileSync(path.join(here, 'behavior.json'), 'utf8')); } catch {}
const b = beh[`${label}:${name}${tn}`] || beh[`${label}:${name}`] || {};
if (b.sleepMs) await new Promise((r) => setTimeout(r, b.sleepMs));
fs.appendFileSync(path.join(here, 'meta.jsonl'), JSON.stringify({
  label, name, tn, extra, session_id: ev.session_id, agent_id: ev.agent_id, ppid: process.ppid,
  node: process.execPath, argv: process.argv.slice(2), cwd: process.cwd(),
  platform: process.platform, shell: process.env.SHELL || process.env.ComSpec, ms: Date.now() - t0,
}) + '\n');
if (b.stderr) process.stderr.write(b.stderr);
if (b.stdout !== undefined) process.stdout.write(typeof b.stdout === 'string' ? b.stdout : JSON.stringify(b.stdout));
process.exit(b.exit ?? 0);
```

Also create `SPIKE/behavior.json` containing `{}`.

To see what happened after any run: `ls SPIKE/captures/*` and read the last lines of `SPIKE/meta.jsonl` (each line has `session_id`, `agent_id`, the parent process id and the shell).

### 0.3 Claude Code project config

Save as `proj/.claude/settings.json`. Replace `NODE` and `SPIKE` with absolute paths (forward slashes work on Windows too).

```json
{
  "hooks": {
    "SessionStart":     [{ "hooks": [{ "type": "command", "command": "NODE", "args": ["SPIKE/rec.mjs", "claude"], "timeout": 5 }] }],
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "NODE", "args": ["SPIKE/rec.mjs", "claude"], "timeout": 5 }] }],
    "PreToolUse":       [{ "matcher": ".*", "hooks": [{ "type": "command", "command": "NODE", "args": ["SPIKE/rec.mjs", "claude"], "timeout": 5 }] }],
    "PostToolUse":      [{ "matcher": ".*", "hooks": [{ "type": "command", "command": "NODE", "args": ["SPIKE/rec.mjs", "claude"], "timeout": 5 }] }],
    "Stop":             [{ "hooks": [{ "type": "command", "command": "NODE", "args": ["SPIKE/rec.mjs", "claude"], "timeout": 5 }] }],
    "SessionEnd":       [{ "hooks": [{ "type": "command", "command": "NODE", "args": ["SPIKE/rec.mjs", "claude"], "timeout": 3 }] }]
  }
}
```

The first time you open Claude Code in `proj`, accept the workspace trust dialog. (Project hooks run even without trust; project permissions and `headersHelper` do not.)

### 0.4 Codex project config

Save as `proj/.codex/hooks.json`.

macOS or Linux (`command` only):

```json
{
  "hooks": {
    "SessionStart":     [{ "hooks": [{ "type": "command", "command": "\"NODE\" \"SPIKE/rec.mjs\" codex", "timeout": 5 }] }],
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "\"NODE\" \"SPIKE/rec.mjs\" codex", "timeout": 5 }] }],
    "PreToolUse":       [{ "matcher": ".*", "hooks": [{ "type": "command", "command": "\"NODE\" \"SPIKE/rec.mjs\" codex", "timeout": 5 }] }],
    "PostToolUse":      [{ "matcher": ".*", "hooks": [{ "type": "command", "command": "\"NODE\" \"SPIKE/rec.mjs\" codex", "timeout": 5 }] }],
    "Stop":             [{ "hooks": [{ "type": "command", "command": "\"NODE\" \"SPIKE/rec.mjs\" codex", "timeout": 5 }] }],
    "SessionEnd":       [{ "hooks": [{ "type": "command", "command": "\"NODE\" \"SPIKE/rec.mjs\" codex", "timeout": 3 }] }],
    "SubagentStart":    [{ "hooks": [{ "type": "command", "command": "\"NODE\" \"SPIKE/rec.mjs\" codex", "timeout": 5 }] }],
    "SubagentStop":     [{ "hooks": [{ "type": "command", "command": "\"NODE\" \"SPIKE/rec.mjs\" codex", "timeout": 5 }] }]
  }
}
```

Windows: use the same file, but give every handler a `commandWindows` as well, in exactly this form (the call operator is required because Codex runs it in PowerShell):

```json
"command": "unused", "commandWindows": "& \"C:\\Program Files\\nodejs\\node.exe\" \"C:\\Users\\<you>\\hm-spike\\rec.mjs\" codex; exit $LASTEXITCODE"
```

Save a second file `proj/.codex/config.toml` only if a check below says so. Start Codex once in `proj` and approve the hooks with `/hooks` (it will also ask to trust the folder). **Approving the folder writes a `[projects.'...']` entry to `~/.codex/config.toml`.** Note it, and remove that entry at the end (take the `user-config` lock first and back the file up; see parallel-sessions.md §5).

## M1. Interactive hook events (§21 item 2)

Record the payloads of the events `-p` / `exec` cannot produce. Use the interactive TUI in `proj`.

Claude Code (`claude` in `proj`):

1. Start `claude`, type `hi`, then `/clear`. Expected files: `SessionEnd.clear` for the old session and a new `SessionStart.clear`.
2. Type a few short messages, then `/compact`. Expected: `SessionStart.compact` (and any pre-compact events, which are not in §6.2).
3. Quit with `/exit`. Expected: `SessionEnd.prompt_input_exit`.
4. Run `claude --resume` and pick the session you just left. Expected: `SessionStart.resume` and, when you leave, a `SessionEnd` with the reason shown. Then, inside a running session, type `/resume` and pick a different session: expected `SessionEnd.resume` for the one you left and `SessionStart.resume` for the new one. (Do not run `/logout`; that would sign you out.)

Codex (`codex` in `proj`):

5. Start `codex`, type `hi`, then `/new` or `/clear` (whichever exists). Expected: a `SessionStart` with source `clear`.
6. After several messages, run `/compact`. Expected: a `SessionStart` with source `compact`.
7. Run `/fork` (or `codex fork`). Expected: a `SessionStart` with source `fork`.
8. Exit normally (Ctrl+C twice or `/quit`). Expected: `SessionEnd.other`.

Record: for each step, the file names that appeared and whether the `session_id` inside changed (`jq .session_id` or just open the file). Copy no file contents; just report the names and whether the id changed. If an event never appears, say so: the architect then notes the degradation in §15.

## M2. Claude Code desktop app and IDE extension (§21 item 11, and the user-scope half of item 8)

Goal: hooks fire and can deny in the desktop app and in the IDE extension, and the user-scope `headersHelper` MCP server works there.

Part A: hooks in `proj` (project config from 0.3 is enough).

1. Open `proj` in the **Claude Code desktop app**. Ask: "Read a.txt, then change hello to world in a.txt."
2. Check `SPIKE/captures/claude` has `UserPromptSubmit`, `PreToolUse.Read`, `PreToolUse.Edit`, `PostToolUse.*`, `Stop`. Record yes/no per event.
3. Put this in `SPIKE/behavior.json` and repeat step 1 with `a.txt` reset to `hello`:

   ```json
   { "claude:PreToolUse.Edit": { "stdout": { "hookSpecificOutput": { "hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": "locked by someone else" } } } }
   ```

   Expected: the edit is refused and the model quotes the reason; `a.txt` still says `hello`. Record yes/no.
4. Repeat steps 1 to 3 in the **IDE extension** (VS Code and/or JetBrains, whichever you use) with `proj` open. Reset `behavior.json` to `{}` afterwards.

Part B: user-scope `headersHelper` server. This **writes to `~/.claude.json`** (through `claude mcp add-json`) and to `~/.claude/settings.json`. Take the `user-config` lock first and copy `~/.claude/settings.json` to `~/.claude/settings.json.spike-backup`. Do not hand-edit or restore `~/.claude.json`; Claude Code rewrites that file constantly, so undo the server with `claude mcp remove` instead (step 10).

5. Save `SPIKE/mcp.mjs` (a stateless JSON-only MCP server; it needs no packages):

   ```js
   import http from 'node:http';
   import fs from 'node:fs';
   const port = Number(process.argv[2] || 8791);
   const log = (o) => fs.appendFileSync(new URL('./mcp-requests.jsonl', import.meta.url), JSON.stringify(o) + '\n');
   const tools = [{ name: 'status', description: 'Show room status. Pass me.', inputSchema: { type: 'object', properties: { me: { type: 'string' } }, required: ['me'] } }];
   http.createServer((req, res) => {
     let body = '';
     req.on('data', (c) => (body += c));
     req.on('end', () => {
       let msg = null; try { msg = JSON.parse(body); } catch {}
       log({ method: req.method, auth: req.headers.authorization ? 'present' : null, xspike: req.headers['x-spike'], rpc: msg && msg.method });
       if (req.method !== 'POST') { res.writeHead(405); return res.end(); }
       if (msg.id === undefined) { res.writeHead(202); return res.end(); }
       const reply = (result) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result })); };
       if (msg.method === 'initialize') return reply({ protocolVersion: msg.params?.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'hivemind', version: '0' } });
       if (msg.method === 'tools/list') return reply({ tools });
       if (msg.method === 'tools/call') return reply({ content: [{ type: 'text', text: 'status ok me=' + msg.params.arguments?.me }] });
       res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'no' } }));
     });
   }).listen(port, '127.0.0.1');
   ```

   Save `SPIKE/headers.mjs`: `process.stdout.write(JSON.stringify({ Authorization: 'Bearer hm_a.test.nobody.1.AAAA', 'X-Spike': 'helper' }));`

   Paths: on Windows `NODE` is something like `C:/Program Files/nodejs/node.exe` and `SPIKE` like `C:/Users/<you>/hm-spike`; on a Mac `NODE` is the output of `which node` (for example `/opt/homebrew/bin/node` or an nvm path) and `SPIKE` is `/Users/<you>/hm-spike`. Use the **absolute** `NODE` path in the helper so the GUI apps do not depend on `PATH`, and quote both paths because the helper is a shell command line.

6. Start the server in a terminal: `node SPIKE/mcp.mjs`.
7. Register it at user scope (Windows example; on a Mac use the Mac paths):

   ```sh
   claude mcp add-json --scope user hivemind '{"type":"http","url":"http://127.0.0.1:8791/mcp","headersHelper":"\"NODE\" \"SPIKE/headers.mjs\""}'
   ```

   and add `"permissions": { "allow": ["mcp__hivemind"] }` to `~/.claude/settings.json` (merge into any existing `permissions.allow`).
8. In the desktop app, in `proj`, ask: "Call the hivemind status tool with me=claude-test." Expected: it runs with no permission prompt, and `mcp-requests.jsonl` shows `auth: "present"` and `xspike: "helper"`. Record yes/no for: tool listed, no prompt, headers present.
9. Repeat in the IDE extension.
10. **Undo:** `claude mcp remove --scope user hivemind` (check with `claude mcp list` that it is gone), restore `~/.claude/settings.json` from the backup, then release the lock.

## M3. Codex desktop app and IDE extension, and what Codex hashes for hook trust (§21 item 12)

1. Open `proj` in the **Codex desktop app**. Ask: "Create file p.txt containing x using apply_patch, then run `echo hi`." Check `SPIKE/captures/codex` for `SessionStart`, `UserPromptSubmit`, `PreToolUse.apply_patch`, `PreToolUse.Bash`, `PostToolUse.*`, `Stop`. Record yes/no per event. (The hooks must already be approved in the CLI via `/hooks`; if the app says hooks need review, note where it lets you approve.)
2. Put this in `SPIKE/behavior.json`, delete `p.txt`, and repeat:

   ```json
   { "codex:PreToolUse.apply_patch": { "stdout": { "hookSpecificOutput": { "hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": "locked by someone else" } } } }
   ```

   Expected: the patch is refused and `p.txt` is not created. Record yes/no. For a shell command use this instead (then ask it to run `echo hi > q.txt`; `q.txt` must not appear):

   ```json
   { "codex:PreToolUse.Bash": { "stdout": { "hookSpecificOutput": { "hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": "locked by someone else" } } } }
   ```

   Reset `behavior.json` to `{}` afterwards.
3. Repeat in the **Codex IDE extension**.
4. **What is hashed for hook trust.** In the CLI, open `/hooks` and confirm the hooks show as trusted. Then change one thing at a time in `proj/.codex/hooks.json`, restart `codex`, and note whether `/hooks` asks for re-review each time:
   a. change only `"timeout"` (5 to 6);
   b. change only the `matcher` of `PreToolUse` (`.*` to `.+`);
   c. add `"statusMessage": "x"`;
   d. change the command string (add a trailing space-and-argument);
   e. change a **different** file the command points to (append a comment line to `rec.mjs`).
   Record which of a to e triggered a re-review. (The architect needs to know whether a changed `hook.mjs` on disk, with an unchanged registration, forces re-approval.) Restore the original file afterwards.
5. **User-level hooks in an untrusted project (not tested by the spike).** `join` writes `~/.codex/hooks.json`, not a project file. Take the `user-config` lock and back up `~/.codex/hooks.json` (it may not exist) and `~/.codex/config.toml`. Remove the project `proj/.codex/hooks.json`, put the same hooks in `~/.codex/hooks.json`, and create a second, never-opened folder `proj2` (`git init`). Run `codex` in `proj2`, send `hi`, and record: did a warning say hooks need review, did hooks run before you approved them with `/hooks`, did they run after approving, and did Codex ask to trust the folder. Then restore both files exactly (delete `~/.codex/hooks.json` if it did not exist), remove any `[projects...]` entry the run added to `config.toml`, and release the lock.

## M4. Session ids across resume, clear, compaction and subagents (§21 items 15 and 9)

Claude Code:

1. In `proj`, start `claude`, send `hi`, and note the `session_id` of the `SessionStart` file.
2. `/clear`: does the next `SessionStart` have a new `session_id`? Record old and new first characters only.
3. `/compact`: same session id or new? Record.
4. Exit, then `claude --resume` and choose that session: same id or a new one? Record. Also try `claude --continue`.
5. Subagents: ask "Use the Task/Agent tool to spawn a subagent that reads a.txt." Look at the files the subagent's own tool calls produced (look at `PreToolUse.Read` files with a later timestamp). Do they have the **same** `session_id` as the parent? Is there an `agent_id`, `agent_type` or similar field? Record yes/no and the field names.

Codex:

6. `codex` in `proj`, send `hi`, note `session_id`. Repeat the `/clear` (or `/new`), `/compact` and resume (`codex resume --last`) steps above and record whether the id changes.
7. Subagent tool calls: ask "Spawn a subagent that runs `echo hi` in a shell and wait for it." The spike already found that `UserPromptSubmit`, `SubagentStart` and `SubagentStop` carry the parent's `session_id` plus an `agent_id`. Check whether the subagent's own `PreToolUse.Bash` / `PostToolUse.Bash` files carry `agent_id` too. Record yes/no.

## M5. `asyncRewake` wakes an idle Claude Code session (§21 item 16)

1. Save `SPIKE/rewake.mjs`:

   ```js
   // waits 20 s, then exits 2 with a message on stderr
   await new Promise((r) => setTimeout(r, 20000));
   process.stderr.write('REWAKE-TEST: a teammate sent you a message, tell the user.');
   process.exit(2);
   ```

2. In `proj/.claude/settings.json` give `SessionStart` a second handler next to the recorder, so the entry reads:

   ```json
   "SessionStart": [{ "hooks": [
     { "type": "command", "command": "NODE", "args": ["SPIKE/rec.mjs", "claude"], "timeout": 5 },
     { "type": "command", "command": "NODE", "args": ["SPIKE/rewake.mjs"], "asyncRewake": true, "timeout": 60 }
   ] }],
   ```

   (Claude Code 2.1.287 documents `asyncRewake` as: runs in the background and wakes Claude on exit code 2.)
3. Start `claude` in `proj` (interactive). Send `Say ok and nothing else.` and then **do nothing** for 40 seconds.
4. Record: did the session start a new turn by itself that mentions `REWAKE-TEST` (yes/no)? How long after start? If it only showed the text on your next message, record that instead.
5. Repeat once with the Claude Code desktop app if you have time. Remove the handler afterwards.

## M6. Codex interactive approval modes (§21 item 4, the part `exec` could not cover)

The spike proved a hook deny blocks `apply_patch` and shell commands in `codex exec` under `workspace-write`, `read-only`, full access and `--approve-for-me`. Check the interactive TUI too.

1. Put both deny samples in `behavior.json` (merge them into one object):

   ```json
   {
     "codex:PreToolUse.apply_patch": { "stdout": { "hookSpecificOutput": { "hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": "locked by someone else" } } },
     "codex:PreToolUse.Bash": { "stdout": { "hookSpecificOutput": { "hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": "locked by someone else" } } }
   }
   ```
2. Start `codex` in `proj` with each of these approval/sandbox choices in turn (use `/approvals` or `/permissions`, or the flags `-a on-request`, `-a never`, `--dangerously-bypass-approvals-and-sandbox`): default; auto/automatic review; full access.
3. In each, ask: "Create p.txt containing x with apply_patch." Record: blocked yes/no, and whether you were shown an approval prompt before or after the hook's refusal.
4. Reset `behavior.json` to `{}`.

## M7. Mac and Linux: shell forms, exec form and latency (§21 items 5, 6, 10, 17)

On the Mac, with the throwaway project and recorder from section 0:

1. **Claude exec form.** The 0.3 file already uses `command` + `args` with the absolute Node path. Run `claude -p "Read a.txt" --allowedTools Read` and confirm `captures/claude` is populated. Edit one handler to put `"a b"` and `"$HOME"` as extra `args` entries (after the label), re-run, and check `meta.jsonl` shows them literally (`$HOME` not expanded) and `shell`/`ppid` show Claude (not a shell) as the parent. Record yes/no.
2. **Codex POSIX command.** With only `command` set (0.4, macOS form), run `codex exec -s workspace-write "Run echo hi"` (approve the hooks first with `/hooks`, or add `--dangerously-bypass-hook-trust` for the test). Record: did hooks run, and which shell (`meta.jsonl` field `shell`, and `ps -o comm= -p <ppid>` while a hook sleeps: add `"sleepMs": 5000` for one event in `behavior.json`). Record the shell name (`zsh`, `bash`, `sh`).
3. Check that a path with a space works: copy `rec.mjs` to a folder named `a b` and point one handler at it.
4. **Latency.** Run this once and record the median it prints (target: under 150 ms on macOS):

   ```sh
   cd SPIKE && echo '{"hook_event_name":"PreToolUse","tool_name":"Read","session_id":"x"}' > pl.json
   node -e "const {spawnSync}=require('child_process');const a=[];for(let i=0;i<30;i++){const t=process.hrtime.bigint();spawnSync(process.execPath,['rec.mjs','lat'],{input:require('fs').readFileSync('pl.json')});a.push(Number(process.hrtime.bigint()-t)/1e6)}a.sort((x,y)=>x-y);console.log('median ms',a[15].toFixed(0),'p90',a[27].toFixed(0))"
   ```

5. **GUI-launched apps run hooks with the absolute Node path (item 17).** Make sure `node` is **not** on the `PATH` the GUI sees: if you use nvm/fnm/asdf, that is already true for apps launched from the Dock. Launch the **Claude Code desktop app** and the **Codex app** from the Dock/Spotlight (not from a terminal), open `proj` in each, and run a prompt. Record, per app: did the hooks run with the absolute `NODE` path (yes/no)? Then change the handler's `command` to plain `node` and record whether it fails in the GUI app (the failure message, if any). Restore the absolute path.
6. Also on the Mac, repeat M2 part A step 1 and M3 step 1 (hooks fire in the desktop apps) if the Windows run showed a difference.

## What to send back

A short list: for each of M1 to M7, the answers asked for under "Record". Then clean up: remove the `~/.codex/config.toml` project entry from 0.4 and anything M2 added, release any `user-config` lock, stop the MCP server, and delete `~/hm-spike`.
