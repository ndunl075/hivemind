# Evidence: github-webhook (Phase 2 of ARCHITECTURE.md §12)

## What was built

An optional, per-room GitHub `push` webhook so pushes and merges that happen outside agent sessions (a person's own clone, a pull request merged on github.com) reach the room's agents.

- `server/src/features/github/`: `signature.ts` (secret derivation, constant-time HMAC check), `payload.ts` (pure parser of a push payload), `index.ts` (the feature: queue, dedupe, mapping, delivery through the existing `PushesApi`).
- `server/src/worker.ts`: `POST /github/<room>/<generation>` (verification before any Room wakes) and the admin action `POST /admin/rooms/<room>/webhook`.
- `server/src/room.ts`: wiring only (a `webhook` claim kind, `/github` and `/admin/webhook` routes, flushing held pushes after each request, carrying the webhook counter through a room delete).
- `shared/contracts.ts`: `AdminWebhookRequest` and `AdminWebhookResponse` (additions only).
- `cli/commands/admin.mjs`, `cli/hivemind.mjs`: `hivemind webhook <room> [--off]`.
- `ARCHITECTURE.md` §12, §13, §17.

## Design decisions worth reviewing

1. **The secret is derived, not stored.** `secret = HMAC-SHA256(TOKEN_SECRET, "hm_gh|<room>|<generation>")`; the Room stores only `webhook_generation` (and a never-decreasing `webhook_counter`). The brief suggested storing the secret in Room SQLite, but that forces the Worker to wake (and, for an unknown name, create and write to) a Durable Object before it can check a signature, which breaks the existing rule that bad requests and unknown rooms never wake a Room (§13). Deriving it keeps verification stateless, like room tokens, and nothing secret is stored or logged. The payload URL therefore carries the generation (`/github/<room>/<generation>`); rotating changes URL and secret together.
2. **Bound to one repository (review round).** `hivemind webhook` runs inside the project and sends the root commit id and GitHub `owner/name`; the Room stores the binding. Deliveries map only to that repo id and must carry the same `full_name`, so same-named repos can't cross over.
3. **Held for a grace period, then delivered by the Room's next requests** (no alarms): 1.5 heartbeats (slowest guard heartbeat while heartbeats are off), at most 20 held pushes per request, held pushes of one branch collapse, a push held over 24 h is dropped. The whole webhook push is dropped when an agent reported that commit on that branch; a row newer than the push (by `repository.pushed_at`, when GitHub got the push, capped at receive time) is never overwritten, including the same login's newer rows. The blob of an agent's row is inherited only when its commit is among the payload's commits (real merges); squash merges can't be linked and may warn the PR author once.
4. **Delivery through `PushesApi.record`** with a synthetic actor named `github:<login>` (letters, digits, `._-`; cannot equal an agent callsign, which has no colon). The webhook can only produce notices and `lastPush` rows.

## What is covered, and what is not

- Covered: `push` to a branch; files from `commits` and `head_commit` (added, modified, removed); merges done on github.com; fast-forward merges of a branch an agent already reported (announced again for the new branch name).
- Stale-copy checks: rows have an empty blob, so the hook's "same content" shortcut cannot apply; the check works through the commit (`after` in HEAD means no warning). A squash merge creates a commit the agent lacks until it pulls, which is the correct warning.
- Not covered: GitHub lists at most 20 commits per push (a second notice says so), and a payload over 1 MiB is refused (413). A clone with no webhook configured is still invisible. `PushesApi.record` takes no timestamp, so a push delivered after a long idle spell is stamped with the delivery time (needs a change in `features/git`, not mine).

## How it was tested

- `server/src/features/github/github.test.ts` (Workers pool, 33 tests): signature checks, payload parsing, admin create/rotate/off/delete-room (binding required and validated), ping, non-push, oversized, form-encoded, ghost room wakes no Room, cost control (stale generation costs nothing; 100 mixed deliveries give 90 429s and 10 counted; daily cap; mode unchanged; grace with heartbeats off), notices and `lastPush`, dedupe both orders, whole-push drop, late redelivery never overwrites a newer row, squash keeps the author's blob, A to B to A, repeat ignored, bound repo only, framing, no lock/task/setting changes, backlog flush bounded per request, collapse, 24 h drop, 20-commit notice and stale-commit ignore.
- `cli/commands/webhook.test.mjs` (7 tests): binds to the project repo (root commit, owner/name from origin or `--repo`), prints URL and secret once with the GitHub settings, admin secret never echoed, refuses outside a repo or without owner/name, `--off` works anywhere, bad room names, server error pass-through, help text.
- `npm run typecheck`, `npm test`: see the PR description for results.

## Not done / requests

- Manual step on github.com: see the PR description.
