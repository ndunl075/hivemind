# Parallel sessions

Rules for every `[worker]` session building Hivemind. Briefs point here instead of repeating them. The architect owns this file.

## 1. Your role

If your brief starts with `[worker]`, you build exactly the task in your brief and stop at an open pull request. You never merge, never push to `main`, and never edit a file your brief doesn't give you.

## 2. Worktrees

Work in your own git worktree on your own branch, created from the latest `main`:

```sh
git fetch origin
git worktree add ../hivemind-<task> -b w/<task> origin/main
```

Don't work in the main checkout. When you're finished and your PR is open, leave the worktree in place. The architect removes it after merging.

## 3. File ownership

- Edit only the files listed under "You own" in your brief.
- These are architect-only: `shared/contracts.ts`, the root `package.json` and lockfile, `.github/`, and this file. If you need a change in one of them (a contract field, a dependency, a CI step), don't make it. Write it under **Requests for the architect** in your PR description.
- `shared/contracts.ts` is frozen during a wave. Code against it as it is.

## 4. Deleting folders safely

On Windows, `node_modules` and worktrees can contain junctions or symlinks that point outside the folder. Before deleting any folder:

1. Prefer `git worktree remove <path>` for worktrees.
2. Otherwise remove links first, without following them: `cmd /c rmdir <link>` for a junction, `rm <link>` for a symlink.
3. Never run a recursive delete through a junction.

## 5. Exclusive resources

Some resources can only be used by one session at a time. Take the lock before using one, and release it as soon as you're done.

| Resource | Lock name | Used by |
|---|---|---|
| Real `claude` and `codex` sessions (they spend tokens and share user config) | `real-agents` | spike, smoke tests |
| Real user-level config: `~/.claude.json`, `~/.codex/`, `~/.hivemind/` | `user-config` | manual CLI checks only. Automated tests use a temporary `HOME`. |
| Ports | not locked: each brief assigns its own (W5 uses 8787, W7 uses 8788) | |

To take a lock, create a directory atomically. That fails if someone else already holds it:

```sh
mkdir "$TMPDIR/hivemind-locks/<lock name>" && echo "<task> $(date -u +%FT%TZ)" > "$TMPDIR/hivemind-locks/<lock name>/owner"
```

On Windows, use `%TEMP%` in place of `$TMPDIR`. If the lock is held, wait and retry. Only take over a lock that's more than 30 minutes old and whose owning session is clearly gone, and say so in your evidence file. Release with `rm -r "$TMPDIR/hivemind-locks/<lock name>"`.

## 6. Evidence and notes

- Write what you verified, and how, to `docs/evidence/<task>.md`. Each task gets its own file. Never append to a shared file.
- Your PR description summarizes the evidence and links to it.

## 7. Keeping your PR current

If `main` moves while your PR is open, merge it in:

```sh
git fetch origin
git merge origin/main
```

Never rebase and force-push an open PR. Reviews are tied to exact commits.

## 8. Before opening the PR

- `npm run typecheck` and `npm test` pass, along with the commands in your brief. Paste the results into the PR description.
- No secrets anywhere: no real tokens, no `.dev.vars`, no real user config. Tests use obviously fake tokens such as `hm_a_test_0000`.
- Commits are small and descriptive.

## 9. Review gate

- The architect sends every PR to a reviewer that has never seen your session, using the tiers in [ARCHITECTURE.md §20.4](../ARCHITECTURE.md#204-review-and-merge).
- When asked, fix all listed findings in one round and push. If you disagree with a finding, say why in one or two lines, with evidence. Don't argue in circles.
- Only the architect merges.

## 10. Stop condition

Your PR is open against `main`, CI is green (or the failure is explained in the PR), tests pass locally, and `docs/evidence/<task>.md` is written. Then stop and report one line: the PR link and its status.
