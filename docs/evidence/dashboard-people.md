# dashboard-people evidence

## What was built
- Team bar (`dashboard/src/views/team.ts`): per person live agents, tasks in progress, locks held; click/keyboard focus; Escape or "Show everyone" clears; per-person "N ended" expander.
- Pure logic in `dashboard/src/team.ts` (focus, ended collapse) and `model.ts` (`checkoutLabels`, `people`, `checkout`/`checkoutLabel` on agents, `actor` on activity).
- Graph: checkout clusters (dashed inner outline, "checkout 1/2" labels, clustered force layout), three card sizes by agent count, stage height grows with the team, deterministic grid layout at phone width, final overlap-settling pass in `forceLayout`.
- `?demo=team` scenario (`dashboard/src/live/bigTeam.ts`): 6 people, 2-3 checkouts each, 24 agents (8 ended).

## Tests
`npm run test:dashboard`: model/team tests for labels, summary counts, ended collapse, focus, clear, team bar behaviour, and no-overlap checks for both layouts at team size.
`node dashboard/scripts/people-screenshots.mjs` (after `npm run build`) opens the big-team scenario at 1920x1080, 1366x768 and 375x812, fails on any overlapping cards or horizontal scroll, and writes full-page screenshots (default, all ended shown, one person focused) to `docs/evidence/dashboard-people/`. Result: no overlaps in any of the 9 cases, no console errors.

## Not done / notes
- Person outlines are convex hulls, so a person with distant checkouts can have a large outline that overlaps a neighbour's outline (cards never overlap).
- At phone width the person name label can sit behind the first card; the team bar carries the names.
- Tasks without an owner are hidden while a person is focused.
