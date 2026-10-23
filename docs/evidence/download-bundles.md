# Evidence: download bundles

Built and checked on Windows 11, Node 22 as the build runtime, 2026-10-23, from `main` at 4315d76.

## Build

`npm ci` then `npm run bundle` (first run downloaded; later runs use `installer/.cache/`):

```
downloading https://nodejs.org/dist/v20.20.2/win-x64/node.exe
downloading https://nodejs.org/dist/v20.20.2/node-v20.20.2-darwin-arm64.tar.gz
downloading https://nodejs.org/dist/v20.20.2/node-v20.20.2-darwin-x64.tar.gz
hivemind-windows.zip  27.6 MiB  sha256 ecf35cc81101a25609b6a7a0e4a35320993ed921aee5b560e4e024b149be47f6
hivemind-mac.zip  60.3 MiB  sha256 2419b8268f3bfe349b2b26d1d690c981b5dffa8e01433ceeaeb91963c5a4143c
```

Sizes: windows 28,918,325 bytes, mac 63,275,093 bytes. Every download is checked against `SHASUMS256.txt` of that
Node release (a mismatch aborts the build; a cached file is re-hashed before use). Node 20.20.2 is pinned in
`installer/build.mjs`. The zips are repeatable: fixed timestamps, sorted entries.

`unzip -tq` reports no errors for both zips; PowerShell `Expand-Archive` extracted the Windows one.

## Windows bundle: run for real

Setup: local server (`wrangler dev`, port 8791, throwaway secrets), room and invite created with
`hivemind room create` / `hivemind invite` (admin secret in `HIVEMIND_ADMIN_TOKEN`), a temp Git repo with one
commit, the zip extracted to a temp folder. Launcher run with a PATH of only `C:\Windows\System32` and Git's `cmd`
folder (no Node), `HIVEMIND_HOME` in a folder **with a space in its name**, and `USERPROFILE`, `CLAUDE_CONFIG_DIR`,
`CODEX_HOME` all pointed at temp folders, so the real machine config was not touched. Token piped with
`--token-stdin --yes`; `HIVEMIND_PROJECT` and `HIVEMIND_NO_PAUSE=1` skip the folder question and the final pause.

Result: `Hivemind Setup.cmd` copied `node.exe` to `<HIVEMIND_HOME>\runtime\node.exe`, `join` accepted the token
("you are tester in room bundle-test"), installed the hook folder, registered the Claude Code and Codex hooks (with the
config folders present), and `doctor` ran and printed the self-test prompt. Doctor was all `ok` except the Claude
Code MCP entry: the `claude` program does not exist in this isolated environment, so `join` printed its normal
"not found, run hivemind update" warning. Not a bundle problem; Codex's MCP entry and all 6 hooks for both apps passed.

**Hook path survives the bundle:** the registered hook command is
`<HIVEMIND_HOME>\runtime\node.exe <HIVEMIND_HOME>\hook\hook.mjs claude`, not a path inside the zip folder. I renamed
the extracted folder, deleted its `node` and `app` folders, and ran that registered command with a SessionStart
payload: it returned the `[Hivemind] You are claude-tester. Room "bundle-test", mode: enforce` briefing and logged `ok:true`.
(If the launcher had run join with the bundled node in place, hooks would have pointed at the zip folder; that is why the
launcher copies Node first. No change in `cli/` was needed.)

## Mac bundle: NOT run on a Mac

Contents (`unzip -Z`), modes preserved:

```
-rwxr-xr-x  Hivemind/Hivemind Setup.command        (LF line endings)
-rw-r--r--  Hivemind/README.txt
-rwxr-xr-x  Hivemind/node/node-arm64                89,830,192
-rwxr-xr-x  Hivemind/node/node-x64                  92,324,688
-rw-r--r--  Hivemind/app/cli/...  (same files as Windows)
-rw-r--r--  Hivemind/app/shared/protocol.md, app/package.json, app/node_modules/smol-toml/...
```

The `node-*` binaries are extracted from the official `darwin-arm64` / `darwin-x64` tarballs (hash-checked). The
launcher is untested on macOS: `uname -m` selection, `xattr` quarantine clearing, drag-a-folder path cleanup, and
Gatekeeper behaviour for an unsigned `.command` (the README tells people to Control-click, Open). I only checked the
Mac zip's integrity and listing, and the launcher is plain bash with no bash-4 features.

## Other checks

`npm run typecheck`: passes. Not run: `npm test` (nothing under tested code changed), the interactive path (typing a
token at the hidden prompt, dragging a folder onto the window, and the real `pause`), SmartScreen on a downloaded copy.
