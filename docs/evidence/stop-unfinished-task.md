# stop-unfinished-task

## What was built
- `server/src/features/tasks/index.ts`: `stopReminder(callsign)` on the task board. Returns a fixed, short reminder (title quoted and flagged as teammate-written, cleaned to one line of at most 80 characters) when the agent owns an in-progress task and has not been reminded for it, and records the reminder in `meta` as `stop_reminded:<task id>` = callsign. The record is deleted when the task is pruned.
- `server/src/pipeline.ts` (Stop case only): after the existing unread-direct-message block, if nothing blocked, `stop_hook_active` is not true, the room mode is not `off` and the budget guard has not turned heartbeats off (`heartbeatMs` > 0), the reminder becomes the Stop block. No extra requests are made.
- `ARCHITECTURE.md` §6.2 Stop row and §11.

No changes to `cli/hook/**`: the server decides the block and the hook already relays `decision: block` with `reason`.

## Tests (`server/src/features/tasks/tasks.test.ts`)
Reminded once and the quoting/format; survives a Durable Object eviction without repeating; not with `stop_hook_active` (and does not use up the reminder); direct messages take precedence, reminder follows on the next Stop; mode `off`; budget guard; no reminder after done/dropped or without a task; a second task gets its own reminder.

## Not done / notes
- Reminder is once per task per owner callsign. If the same agent gives a task back and reclaims it, it is not reminded again.
- The reminder is recorded when the block is issued, even if the agent never reads it.
