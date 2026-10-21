# Evidence: server-core (Wave 1, W1)

## What was built
- `server/src/worker.ts`: every route in §8.1. Agent and viewer tokens (HMAC-SHA256, constant-time `crypto.subtle.verify`) and the admin secret are checked in the Worker, so bad tokens never wake a Room. The viewer token is read from the `Sec-WebSocket-Protocol` offer (`hivemind, <token>`) only, never from the URL. The Worker sets the `x-hm-claims` header on every Room request itself.
- `server/src/room.ts`: schema in code, memory load in `blockConcurrencyWhile`, memory-first writes, hibernating dashboard sockets (snapshot on connect, debounced to 4 a second on change, pulses at once), wait registry (`waits.ts`), limits (50 agents, 20 requests a second per person, 10 messages a minute per sender via `allowMessage`), budget guard (`budget.ts`) with the 95% switch, `mode_by_guard` and the restore after 00:00 UTC, room modes, emergency unlock, per-repo settings in `meta` as `settings:<repo>`, admin create, invite, revoke, rotate and delete.
- `server/src/pipeline.ts`: the hook pipeline, with `hookStages()` extension points (`afterIdentify`, `beforeEdit`, `afterEdit`, `beforeRespond`) and `briefingLines()` collection. `server/src/briefing.ts` builds the §6.6 briefing.
- Features, each in `server/src/features/<name>/`: `locks` (rules 1-3, 6, 7, 8, 11, modes; `denial.ts` has the §9 text), `messages` (notify and delivery), `pushes` (record, latest), `tasks` (stub, gate off), `snapshot` (agents, locks, mode), `mcp` (initialize, tools/list, tools/call, the `status` tool; all responses go through `writeMcpResponse()` so the single-event SSE fallback is a one-function change).

## Checks run
- `npm run typecheck`: pass.
- `npm test`: shared 6, Workers 44 (5 files), dashboard none yet. `npm run test:workers`: 44 pass.
- `npm run build`, then `npx wrangler deploy --dry-run -c server/wrangler.toml`: pass (bindings ROOM and ASSETS). Nothing was deployed.

## Brief criteria and the tests that cover them (`server/src/*.test.ts`)
- 100 concurrent edit checks on one path leave one holder: `room.test.ts` "100 concurrent edit checks" (50 persons, two checks each, over real HTTP; 1 allowed holder, 98 denied, one lock row). The 50-agent cap and the per-person burst limit prevent 100 distinct agents or 100 requests from one person.
- Release by divergence, never by a truncated list: "releases a lock when the divergent list drops the file".
- Folder reservation, take on a takeable holder, ended holders: "folder reservations...", "reserving is all or nothing", "lets a takeable holder be taken from, and loses locks of ended holders" (fake clock: not takeable at 10 min, takeable at 20, holder notified, ended after 12 h).
- State survives a Room restart: "state survives a Room restart" (`evictDurableObject`; locks, idle marks, mode, budget counter and settings reload).
- Bad tokens never touch a Room: "rejects forged agent and viewer tokens before any Room exists" (the set of Durable Object ids is unchanged after forged agent tokens on every route, bad and wrong-room viewer tokens, and a token in the URL).
- Budget guard: thresholds 60% (30 s), 80% (60 s), 95% (`heartbeatMs: 0`, switch to warn, announcement), restore after 00:00 UTC, a team-set mode clearing `mode_by_guard` and not being fought by the guard on the same day.
- Per-repo settings from `/hook` stored in `meta` and readable through `RoomContext.settings`.
- Wait resolves on `notify()` and on a lock release, and times out at 45 s (fake timers, a 500 s request is clamped).
- Viewer gets a snapshot on connect and after a change, and a pulse for a denial; rotating the viewer token closes sockets with 1008.

## Decisions to review
- `agents` has one column more than §4: `repo_name` (the dashboard shows it).
- Tokens: names are lowercase letters, digits, `-` (and `_` for people), so the dots in a token always split cleanly. Tokens are deterministic, so inviting a revoked person returns 409 until the agent tokens are rotated (rotating also clears the revoke list and ends every agent; sessions revive with their callsigns). `DELETE /admin/rooms/<room>` empties all tables and bumps both generations so older tokens stay dead.
- `events.data` is JSON `{ text, data?, pulse?, edge?, wake? }`, so W7 can rebuild the activity feed and recent edges from the table. The Room overwrites `room`, `mode`, `now` and `usage` in every snapshot, whatever `SnapshotApi.build()` returns for them.
- `reserve` is strict in every mode (it is an explicit request). `checkEdit` in `warn` mode still takes locks for free paths; in `off` it takes none.
- Rule 3 releases a file lock when the holder, or any agent in the lock's checkout, reports a complete list without the file (rule 5's release half). Known small race: a lock taken just before a same-checkout agent's heartbeat computed its list can be released early and is re-taken on the next edit.
- Messages: broadcasts reach agents that registered before the message. `unreadCount()` (now part of `MessagesApi` after contract checkpoint 1) counts unread direct and broadcast messages without delivering them; the `status` tool uses it.
- Test pitfall recorded: an unread response body keeps a request in flight and stalls `evictDurableObject`; tests read bodies.

## Review round 1 (Tier 2)
All 13 findings fixed; tests for each are in `server/src/review.test.ts` (plus updated expectations in `room.test.ts`). Points worth knowing:
- Over agents (ended, or 12 h silent) go through one cleanup (locks, tasks, direct messages and delivered state) before their callsign is reused, their session revived, and at boot.
- `messages` gained `exclude` and `repo` columns (the notify filters survive a restart) and an extra `forget(callsign)`.
- Paths are canonicalised at validation (`canonicalPath` in `util.ts`) and again inside locks; absolute or escaping paths are a 400.
- Rule 3 releases only on a report from the lock's own checkout, and never a lock younger than `LIMITS.heartbeatMs`.
- Snapshots are scheduled by events and visible roster or lock changes only. `/unlock` of a path may add a `note` field to its response when it also dropped a folder reservation (additive to `UnlockResponse`).
- `WaitResult.event` is `'message' | 'release' | 'task' | 'timeout'`; non-finite `seconds` throws a `RangeError` (the future `wait` tool must validate first).
