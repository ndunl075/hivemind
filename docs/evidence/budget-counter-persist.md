# budget-counter-persist

## Bug
The Room counted requests in memory and wrote `budget:<date>` to `meta` only once per housekeeping interval (60 s).
When Cloudflare evicted the Durable Object, the constructor reloaded the last flushed value and the requests since
then were lost. The dashboard's "usage today" jumped backwards and the 60/80/95% guard undercounted.

## Fix
`Room.onRequest()` now persists the counter on every request (`persistBudget`, one `INSERT OR REPLACE` of a single
small `meta` row; `setMeta` skips the write if the value is unchanged). The old once-a-minute counter flush is gone.
Old days' `budget:` keys are dropped on UTC rollover, at boot, and in the existing housekeeping pass. The counter stays
per room. `BudgetCounter` is unchanged.

## Verified
- New test `keeps every counted request across an eviction, and still resets on a new day` (server/src/room.test.ts):
  records 7 requests with no housekeeping interval elapsed, evicts, and asserts the same count; one more request and
  another eviction gives count+1; after midnight UTC the counter resets to 1, survives eviction, and only the new
  day's key remains.
- Existing budget tests (thresholds, flush/reload, prune) still pass.
- `npm run typecheck` and `npm test` pass locally.

## Trade-off: row-write budget (ARCHITECTURE.md §16)
§16 budgets about 1,400 row writes a day for counter flushes (total about 31,000 of the 100,000 cap). Persisting every
request is one row write per request: about 36,000 a day at the 8-agent estimate (total about 65,000, still under the
cap), but at the 16-agent estimate (about 88,000 requests) it would add about 88,000 writes and exceed the cap. This
trades write budget for correctness. Cheaper options if that matters: persist every Nth request and round the stored
value up to the next multiple of N (bounded overcount of fewer than N per eviction, never an undercount). Request for
the architect: update the §16 row-write table (ARCHITECTURE.md is not in this worker's scope) and decide whether to
adopt the batched variant.
