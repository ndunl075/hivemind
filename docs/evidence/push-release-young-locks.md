# push-release-young-locks

Bug: a heartbeat carrying `state.pushed` did not release the pushed file's lock when the lock was younger than one heartbeat interval (the young-lock guard in `applyGitState`, rule 3). An agent that edited and pushed within that window and then went idle kept the file locked for teammates.

Fix (`server/src/features/locks/index.ts`): in rule 3, a file lock whose path is in this report's `pushed.files` (same repo, lock's own checkout, report not truncated) and not in the reported divergent set is released regardless of age. The young-lock guard still applies to every other lock. ARCHITECTURE.md section 9 rule 3 has one added sentence.

Tests (`server/src/features/locks/locks.test.ts`, new describe "rule 3: a push releases the pushed file even when its lock is young"):
1. young lock, pushed lists the file, not divergent: released, `lock.released` event ts equals the report time, and a teammate's edit is then allowed.
2. young lock, file not in pushed: survives.
3. pushed file divergent again: not released.
4. truncated report: nothing released.

Results: `npm run typecheck` passes. `npm run test:workers`: 201 passed, 1 failed. The failure is `server/src/features/snapshot/snapshot.test.ts` ("snap.locks" expects `src/auth/login.ts` still locked right after a PostToolUse that pushes that same file, one request after the edit). That test depended on the bug; it passes on main. It is outside this task's ownership, so it is not edited here. Suggested fix for its owner: advance the clock (or fake time) more than a heartbeat interval between the edit and the push, or push a different file than the one still expected to be locked.
