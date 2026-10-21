# push-release-young-locks

Bug: a heartbeat carrying `state.pushed` did not release the pushed file's lock when the lock was younger than one heartbeat interval (the young-lock guard in `applyGitState`, rule 3). An agent that edited and pushed within that window and then went idle kept the file locked for teammates.

Fix (`server/src/features/locks/index.ts`): in rule 3, a file lock whose path is in this report's `pushed.files` (same repo, lock's own checkout, report not truncated) and not in the reported divergent set is released regardless of age. The young-lock guard still applies to every other lock. ARCHITECTURE.md section 9 rule 3 has one added sentence.

Tests (`server/src/features/locks/locks.test.ts`, new describe "rule 3: a push releases the pushed file even when its lock is young"):
1. young lock, pushed lists the file, not divergent: released, `lock.released` event ts equals the report time, and a teammate's edit is then allowed.
2. young lock, file not in pushed: survives.
3. pushed file divergent again: not released.
4. truncated report: nothing released.

Results: `npm run typecheck` passes. Full `npm test` passes (root 326 passed/3 skipped, workers 202, dashboard 98).

`server/src/features/snapshot/snapshot.test.ts` depended on the bug (it expected the lock on `src/auth/login.ts` to survive a push of that same file, one request after the edit). With approval, its push report now lists the file as still divergent (edited again), so the lock stays held and the push notice is still in the snapshot.
