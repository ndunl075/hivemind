# hook-push-memory: issues #20 and #21

## #20 Push not recognised within one heartbeat interval

Chosen fix: after a successful edit tool PostToolUse (`Edit`, `Write`, `MultiEdit`, `NotebookEdit`, Codex `apply_patch`),
`hook.mjs` normalizes the edited paths with `git.normalize` (the same repo-relative POSIX form `detectPush` compares,
outside-checkout and `.git/` paths dropped) and merges them into the remembered `gitMemory.divergent` in the session state.
This happens before the heartbeat throttle, so it needs no network and no Git call. It is skipped when there is no
remembered memory (before the baseline) and capped at 500 paths.

Why this over forcing a Git report after a lock-taking PreToolUse: it adds no request, no Git process and no new state flag,
and the data is the agent's own edits, so the "after a fetch followed by a push, only the agent's own previously divergent
files count" rule (ARCHITECTURE.md 12) still holds. `detectPush` still requires each file to be in the comparison-point diff and
clean now, so an edited file that was never pushed is not reported.

Verification: `cli/hook/hook.push.test.mjs` runs the real hook against a bare origin and a clone.
- SessionStart, Edit (throttled), commit and push, PostToolUse Bash: `pushed` reports `a.txt` with its blob. Fails without the fix.
- Teammate commit fetched and pulled before the push: only the agent's own `a.txt` is reported. 
- Edits outside the checkout or under `.git/` are not remembered.

## #21 repoNameOf with local-path origins

`repoNameOf` (now exported) treats Windows drive paths, UNC paths, POSIX absolute paths and `file:` URLs as local paths and
splits them on `/` and `\` only; remote URLs still split on `/` and `:` (scp-like form). Tests in `cli/hook/git.test.mjs`.
