# stop-unfinished-task

## What was built
- `shared/contracts.ts` (approved by the architect): `TasksApi.stopReminder(callsign)`, nothing else.
- `server/src/features/tasks/index.ts`: `stopReminder(callsign)` on the task board. It fires only on a real "forgot to close it" signal: the agent's newest push (read from the `pushes` table of features/git) is later than the task's last update (its claim), the agent holds no file-kind locks, and the task is still `in_progress`. It lists up to three such unreminded tasks in one fixed reminder (titles quoted, flagged as teammate-written, typographic quotes and backticks flattened, cut by code points to 80), and records each as `meta` row `stop_reminded:<task id>` = callsign. The row is deleted on claim/take, give-back, done/dropped, owner ended (return to open) and prune, so each ownership period gets its own reminder and a restart does not repeat one. The rows go straight to SQL: the Room's in-memory meta cache is private and loaded once, and nothing reads these keys through it (same as `next_task_id`).
- `server/src/pipeline.ts` (Stop case only): after the unread-direct-message block, if nothing blocked, `stop_hook_active` is not true, the mode is not `off` and the budget guard is at its normal level (`heartbeatMs()`, which is `budget.level().heartbeatMs`, equals `LIMITS.heartbeatMs`; any slowed level skips), the reminder becomes the Stop block. No extra requests.
- `ARCHITECTURE.md` §6.2 Stop row and §11.

No changes to `cli/hook/**`: the server decides the block and the hook already relays `decision: block` with `reason`.

## Tests (`server/src/features/tasks/tasks.test.ts`)
Plain turn end without a push; push + no locks gives one block (quoting, record, no repeat, survives a Durable Object eviction); code-point cut; held file lock suppresses until pushed; a push before the claim does not count; `stop_hook_active`; precedence sequence (message block, then `stop_hook_active` Stop, then the reminder once); mode `off`; slowed budget levels (60%, 80%, 95%); done/dropped and never-owned; handoff (record cleared, new owner reminded afresh); callsign reuse after the agent ended; two-plus tasks in one reminder (cap 3 plus "and N more"); prune deletes the record.

## Not done / notes
- The push signal reads the newest `pushes` row of the agent. If a teammate later overwrites every file that agent pushed (rows are per path, latest wins) the signal is lost and no reminder fires; that errs on the quiet side.
- A `take` goes through the same code path as a claim (clears the record); it is not separately tested because taking needs a takeable owner.
