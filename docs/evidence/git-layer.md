# Evidence: git-layer (Wave 2, W5)

ARCHITECTURE.md §12 completely (`cli/hook/git.mjs`), the push side of the server (`server/src/features/git/`), and §9 rules 4, 5, 9, 10 and 12 plus the "a lock you waited for was released" notice (`server/src/features/locks/`). `LocksApi` and `PushesApi` are unchanged; every existing test passes.

## What was built

| Path | What it is |
|---|---|
| `cli/hook/git.mjs` | `GitModule` plus `refs()`. Comparison point, divergent files (500 cap), push detection with blob SHAs, the stale-copy check. Every Git call goes through one wrapper with `GIT_OPTIONAL_LOCKS=0`; only read-only commands are used. |
| `cli/hook/git.test.mjs`, `cli/hook/git.world.test.mjs` | The old basic tests, and scripted worlds: a bare "remote", the agent's clone and a teammate's clone in temporary folders. |
| `server/src/features/git/index.ts` | `createPushes` (also exported as `createGit`): the latest push per file, the push notice, `lastPush`. |
| `server/src/features/git/notice.ts` | The notice text. |
| `server/src/features/locks/index.ts` | Rules 4, 5, 9, 10, 12 and the released-lock notice, on top of the existing rules. |
| `server/src/features/locks/glob.ts` | The built-in glob matcher (no dependency, no regular expressions). |
| `server/src/features/locks/denial.ts` | Teammate-written task titles and paths framed as quoted, single-line data. |

## git.mjs

- **Comparison point**, in order: the configured upstream (`@{u}`); a remote-tracking branch with the branch's name on any remote (`origin` first); the merge base with the remote's default branch (`refs/remotes/<remote>/HEAD`, else `main`, else `master`). No remote and no upstream means no comparison point: only the working tree counts (the alternative, "every commit since the root", would never release).
- **Divergent files** = `git status --porcelain=v1 -z --untracked-files=all` union `git diff --name-only -z --no-renames <comparison sha>...HEAD`, sorted, capped at 500 (`truncated`). Renames count on both sides. `upstream` in the report is the comparison point's name.
- **Push detection** (needs the previous memory): the comparison point's SHA moved, `HEAD` is now an ancestor of it, and a file is reported when it was in the previous divergent set and differs between the old comparison point and `HEAD` (`git diff --raw`, which also yields the blob SHAs; a deleted file carries the all-zero SHA). The reported branch is the remote branch that moved, the SHA is `HEAD`. The memory also carries the branch, so a branch switch (which moves the comparison point) is never a push. Fetch alone leaves `HEAD` outside the comparison point, so it is not a push; after a fetch followed by a rebase or merge and a push, only the agent's own earlier divergent files are reported.
- **Stale-copy check** (`staleWarnings`): returns bare sentences (the hook adds the header). Nothing when the pushed commit is an ancestor of `HEAD`, or when the pushed blob equals the working-copy blob (`git hash-object --path`) or `HEAD:<path>` (this is the squash/rebase case, checked before "unknown commit"). Otherwise: unknown commit gives "Fetch and pull first."; same branch gives "Pull first."; another branch gives "was changed on `<branch>` by ... Expect a conflict when these branches meet. Coordinate before editing." A pushed deletion warns only while the file still exists locally. At most five files are checked (the rest are summarised), each Git call is limited to 0.6 s and the whole check to 0.9 s, and it never throws. Callsigns, branches and paths are reduced to `[\w./@+-]` because they are teammate-written text that lands in the agent's context.
- A typical `state()` takes about 50 ms here (seven or eight small Git processes, five in parallel).

## Server

- **Pushes:** `record` stores the latest push per path (case-insensitive, 24 h), drops a repeat of the same agent, commit and blobs (a hook whose first answer was lost reports twice), emits the `push` event with its pulse, and sends **one** notice to every active agent in the repo except the pusher and the agents in the pusher's checkout (they share the working copy): `claude-ana pushed main (4 files: a, b, c, …). Pull before editing those.` Branch and paths are cleaned to one line. `latest` is unchanged in behaviour, so `lastPush` in `/hook` responses comes from the pipeline as before.
- **Rule 9 (advisory):** never denied and never locked. An edit gets a heads-up when an agent in a *different* checkout has the file divergent (from its last report) or edited it since. Same-checkout agents don't count.
- **Rule 10 (ignored):** never locked, never denied, never attributed; `.git/` stays always ignored.
- **Rule 4 (shell edits):** on a report with `shellSinceHeartbeat`, a new divergent file (not in this agent's previous report, not in its SessionStart baseline, not ignored or advisory) that nobody holds (no file lock, no folder lock over it) gets a file lock for the reporter. "With no clear author, it's locked for nobody": another active agent in the same checkout reported a shell command since this agent's previous report; or more than 50 new files at once (generated output); or the report was truncated; or there is no baseline or no previous report (after a Room restart the first report only re-learns). The baseline is stored (`agent_baselines`), so a restart doesn't lose it. A divergent file held by an agent in a different checkout sends a conflict notice to both agents (once; again only after it went away), and a `lock.conflict` event with a `blocked` edge that is redrawn every 90 s while it lasts. Files in the reporter's baseline never produce a notice.
- **Rule 5 (checkout-mates):** same-checkout agents never conflict with each other in rule 4, and a report from any agent of a lock's checkout releases it (rule 3). Edits are still one holder (rule 2).
- **Rule 12 (branches):** lock keys carry no branch, so a lock covers the file on every branch; a push of any branch makes the file non-divergent in the pusher's checkout and releases the lock. Tested across `main`, `feature/auth` and a pushed `wip` branch.
- **"A lock you waited for was released":** a denial remembers (lock, agent): at most 10 agents per lock, 200 locks, two hours. When the lock is released by any route (a push, `release`, a revert, a task finishing, an emergency unlock, the holder ending), the denied agents that are still active get one notice, except the releaser.
- **Denial text:** task titles are quoted with `"` turned into `'` and whitespace collapsed (same style as `briefing.ts`), and paths are single-line.

## Tests

`npm run test:hook` (4 files, 153 tests) and `npm run test:workers` (16 files, 189 tests), `npm run typecheck`, and `npm test` all pass.

`cli/hook/git.world.test.mjs` (scripted repos, `GIT_CONFIG_GLOBAL` and the system config isolated):

- unpushed commits, staged and untracked files; no upstream and no remote; a new branch against the default branch while the default branch moved on; a same-named remote branch beating the default branch; a configured upstream first; fetched-but-not-pulled commits not counted; the 500 cap; renames and deletions;
- a push to a same-named remote branch (no `-u`) from the shell, with exact branch, SHA and blob SHAs, reported once; a push around uncommitted work; a push from another worktree of the checkout ("outside the agent"); a fetch alone (no push), then rebase and push, and a merge between two heartbeats (only the agent's file); a revert, a stash and a reset (divergent empties, `pushed` stays null); a branch switch; a pushed deletion;
- stale copies: unknown commit, same branch, other branch, commit already in `HEAD`, squash merge with the feature commit never fetched (no warning), same content uncommitted, a pushed deletion, old pushes, bad input, hostile text, and the five-file cap.

`server/src/features/locks/locks.test.ts`, `glob.test.ts`, `denial.test.ts` and `server/src/features/git/git.test.ts` cover every rule and notice above: ignored and advisory paths (defaults at any depth, project patterns, same-checkout mates), shell attribution with and without a baseline, held files, folder reservations, ambiguity, bulk output, truncation, a Room restart; conflicts across checkouts (notice once, edge redraw, announce again, baseline, folder locks, warn mode, mates); the waiter notices (once, release, unlock, two-hour expiry, the ten-agent bound); the push notice (recipients, framing, repeats, the event); `lastPush` (own pushes, several files, 24 h, replacement, restart and cleanup). The glob tests include patterns that would take minutes with a regular expression.

## Known limits

- **Wiring:** the Room builds `features.pushes` from this feature (architect follow-up PR #17); the basic `features/pushes` is gone, and these tests run on the Room's real wiring.
- Push detection follows §12 literally. If a branch's configured upstream is a different branch than the one pushed (a branch created from `origin/main` with tracking, pushed with `git push origin HEAD` to `origin/feature`), the comparison point stays `origin/main` and neither a push nor a release is seen. A `stash`, `pull` (touching a file the agent also changed) and `stash pop` between two heartbeats looks like a push of that file.
- Shell attribution is a heuristic by design: two agents in one checkout whose shell reports straddle a heartbeat can be attributed in report order.
- `git status --untracked-files=all` on a huge untracked tree is the slowest call; it is bounded by the hook's own time budget.

## Environment note

While this was being built the machine's system drive was completely full (a large download from another program), so Workers-pool runs failed with `SQLITE_FULL` and `npm` could not write its logs. To keep working, a few unneeded packages in this worktree's own `node_modules` (`@img/*`, `playwright-core`, `@playwright/*`) were deleted and a reserve file was held and released around test runs; nothing outside the worktree was touched. The final runs listed above passed in that setup. `npm ci` restores the packages.

## Review round (Tier 2)

- **Incomplete is never complete:** `state()` marks the report `truncated` when there is no comparison point (no remote or default branch), a comparison-point lookup fails, or the committed diff fails (tested with a shallow clone). It takes a time budget (default 1.2 s, `budgetMs`); on a timeout the report is status-only and truncated, the previous memory is kept, and children are killed (SIGKILL on timeout). The merge base is cached per (HEAD, target) in the memory.
- **Push detection:** the memory keeps the previous HEAD. A push needs the previous HEAD to be an ancestor of HEAD (else a file only counts when its content is unchanged since, which keeps rebases working), and files still dirty are dropped. The branch-name guard is gone, so `checkout -b feat && push -u origin feat` is seen. Tests: stash/pull/pop, fetch plus `reset --hard`, still-dirty file, new branch pushed.
- **Git env and hashing:** `GIT_NO_LAZY_FETCH=1`, `GIT_TERMINAL_PROMPT=0`, `GCM_INTERACTIVE=never`; `--end-of-options` before refnames; `hash-object` runs only for a dirty file whose HEAD blob differs from the pushed blob, and never above 2 MB. Stale paths reject absolute, drive, UNC, backslash, `..` and control characters; paths with spaces are quoted, not mangled.
- **Globs:** `**` runs collapse, at most 8 `**` and 32 segments per pattern, paths matched by their first 64 segments, matching is a greedy single-backtrack-point walk (linear in segments times pattern segments), and settings patterns are matched once per path in `applyGitState`. Test: 100 hostile patterns x 500 deep paths under 200 ms.
- **Locks:** a mate that has not reported since the agent's previous report (or ran a shell command) makes authorship ambiguous. A baseline file held by another checkout still raises a conflict; files only inside a folder reservation get "inside a folder reserved by X" wording.
- **Pushes:** at most 2,000 rows per repo (oldest dropped), 6 notices per agent per minute (pushes are always recorded), ended agents are no longer listed in the exclusions, a retried older report cannot replace a newer push.
- **Framing:** paths in notices, denials and the warn-mode note are bare when plain and otherwise quoted with controls removed and `"` turned into `'`; the `release:"..."` wait key is escaped.
