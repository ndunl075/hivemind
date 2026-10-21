# dashboard-live evidence

Branch `w/dashboard-live`. Covers the full snapshot (`server/src/features/snapshot/`) and the live socket (`dashboard/src/live/`).

## What was built

- **Snapshot.** `build()` returns agents, tasks, locks, edges and activity. Activity is the newest 50 rows of the `events` table (read through `ctx.sql` only), newest first. Edges are rebuilt from the `edge` and `pulse` parts of recent events (message and broadcast for 60 s, blocked for 2 min, newest per kind/from/to), plus derived `waiting` (blocker to waiter, both tasks in progress) and `nearby` (holders sharing a folder, one edge per pair). The Room still overwrites `room`, `mode`, `now` and `usage`.
- **Pulses.** The Room already broadcasts a pulse for every event that carries one. Messages, denials and pushes are covered by tests below.
- **Live socket.** `socket.ts` connects to `/r/<room>/ws` with subprotocols `['hivemind', <token>]`, validates every frame with `parseMessage`, pings every 25 s, and reconnects with exponential backoff (500 ms doubling to 15 s, jittered, reset when data arrives). `index.ts` now returns the socket source; `?demo=...` still selects `fake.ts`. `sourceNeedsToken` is `true`, so the token prompt shows.

## Automated checks

- `npm run typecheck` passes.
- `npm run test:workers` passes (66 tests), including `snapshot.test.ts`: a seeded room (two agents, a lock, a denial, a push, a message and a broadcast) yields a snapshot matching the contract, with the blocked, message and broadcast edges, newest-first activity, and denied, push, message and broadcast pulses seen on a viewer socket; message edges expire while their activity line stays; the activity feed is capped at 50; waiting and nearby edges derive correctly.
- `npm run test:dashboard` passes (93 tests), including `socket.test.ts`: subprotocols, snapshot and pulse delivery, ignoring malformed frames, ping, backoff growth and reset, and clean stop.

## Manual run

Local `wrangler dev -c server/wrangler.toml --port 8789` with fake secrets in a gitignored `server/.dev.vars`, dashboard built to `dashboard/dist` and served by the Worker. A room and one agent were created through the local admin and invite routes, and the page was opened at `/r/demo#v=<viewer token>`. The page showed "Live" and an empty room.

From the page, a `SessionStart` and then an `Edit` PreToolUse were posted to `/hook`, timing from the request until the DOM changed:

| Change | Time to appear on the page |
|---|---|
| Agent joined (1 agent, activity "claude-ana joined") | 23 ms |
| Lock taken (1 lock, `src/live.ts` in the Locks panel, activity line on the agent card) | 266 ms |

Both are under the 1 s target (the second includes the Room's 250 ms minimum gap between snapshots). Reconnect was exercised in unit tests only, not against the running server.

## Notes

- With `sourceNeedsToken` true, `?demo=offline` and other fake modes need a token in the URL too before the source starts (the app starts no source without one); any well-formed `#v=hm_v...` value works for the fake.
- `usage` stays the Room's value; the snapshot does not compute it.
