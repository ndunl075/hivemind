# Stale-check test budget

Problem: `staleWarnings` (cli/hook/git.mjs) raced its Git work against a fixed 0.9 s timer, with 0.6 s per Git command. On a slow Windows CI runner the timer could win and the function silently returned fewer lines, so "stale-copy check > an unknown commit: fetch and pull first" failed once.

Change:
- `staleWarnings` takes `options.budgetMs` and honours the test-only env var `HIVEMIND_GIT_BUDGET_MS` (same convention as `state()`). The option wins over the env var. A budget replaces the 0.9 s total limit and raises the per-command limit to at least the budget. With neither set, behaviour is unchanged.
- `hook.mjs` caps the stale check at 1 s; that cap now also honours `HIVEMIND_GIT_BUDGET_MS` (still bounded by the hook's overall deadline).
- `git.world.test.mjs` wraps `staleWarnings` so every call gets a 60 s budget; the real-Git test in `git.test.mjs` passes one too.
- Scan of `cli/hook/*.test.mjs` for other fixed production caps: hook tests that expect stale warnings stub `git.mjs`, so they do not run Git. `hook.push.test.mjs` already sets `HIVEMIND_GIT_BUDGET_MS`. No other change needed.

New tests (cli/hook/git.test.mjs, "staleWarnings time budget"): an exec stub that takes 1.2 s per command yields no warning by default, and yields the warning with `budgetMs: 10000` or with the env var; an explicit small `budgetMs` overrides the env var.

Results: `npm run typecheck` clean; `npm test` all pass (342 + 218 + 113 tests).
