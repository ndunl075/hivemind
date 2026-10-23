# Landing page evidence

Static page in `site/` (HTML, CSS, JS, self-hosted Inter and Geist Mono). Not deployed.

## What was checked

Served `site/` over HTTP (`python -m http.server 8765 -d site`) and ran headless Playwright (Chromium) with `reducedMotion: reduce` for the full-page shots:

- Desktop 1440 and mobile 390, dark and light (`prefers-color-scheme`): no horizontal overflow (`scrollWidth - innerWidth = 0`), zero console errors.
- Download button reads "Download for Windows" under a Windows user agent and points at `.../releases/latest/download/hivemind-windows.zip`; the secondary link points at `hivemind-mac.zip`. The Mac branch is a platform check in `app.js` and was not exercised in a browser.
- Demo animation with motion enabled: scrolled into view, waited 14.5 s, all 8 steps shown (`demo-1440.png`). With reduced motion all steps appear at once.

Screenshots: `docs/evidence/landing-page/` (`desktop-1440.png`, `mobile-390.png`, `*-light.png`, `demo-1440.png`).

## Not verified

- Real Mac or iOS visitor labelling.
- Release asset links resolve only once the installer worker publishes a release.
- Opening `index.html` from `file://` logs a font CORS error from the preload; it does not occur over HTTP.
