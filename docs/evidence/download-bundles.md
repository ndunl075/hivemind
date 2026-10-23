# Evidence: download bundles

Built and checked on Windows 11, Node 22 as the build runtime, 2026-10-23. First pass from `main` at 4315d76; review
fixes on top of the merge of origin/main (README change, PR 38).

## Build

`npm ci` then `npm run bundle` (first run downloads; later runs use `installer/.cache/`):

```
downloading https://nodejs.org/dist/v24.22.1/win-x64/node.exe
downloading https://nodejs.org/dist/v24.22.1/node-v24.22.1-darwin-arm64.tar.gz
downloading https://nodejs.org/dist/v24.22.1/node-v24.22.1-darwin-x64.tar.gz
hivemind-windows.zip  34.4 MiB  sha256 167207eba2cd706fc59a14fd29405a70596a653767b98035c4bb51b4c2595da7
hivemind-mac.zip  78.3 MiB  sha256 73fa45adf9ab64048c8f3b0813c884cef1199c8eefd5181447cdd46a2898bd29
```

Sizes: windows 36,076,015 bytes, mac 82,139,770 bytes. Node 24.22.1 (Active LTS; Node 20 is end of life) is pinned.
Each file used has its SHA-256 pinned in `build.mjs` and must also match the release's `SHASUMS256.txt`; a cached
checksum list that does not parse or does not list the files is re-downloaded; a cached archive is re-hashed before
use. The zips are repeatable (fixed timestamps, sorted entries). `unzip -tq` is clean on both.

## Windows bundle: run for real

A scratch driver (not committed) starts `wrangler dev` (port 8792, throwaway secrets), creates a room and invite with
`hivemind room create` / `invite`, makes a temp Git repo, extracts the zip with `Expand-Archive`, and runs the
launcher through `cmd /c chcp 437 & call "Hivemind Setup.cmd" --token-stdin --yes`. Environment: PATH is only
`C:\Windows\System32` and Git's `cmd` folder (no Node); `USERPROFILE`, `HIVEMIND_HOME`, `CLAUDE_CONFIG_DIR`,
`CODEX_HOME` are in a temp folder named **`Zoë Smith`** (non-ASCII and a space), so the real config is untouched.
`HIVEMIND_PROJECT` and `HIVEMIND_NO_PAUSE=1` skip the folder question and the final pause.

Results (first and second run both exit 0):
- Join accepted the token, registered Claude Code and Codex hooks; doctor ran and printed the self-test prompt. The only
  FAIL is Claude's MCP entry, because there is no `claude` program in the isolated environment (join says so).
- Doctor reports the recorded node as `...\HMB-OD~1\ZOSMIT~1\HIVEMI~1\runtime\node.exe`: `process.execPath` keeps the 8.3
  short form, so it is plain ASCII.
- `hook\headers-helper.cmd` contains no byte above 127 and, run under `chcp 437`, prints the Authorization header JSON
  (exit 0). This is the check for the non-ASCII username problem. I did not re-run the unfixed launcher to see it
  fail; the reviewer reproduced that.
- Second run: the identical `runtime\node.exe` is detected (`fc /b`) and not copied again; `runtime` holds only `node.exe`.
- A launcher without a `node\` folder next to it (what Explorer's zip view gives) prints "This window was opened from
  inside the zip file ... Extract All".

Earlier pass (Node 20 bundle, same launcher logic): after renaming the extracted folder and deleting its `node` and
`app` folders, the registered hook command (`<HIVEMIND_HOME>\runtime\node.exe <HIVEMIND_HOME>\hook\hook.mjs claude`)
still ran and returned the `[Hivemind] You are ...` briefing. Not repeated for Node 24; the path logic did not change.

## Mac bundle: NOT run on a Mac

Contents (`unzip -Z`), modes preserved:

```
-rwxr-xr-x  Hivemind/Hivemind Setup.command        (LF line endings)
-rw-r--r--  Hivemind/README.txt
-rwxr-xr-x  Hivemind/node/node-arm64                122,545,856
-rwxr-xr-x  Hivemind/node/node-x64                  125,715,808
-rw-r--r--  Hivemind/app/cli/...  (same files as Windows)
-rw-r--r--  Hivemind/app/shared/protocol.md, app/package.json, app/node_modules/smol-toml/...
```

The `node-*` binaries come from the official `darwin-arm64` / `darwin-x64` tarballs (hash-checked). The launcher is
`bash -n` clean. The folder-drag cleanup (the line that was broken in the first version) is now a bundled-Node one-liner;
I ran that exact line from the launcher under Git Bash on Windows with `/tmp/pt/my\ dir\ \(1\) ` (escaped spaces and
parentheses, trailing space) and got `/tmp/pt/my dir (1)`, and `cd` into it worked; a quoted path and `~/x` also
came out right. **Untested on macOS:** `uname -m` selection, `xattr`, the copy-and-rename of Node, and Gatekeeper /
"Open Anyway" for the unsigned `.command`.

## Other checks

`npm run typecheck` passes. Not run: `npm test` (no tested code changed), the interactive prompts (hidden token, dragging
a folder, the real `pause`), SmartScreen on a downloaded copy, a machine with 8.3 short names disabled (the launcher
then keeps the long path and a non-ASCII username would again break the headers helper).
