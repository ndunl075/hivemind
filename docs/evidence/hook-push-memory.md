# hook-push-memory: issues #20 and #21

## #20 Push not recognised within one heartbeat interval

Fix (review round 1 replaced the first approach): on an edit-tool PostToolUse, if a normalized edited path is not yet in the
remembered `gitMemory.divergent`, the event is not throttled: it sends a heartbeat with Git state, exactly like after a
shell command. The remembered set therefore stays Git-confirmed (no local merging, so no lost updates between parallel hooks,
no identical-content or reverted edits counted, no cap truncation of new edits). Already-known paths keep normal throttling,
`heartbeatMs === 0` still means no heartbeat, and the check sits in its own try/catch so an error there is only logged, never
counted towards the circuit breaker.

Review finding (false push notice): SessionStart, teammate pushes a.txt, agent edits a.txt, then `git checkout -- a.txt &&
git pull --ff-only`. `detectPush` saw a.txt as previously divergent and in the arrived range, so it reported the teammate's
blob as the agent's push. This also happened on main whenever a heartbeat fell between the edit and the pull, so it is fixed
in `detectPush`: when the HEAD reflog shows no commit, cherry-pick, rebase, revert or am since the previous report's HEAD, only
files already committed ahead of the old comparison point (`before...previous.head`) can have gone out; dirty-only files cannot.
An unreadable reflog or one that does not reach the previous HEAD leaves the old behaviour. This adds read-only
`git reflog show` to the commands in ARCHITECTURE.md 12 (architect-owned doc, please update the list).

Test-only env `HIVEMIND_GIT_BUDGET_MS` raises the hook's and `state()`'s Git time budget (default 1.5 s and 1.2 s). It is used by
`hook.push.test.mjs`.

Tests (`cli/hook/hook.push.test.mjs`, real hook, bare origin and clone): push within one heartbeat interval is reported (fails
without the fix); the false-push scenario reports `pushed: null`; a new edit sends a heartbeat at once and a repeat edit stays
throttled (fails without the fix); edits outside the checkout or under `.git/` send nothing.

## #21 repoNameOf with local-path origins

`repoNameOf` (now exported) treats Windows drive paths, UNC paths, POSIX absolute paths and `file:` URLs as local paths and
splits them on `/` and `\` only; remote URLs still split on `/` and `:` (scp-like form). Tests in `cli/hook/git.test.mjs`.

## git.world.test.mjs flakiness on slow Windows runners

The file's per-test timeout was already 90 s and it has no fixed sleeps. The race was the production 1.2 s Git budget in
`state()`: on a loaded runner a test not about the budget could run out of it, get the truncated status-only fallback and
see `pushed: null` (issue #27; seen in CI as "a deleted file that was pushed carries the empty blob"). The test file now calls
`state()` through a wrapper with a 60 s `budgetMs`; the budget tests still pass their own `budgetMs`. No assertion changed.
