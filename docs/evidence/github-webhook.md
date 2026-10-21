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
2. **Mapping by repository name.** The payload has no root commit. Agents report `repoName` (the `origin` URL's last segment). A push is matched to the single repo id whose agents report that name. No match or more than one repo: dropped (never guessed).
3. **Held for a grace period.** Pushed commits are queued in SQLite and delivered by `flushDue()` after the next request past `max(20s, 1.5 x heartbeat)`. An agent that pushed reports it on its next heartbeat, so by then the agent's own report exists and the webhook skips those files (same commit and branch). There are no alarms, so the flush piggybacks on requests, like the room's other housekeeping.
4. **Delivery through `PushesApi.record`** with a synthetic actor named `github:<login>` (letters, digits, `._-`; cannot equal an agent callsign, which has no colon). The webhook can only produce notices and `lastPush` rows.

## What is covered, and what is not

- Covered: `push` to a branch; files from `commits` and `head_commit` (added, modified, removed); merges done on github.com; fast-forward merges of a branch an agent already reported (announced again for the new branch name).
- Stale-copy checks: rows have an empty blob, so the hook's "same content" shortcut cannot apply; the check works through the commit (`after` in HEAD means no warning). A squash merge creates a commit the agent lacks until it pulls, which is the correct warning.
- Not covered: GitHub lists at most 20 commits per push, and a payload over 1 MiB is refused (413), so a very large push may name only some files. Repos whose agents' `origin` does not end in the GitHub repository name get nothing. A clone with no webhook configured is still invisible.

## How it was tested

- `server/src/features/github/github.test.ts` (Workers pool, 23 tests): secret derivation and signature verification (valid, invalid, missing, wrong algorithm, wrong secret, body modified after signing, other room's signature, uppercase hex); payload parsing (tags, deletes, empty, malformed, unsafe paths, 500-file cap, 20-commit flag, pusher label); admin create/rotate/off/delete-room (old URL and secret refused, generation never reused); ping; non-push events; oversized body; unknown/ghost room creates no Room; per-minute limit; daily budget counted; notice delivery after the grace period and `lastPush` content; dedupe in both orders; same commit on another branch still announced; replay ignored; no match and ambiguous names; text framing; no lock, task, setting or mode changes; a signature opens no other route.
- `cli/commands/webhook.test.mjs` (4 tests): output prints URL and secret once with the GitHub settings, admin secret never echoed, `--off`, bad room names, server error pass-through, help text.
- `npm run typecheck`, `npm test`: see the PR description for results.

## Not done / requests

- `server/wrangler.toml` `run_worker_first` does not list `/github/*`. Not required for correctness (a POST matches no asset, so the Worker is reached), but listing it avoids the asset lookup like the other API routes. Architect-owned.
- `ARCHITECTURE.md` §8.1 (route table) does not list the new routes; the brief limited edits to §12, §13, §17.
- Manual step on github.com: see the PR description.
