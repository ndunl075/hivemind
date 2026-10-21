# Evidence: dashboard (W3)

View-only live hive dashboard on fixture data, per ARCHITECTURE.md §14. Source in `dashboard/src/`; data isolated in `dashboard/src/live/` (`fake.ts` serves `shared/fixtures/snapshot.json` moved to the present, plus a scripted pulse stream; W7 swaps `live/index.ts`).

## Screenshots (Playwright, Chromium, served with the real `_headers` CSP)

Regenerate with `npm run build && node dashboard/scripts/screenshots.mjs`.

- 1440 px: [desktop-1440.png](dashboard/desktop-1440.png)
- 390 px: [mobile-390.png](dashboard/mobile-390.png)
- A pulse in flight: [desktop-1440-pulse.png](dashboard/desktop-1440-pulse.png)
- Keyboard focus on a node: [desktop-1440-focus.png](dashboard/desktop-1440-focus.png)
- Token prompt (`?demo=prompt`): [desktop-1440-prompt.png](dashboard/desktop-1440-prompt.png)
- Reconnect banner after 10 s offline (`?demo=offline`): [desktop-1440-reconnecting.png](dashboard/desktop-1440-reconnecting.png)

The script also records console and page errors: none, with the CSP (`default-src 'none'; script-src/style-src/font-src/img-src/connect-src 'self'`) enforced. Layout styles are set through the CSSOM, so no inline `style` attributes are needed.

## Checks

- `npm run test:dashboard`: 87 tests pass. They cover:
  - layout logic: force layout (inside the frame, no overlap, deterministic, person grouping, stability when a node is added, phone width), ring fallback, hull, edge geometry;
  - state display: every state label from `shared/state.ts`, hiding ended agents after 24 h, edge expiry (message 60 s, blocked 2 min), banners (mode, not enforced, outage), panels, usage levels, reconnect banner timing;
  - text escaping: a task title, note, branch, activity, lock path, activity text and edge label containing `<img src=x onerror=...>` render as text (no `img` created, no `onerror` attribute, handler never runs); a source scan forbids `innerHTML`-style sinks;
  - token handling and prompt, and the fake source.
- `npm run typecheck`, `npm run build`: pass. Build output: `dashboard/dist` with `app.js`, `app.css`, `_headers`, `logo.svg`, `favicon.svg` (copied read-only from `assets/`) and self-hosted `fonts/` (Inter variable, Geist Mono 400 and 500).

## Contrast (WCAG, computed from `styles.css` tokens by `src/contrast.test.ts`)

All text colors clear 4.5:1 on every surface they sit on:

| Text | on #0E0E10 | on #161618 | on #1C1C1F |
|---|---|---|---|
| primary #F4F4F6 | 17.56 | 16.45 | 15.48 |
| secondary #B9BFC8 | 10.42 | 9.77 | 9.19 |
| muted #8E8EA0 (lowest) | 5.99 | 5.62 | 5.28 |
| lavender #A99BFF | 8.10 | 7.59 | 7.14 |
| amber #E8B45A | 10.20 | 9.56 | 8.99 |
| red #F2716B | 6.75 | 6.32 | 5.95 |

Button label (#0E0E10 on lavender): 8.10. Body text (primary and secondary) is 9:1 or better.

## Keyboard focus

`:focus-visible` draws a 2 px lavender outline (8.10:1 against the page) with a 2 px offset. Playwright tabbed through the page: every graph node (`tabindex=0`, with an `aria-label` summarizing callsign, person and state) and the three scrollable panels (`tabindex=0`, labelled regions) reported computed `outline: 2px solid rgb(169, 155, 255)`, offset 2 px, and a visible box. See the focus screenshot. The token prompt focuses its input when shown.

## Notes

- `prefers-reduced-motion` turns off all animation; pulses then flash a node border instead of travelling dots, and working nodes keep a static ring.
- `dashboard/tsconfig.json` now lists `"types": ["node"]` so tests can read files (own file).
- The token prompt is wired but the fake source does not need a token (`sourceNeedsToken = false` in `live/index.ts`); W7 should flip it.

## Review round 1

- Token prompt: the page behind is `inert` while it is open, Tab is trapped inside, focus returns on close, Escape closes the preview prompt only (a required token cannot be skipped).
- Activity panel rebuilds only when the set of items changes; ages update in place.
- A visually hidden live list (`aria-live=polite`) describes the current edges, e.g. "claude-nico-2 blocked from login.ts, held by codex-ana".
- `parseMessage` validates every list element and drops bad ones; optional fields are normalized.
- Fonts are cached for a day (no `immutable`, filenames are not hashed). `build.mjs --serve` now serves with the `_headers` CSP and a single-page-app fallback (`dashboard/static-server.mjs`).
- Graph measuring is skipped unless the width or agent count changed.
- New tests: CSP directives in `_headers`, built `index.html`/CSS/JS reference only same-origin assets, dev-server fallback, reduced-motion pulse, focus handling, validation.
- Person labels are drawn in a layer above the edges with a background halo.
