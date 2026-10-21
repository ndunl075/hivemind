# Evidence: dashboard layout with empty banners

**Cause.** `#app` is a 4-row grid (`auto auto minmax(0,1fr) auto`) for topbar, banners, main, footer. An empty `.banners` is `display: none`, so it left the grid and every later child moved up a row: `main` got the second `auto` row and the footer got the `1fr` row (a tall empty footer, graph squashed to ~420px).

**Fix.** `dashboard/src/styles.css`: pin topbar, banners, main and footer to grid rows 1 to 4. A hidden banner strip now leaves its row empty (zero height) instead of shifting the others.

**Verified** with Playwright against `npm run dev:dashboard` (fake data, `?demo=1`). "No banner" = the `.banners` element emptied, the state the app produces when nothing alerts. Screenshots in `docs/evidence/dashboard-layout/` (`before-*` and `after-*`, page content only).

Heights in px (`.main` / `.footer`):

| Viewport | Banner, before | Banner, after | No banner, before | No banner, after |
|---|---|---|---|---|
| 1920x1080 | 953 / 38 | 953 / 38 | 420 / 607 | 989 / 38 |
| 1366x768 | 641 / 38 | 641 / 38 | 420 / 295 | 677 / 38 |
| 375x812 | 1734 / 91 | 1734 / 91 | 1734 / 91 | 1734 / 91 |

At 375px the layout is block (graph on top, panels below) and was never affected; `scrollWidth` equals `clientWidth` (375) in every case, so no horizontal scroll.

**Test.** happy-dom does no layout, so `dashboard/src/styles-layout.test.ts` checks the CSS rule (each region pinned to its row, empty banners collapsed). Real layout was checked by the screenshots above.
