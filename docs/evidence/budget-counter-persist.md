# budget-counter-persist

## Bug
The Room counted requests in memory and wrote `budget:<date>` to `meta` only once per housekeeping interval (60 s).
When Cloudflare evicted the Durable Object, the constructor reloaded the last flushed value and the requests since
then were lost. The dashboard's "usage today" jumped backwards and the 60/80/95% guard undercounted.

## Fix
`Room.onRequest()` persists the counter ahead of the in-memory count (`persistBudget`, `BUDGET_PERSIST_EVERY = 25` in
room.ts). When the count passes the stored value, the stored value becomes the count plus a margin of
min(25, requests since boot) - 1. After an eviction the reload can overcount by at most the requests handled since the
last boot and never more than 24, so repeated evictions don't compound ("1 request, evict" four times reloads as 1, 2,
3, 4). It never undercounts. A long-running Room writes about once per 25 requests (within the §16 row-write budget).
`budgetReserved` is only updated after the write succeeds. An earlier revision wrote every request (rejected: exceeds
the 100k/day row-write cap at 16 agents), and a second rounded up to multiples of 25, which compounded by 25 per
restart (found in review). Old days' `budget:` keys are dropped on UTC rollover, at boot and in housekeeping. The
counter stays per room. ARCHITECTURE.md §16 and the failure table are updated.

## Verified
- `keeps ... does not compound` (server/src/room.test.ts): from a clean counter, 7 requests then eviction reloads in
  [7, 14); four "1 request, evict" cycles reload within [i+1, 8] (not 100); midnight UTC resets to 1 and only the new
  day's key remains.
- `writes the counter about once per 25 requests`: over 60 requests the stored value changes at most 8 times, is never
  below the count, and a full 24-request margin is written and then causes no further write.
- Existing budget tests pass. `npm run typecheck` and `npm test` pass locally.
