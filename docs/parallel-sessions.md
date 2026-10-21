# Parallel sessions

Rules for every `[worker]` session building Hivemind. Briefs point here instead of repeating them. The architect owns this file.

## 1. Your role

If your brief starts with `[worker]`, you build exactly the task in your brief and stop at an open pull request. You never merge, never push to `main`, and never edit a file your brief doesn't give you.

## 2. Worktrees

Work in your own git worktree on your own branch, created from the latest `main`, then install dependencies there:

```sh
git fetch origin
git worktree add ../hivemind-<task> -b w/<task> origin/main
cd ../hivemind-<task>
npm ci
```

Don't work in the main checkout. When your PR is open, leave the worktree in place. The architect removes it after merging.

## 3. File ownership

- Edit only the files listed under "You own" in your brief. That always includes your own evidence file, `docs/evidence/<task>.md`.
- Architect-only files are listed in [ARCHITECTURE.md §20.2](../ARCHITECTURE.md#202-collision-rules). If you need a change in one of them (a contract field, a dependency, pipeline wiring, a CI step), don't make it. Write it under **Requests for the architect** in your PR description.
- `shared/contracts.ts` is frozen during a wave. Code against it as it is.
- If you find a bug outside your files, describe it in your PR description or file an issue. Don't fix it.

## 4. Deleting folders safely

On Windows, `node_modules` and worktrees can contain junctions or symlinks that point outside the folder. Before deleting any folder:

1. Prefer `git worktree remove <path>` for worktrees.
2. Otherwise remove links first, without following them: `cmd /c rmdir <link>` for a junction, `rm <link>` for a symlink.
3. Never run a recursive delete through a junction.

## 5. Exclusive resources

Some resources can only be used by one session at a time. Take the lock before using one, and release it as soon as you're done.

| Resource | Lock name | Used by |
|---|---|---|
| Real `claude` and `codex` sessions (they spend tokens and can read shared config) | `real-agents` | spike, skeleton manual check, smoke tests |
| Real user-level config: `~/.claude/settings.json`, `~/.claude.json`, `~/.codex/`, `~/.hivemind/` | `user-config` | any unavoidable write to these. Back the files up first and restore them after. Automated tests use temporary home folders instead. |

**Never change user-level hook or MCP config** to test something. Those changes would affect every Claude Code and Codex session on the machine, including the architect and other workers. Use project-level config in a throwaway folder instead.

Ports aren't locked: each brief assigns its own.

Locks live in a fixed folder in your home directory, shared by all sessions on the machine. A lock is a directory, and creating a directory either succeeds or fails, so only one session can hold it.

POSIX shell (Git Bash, macOS, Linux):

```sh
mkdir -p ~/.hivemind-dev/locks
mkdir ~/.hivemind-dev/locks/<lock name> && echo "<task> $(date -u +%FT%TZ)" > ~/.hivemind-dev/locks/<lock name>/owner
# ... use the resource ...
rm -r ~/.hivemind-dev/locks/<lock name>
```

PowerShell:

```powershell
New-Item -ItemType Directory -Force "$HOME\.hivemind-dev\locks" | Out-Null
New-Item -ItemType Directory "$HOME\.hivemind-dev\locks\<lock name>" -ErrorAction Stop | Out-Null
Set-Content "$HOME\.hivemind-dev\locks\<lock name>\owner" "<task> $((Get-Date).ToUniversalTime().ToString('o'))"
# ... use the resource ...
Remove-Item -Recurse "$HOME\.hivemind-dev\locks\<lock name>"
```

If the second command fails, the lock is held: wait and retry. Only take over a lock that's more than 30 minutes old and whose owning session is clearly gone, and say so in your evidence file.

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

- `npm run typecheck`, `npm test` and the commands in your brief pass. Paste the results into the PR description.
- **No secrets or personal data anywhere**: no real tokens, no `.dev.vars`, no real user config, no usernames, hostnames, emails, home paths or prompt text in fixtures, evidence or logs. Tests use obviously fake tokens such as `hm_a.test.nobody.1.AAAA`.
- Never commit throwaway files, even temporarily. Commits stay in public history.
- Commits are small and descriptive.

## 9. Review gate

- The architect sends every PR to a reviewer that has never seen your session, using the tiers in [ARCHITECTURE.md §20.4](../ARCHITECTURE.md#204-review-and-merge).
- When asked, fix all listed findings in one round and push. If you disagree with a finding, say why in one or two lines, with evidence.
- Only the architect merges.

## 10. Stop condition

Your PR is open against `main`, CI is green (or the failure is explained in the PR), tests pass locally, and `docs/evidence/<task>.md` is written. Then stop and report one line: the PR link and its status.
