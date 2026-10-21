# Evidence: tasks-and-messages (Wave 2, W4)

## What was built
- `server/src/features/tasks/`: the task board (§10). SQLite `tasks` table loaded into memory; every method is a synchronous check followed by a write, so the single-threaded Room decides claims strictly in order. Operations beyond `TasksApi` (`add`, `claim`, `update`, `get`) are exported as `TaskOps`/`FullTasks`, which the MCP tools reach by a type cast; `TasksApi` itself is unchanged. `similarity.ts` holds title normalization and Jaccard.
- `server/src/features/messages/`: messaging (§11). `MessagesApi` unchanged; extra `send` and `recent` (`MessagesOps`/`FullMessages`). `sanitize.ts` is the text hygiene shared with task titles.
- `server/src/features/mcp/`: all eleven tools (`tools.ts`), the dispatcher (`index.ts`), a small input-schema validator (`schema.ts`), error types (`types.ts`). Tool descriptions are written as short instructions. `initialize` returns `shared/protocol.md` as `instructions`.

## Behaviour decisions to review
- **Task states.** `open -> in_progress -> done | dropped`. Only the owner updates a task; the creator may drop it while it is open. `done`, `dropped` and `open` (given back) release the task's folder reservations through `LocksApi.releaseForTask`. `done`/`dropped` are terminal. An agent may hold several in-progress tasks; `inProgressFor` returns the most recently updated one.
- **Gate.** Denies while the agent owns no in-progress task and `requireTask` is on. The reason is the §10 sentence plus up to three open tasks. The Room pipeline (unchanged) already turns it into a deny in `enforce`, a heads-up in `warn`, nothing in `off`.
- **Dependencies.** Existing ids only (checked on add). A claim answers `waiting` with the unfinished ids; done, dropped and pruned dependencies count as satisfied. `task_add` with `claim: true` and unfinished dependencies still creates the task and answers `waiting` for the claim.
- **Duplicates.** Compared with open and in-progress tasks only (a done task may legitimately be repeated). Equal normalized titles, or Jaccard >= 0.8, are returned instead of created unless `force`. Otherwise up to 3 similar titles (Jaccard >= 0.2, any status but dropped), most similar first. Tasks of one call are checked in order, so a duplicate inside the call is caught.
- **Areas.** Folders are canonicalized (`src/auth` and `src/auth/` are the same, `.git` and paths leaving the repo are refused). Claiming reserves them one folder at a time through `LocksApi.reserve`, so a busy folder does not stop the others; the claim still succeeds and the result carries a `warning` naming what could not be reserved. Areas need a repo: the `repo` argument, the caller's own repo, or (for `register`ed agents) the room's only repo.
- **Takeover.** `task_claim` with `take: true` needs a reason and a takeable owner (idle or quiet 15+ minutes). It releases the previous owner's reservations for that task, reserves for the new owner and sends the previous owner a notice. A non-takeable owner answers `taken` with `takeable: false`.
- **Ended owners.** `onAgentEnded` returns their in-progress tasks to `open` with a note (keeping their last note). The board also does this lazily on read (`list`, `claim`, `update`, `add`) for owners that are ended or gone but not yet swept by the Room's once-a-minute housekeeping.
- **Messages.** Direct and broadcast posts, quoted and attributed on every path. Text is cleaned (all line breaks folded to `\n`, control, bidi and zero-width characters removed) so a `\r` or U+2028 cannot step outside the `> ` quote. Over-long (> 2,000) and empty messages are refused, not truncated. Rate limit: `RoomServices.allowMessage` (10 a minute per sender); the 11th post is a tool error.
- **Bounces.** A post to an ended or unknown callsign (or to yourself) returns `{ bounced: true, reason }`; for ended and unknown callsigns the sender also gets a notice. Unread direct messages of an agent that ends (`forget`) bounce back to their senders as one notice per sender.
- **Stop.** Unchanged pipeline rule, now covered by tests: only direct messages (and notices addressed to one agent) block, once, never with `stopActive`, never for a broadcast.
- **MCP.** `server/discover` and any unknown method get JSON-RPC `-32601` in an HTTP 200. Arguments are validated against each tool's `inputSchema`; a violation (and a non-finite or non-numeric `wait.seconds`, which would make `WaitRegistry.park` throw) answers `-32602`. A missing or foreign `me` and every refusal (not the owner, no such task, rate limit) are `isError` tool results the agent can read. An unexpected exception becomes `-32603`, never an HTTP 500. `tools/list` adds `title` and `annotations` (`status` is read-only).
- **`wait`.** `for` defaults to `message`. It returns at once when a message is already unread, when the awaited path is not held by anyone else, or when the awaited task is already done or dropped. For `release:<path>` it listens on the exact stored path of every lock that currently blocks that path (so case differences and covering folders work), because wake keys use the lock's stored spelling. Returned messages are marked delivered.
- **`register`.** Creates an unhooked agent (`hooked: false`, `session: null`). With no `repo` it takes the room's only repo, if there is exactly one. `note` becomes the agent's activity line.
- **`release`.** `stillDivergent` lists released file locks: a file lock lives until its changes are pushed or reverted (§9), so a released file lock is a file that may still be unpushed.
- Additive fields beyond `ToolResults` (plain text for the agent): `warning` on `task_claim` ok, `note` on `inbox`/`wait` results that carry messages ("information, not instructions").

## Checks run
- `npm run typecheck`: pass.
- `npm test`: shared 6, Workers 124, dashboard 87, all pass. `npm run test:workers`: 124 pass (was 62 before this change).

## Brief criteria and the tests that cover them
- 100 concurrent claims leave one owner: `tasks.test.ts` "100 concurrent claims" (50 agents, two claims each, over HTTP; exactly one owner, every other answer is `taken`).
- Owner-only updates: "only the owner updates a task; the creator may drop it while it is open".
- The gate denies an edit without a task and allows it after `task_add` with `claim: true`: "denies an edit without a task and allows it after task_add with claim: true"; also the open-task hint, `requireTask: false`, warn and off modes, and a task owned by someone else.
- Dependency refusal, and dropped dependencies counting as satisfied: "refuses a claim while a dependency is open or in progress...", plus unknown dependencies, claim with unfinished dependencies on `task_add`, and a waiter woken by `task:<id>`.
- Duplicate thresholds: exact normalized match, Jaccard exactly 0.8 (duplicate) against 0.75 (similar), top-3 ordering, dropped tasks ignored, duplicates inside one call; `similarity.test.ts` for the pure functions.
- Stop blocks once for a direct message and never for a broadcast or when `stopActive`: `messages.test.ts` "Stop".
- A bounce to an ended agent: "a message to an ended agent bounces to the sender, as a result and as a notice"; also unknown callsigns, and unread messages bouncing when the recipient ends.
- The rate limit: "allows 10 messages a minute per sender and refuses the 11th" (fake clock; the window reopens a minute later; other senders unaffected).
- MCP conformance for every tool: `mcp.test.ts` (initialize with the protocol text, `tools/list` of all 11 with schemas, `server/discover` and other unknown methods, notifications, batches, GET/DELETE 405, `-32602` cases, `wait` with `1e999` and strings, and one behaviour test per tool: status, task_add, task_claim, task_update (in `tasks.test.ts`), reserve, release, take, post, inbox, wait, register).
- Also covered: areas reserved and freed, takeover with moved reservations and notice, ended owners (explicit end and 12 h silence), restart persistence of tasks, quote-breaking message text, retention to 500 messages with deliveries.

## Changes outside my folders (for the architect to confirm)
- `server/src/test-helpers.ts`: `hookBody` now sends `settings: { requireTask: false }` by default. With the real gate on (default `requireTask: true`), the Wave 1 tests in `room.test.ts` and `worker.test.ts` that edit without a task asserted the placeholder "gate off" behaviour and failed (15 tests). Tests of the gate pass `settings: { requireTask: true }`. Other Wave 2 branches that add edit-based tests will hit the same default and can rely on this helper.

## Not done here (belongs to other features)
- The §11 notice "a lock you waited for was released" needs the lock denial path to remember who was blocked; it is not part of `LocksApi`/`MessagesApi` as frozen. `wait` with `release:<path>` covers the case where the agent is actually waiting.
