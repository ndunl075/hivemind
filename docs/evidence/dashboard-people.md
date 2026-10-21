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

## Review round 1
- Fixed: at phone width a focus switch (or any roster change with the same agent count) left cards unplaced; the grid is now recomputed whenever the roster changes. Regression tests in `dashboard/src/people.test.ts`.
- Checkout numbers follow the order this page first saw each checkout (kept for the page's lifetime), so expiry or a re-join never renumbers. After a page reload the order is rebuilt from the snapshot (earliest agent start, then id) and can differ from before the reload.
- Keyboard: "Show everyone" hands focus to the person's chip when it hides; "N ended" does the same if it hides while focused; Escape ignores events already handled; chip aria-labels no longer carry "Press to...".
- Tasks panel shows "N unowned tasks hidden" while focused; the top bar reads "Whole room: ..." while focused.
- Layout: message-edge changes no longer re-run the force layout; positions from the last everyone view are remembered across focus and clear; if cards still overlap the frame grows 20% at a time until they don't (`forceLayoutFit`).
- Labels (person, checkout, blocked file) are drawn in a layer above the cards. The blocked label can now sit over a card's text at 1366x768 where an edge crosses it.
- Tests added: focus A to B, no-checkout agents, single-checkout people, checkout re-join, Escape and keyboard focus, 30-card overlap and frame growth. The screenshot script also does a focus A to B switch and a clear, and fails on overlap or unplaced cards (15 cases, all clean).
- Round 2: finished layouts are cached by roster, frame and card size, so focus then clear restores every card exactly (test: two focus/clear cycles give identical transforms); the blocked-file label now has a pill behind it.
