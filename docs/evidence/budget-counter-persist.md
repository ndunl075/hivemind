# budget-counter-persist

## Bug
The Room counted requests in memory and wrote `budget:<date>` to `meta` only once per housekeeping interval (60 s).
When Cloudflare evicted the Durable Object, the constructor reloaded the last flushed value and the requests since
then were lost. The dashboard's "usage today" jumped backwards and the 60/80/95% guard undercounted.

## Fix
`Room.onRequest()` persists the counter in blocks (`persistBudget`, constant `BUDGET_PERSIST_EVERY = 25` in room.ts):
when the in-memory count exceeds the stored value, the stored value becomes the count rounded up to the next multiple of
25. After an eviction the reload can overcount by fewer than 25 but never undercounts (the guard errs early, not late).
This is about one `meta` row write per 25 requests, within the §16 write budget (the counter's share is unchanged in
order of magnitude; the old once-a-minute flush is removed). An earlier revision wrote every request; the architect
rejected it because it would exceed the 100k/day row-write cap at 16 agents. ARCHITECTURE.md §16 gets one sentence.
Old days' `budget:` keys are dropped on UTC rollover, at boot and in the housekeeping pass. The counter stays per room.

## Verified
- New test in server/src/room.test.ts: 7 requests, evict, count is 25; up to 30, evict, 50; after midnight UTC the
  counter resets to 1, reloads as 25 after eviction, and only the new day's key remains.
- Existing budget tests (thresholds, reload now 1025 rounded up, prune) pass.
- `npm run typecheck` and `npm test` pass locally.
