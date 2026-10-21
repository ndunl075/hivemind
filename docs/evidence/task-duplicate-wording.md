# task-duplicate-wording evidence

Problem: a finished task "Add applyDiscount function with SAVE10 code" did not warn when another agent added "Add discount code support (SAVE10 example)" (plain Jaccard 0.25, below the similar floor in practice because of identifier and stemming mismatches).

Change (server/src/features/tasks): identifier splitting, light stemming, weighted Jaccard (generic words 0.3, digit tokens 2.5), a similar floor for a shared rare token, and a `[DONE: ...]` prefix on finished tasks in `similar`.

Verified with `npm run typecheck` and `npm test` (all green):
- similarity.test.ts: stemming and identifier splitting; the SAVE10 pair scores between 0.5 and 0.8 (similar, not duplicate); plural/tense variants are duplicates; unrelated pairs (sales tax, login page, README typo, CI) stay under 0.2.
- tasks.test.ts: the alice/cara scenario returns the done task in `similar` marked done, and "Add sales tax to invoice total()" matches only the sales tax task, not the discount one.

Not done (outside owned files): the task_add answer text. See PR "Requests for the architect".
