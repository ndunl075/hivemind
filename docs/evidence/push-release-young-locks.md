# push-release-young-locks

Bug: a heartbeat carrying `state.pushed` did not release the pushed file's lock when the lock was younger than one heartbeat interval (the young-lock guard in `applyGitState`, rule 3). An agent that edited and pushed within that window and then went idle kept the file locked for teammates.

Fix (`server/src/features/locks/index.ts`): in rule 3, a file lock whose path is in this report's `pushed.files` (same repo, lock's own checkout, report not truncated) and not in the reported divergent set is released regardless of age. The young-lock guard still applies to every other lock. ARCHITECTURE.md section 9 rule 3 has one added sentence.

Accepted trade-off (code comment in `applyGitState`): a parallel edit of a just-pushed file made after the report was computed can lose its lock until that agent's next edit. The hook never reports a file as both pushed and divergent, and bypassing the guard only for older locks would break `git commit && git push` in one shell command right after an edit. ARCHITECTURE.md section 9 rule 3 says the release is limited to the holder's checkout.

Tests (`server/src/features/locks/locks.test.ts`, describe "rule 3: a push releases the pushed file even when its lock is young"):
1. young lock, pushed lists the file, not divergent: released, `lock.released` event ts equals the report time, teammate's edit then allowed.
2. young lock, file not in pushed: survives.
3. pushed file also reported divergent: survives (defensive only; the hook never sends both).
4. truncated report: nothing released.
5. young locks in another checkout and in another repo, path in pushed: survive.
6. pushed path as `A.TXT` or `./b.txt`: still releases.
7. young lock held by a checkout-mate (rule 5): released.
8. realistic sequence: edit, heartbeat listing the file divergent, push report 5 s later: released.

Snapshot test (`server/src/features/snapshot/snapshot.test.ts`) depended on the bug. Its push report now has `divergent: []` with the pushed file (what the hook sends), and the snapshot asserts the lock is released; pulses, edges and activity assertions are unchanged.

Results: `npm run typecheck` passes. Full `npm test` passes (root 326 passed/3 skipped, workers 206, dashboard 98).
