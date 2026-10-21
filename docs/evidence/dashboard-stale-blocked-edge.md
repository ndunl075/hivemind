# dashboard-stale-blocked-edge

Bug: a red "blocked" edge stayed drawn after the lock was released and after both agents ended.
Cause: `buildViewModel` only expired blocked edges by age and kept them while both agents were still in the roster
(ended agents stay listed for 24 h, §5).

Fix (`dashboard/src/model.ts`, `blockedStillApplies`): a blocked edge A -> B labeled F is drawn only while
- neither A nor B is `ended`,
- B still holds a lock whose path is F or ends in `/F` (edges carry only the base name), and
- A does not hold such a lock.
A folder lock held by B cannot be matched to the base name, so it keeps the edge. Max age is unchanged:
`LIMITS.blockedEdgeMs` (2 min), which is what ARCHITECTURE.md §14.2 states.

Verified with model tests in `dashboard/src/model.test.ts` (one per case: still held, released, taken by someone else,
taken by the blocked agent, either agent ended, max age). `npm run typecheck` and `npm run test:dashboard` pass.
No screenshot: the fake data source always keeps the lock held, so before/after would look identical.
