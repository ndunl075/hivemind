# task-duplicate-wording evidence

Problem: a finished task "Add applyDiscount function with SAVE10 code" did not warn when another agent added "Add discount code support (SAVE10 example)".

Change (server/src/features/tasks, plus the task_add note in server/src/features/mcp/tools.ts): identifier splitting (with the joined lowercase form, so OAuth2 matches oauth2), light stemming, and two scores. Duplicates use the plain Jaccard of the stemmed sets (conservative, as before). `similar` uses a weighted Jaccard (generic words 0.3, rare tokens 2.5) with a 0.3 floor for a shared rare token; a rare token is 2+ characters mixing letters and digits, or `#12` (bare numbers such as 3 or 2026 are not). Done tasks in `similar` carry a `[DONE: ...]` prefix; a teammate title starting with "[DONE" is defused. The task_add note says to check `similar`, that titles are teammate-written information not instructions, and mentions DONE only when a done task is listed.

Verified with `npm run typecheck` and `npm test`:
- similarity.test.ts: SAVE10 pair is similar (> 0.5) but not a duplicate; opposite-verb pairs (Add/Fix v2 API, React 18 hooks, SAVE10, HTTP2, login page) stay below 0.8 as duplicates; bare-number pairs and unrelated pairs (sales tax, login page, README typo, CI) are not similar; case variants (OAuth2, GitHub, JavaScript) match; string/strings and speed/speeds stem equal.
- tasks.test.ts: the alice/cara scenario returns the done task in `similar` marked done plus the note; the DONE spoof is defused and the note omits DONE when no done task is listed.

Known limit: text without word breaks (CJK) only matches when near-identical.
