# Landing page evidence

Static page in `site/` (HTML, CSS, JS, self-hosted Inter and Geist Mono with their OFL licenses in `site/fonts/`). Not deployed.

## Commands

```sh
python -m http.server 8765 -d site          # serve the page (background)
node docs/evidence/landing-page/shots.mjs http://localhost:8765/ docs/evidence/landing-page
```

`shots.mjs` (headless Playwright, Chromium) is committed next to the screenshots.

## What was checked

- 1440, 390 and 320 wide, dark and light (`prefers-color-scheme`): no horizontal overflow, zero console errors. Final tagline: 2 lines at 1440, 4 at 390, 5 at 320.
- Demo with motion on: the Pause button stops it (line count stays put), Play resumes, it ends with 8 lines and a Replay button. With reduced motion all lines show at once and the button is hidden.
- Download labelling via spoofed user agents: Windows gives "Download for Windows" (Mac as the small link), Mac gives "Download for Mac", iPhone and Linux give both buttons with no primary plus a "Windows and Mac computers" note. Android, ChromeOS and iPadOS take the same branch by UA, but were not run.
- The dashboard image is the fixture demo room (sample data) and is described that way in its alt text.

Screenshots: `docs/evidence/landing-page/` (`desktop-1440.png`, `mobile-390.png`, `mobile-320.png`, `*-light.png`, `demo-1440.png`).

## Not verified

- A real Mac or phone browser.
- The release zip links 404 until the installer worker publishes a release.
- Opening `index.html` from `file://` logs a font CORS error from the preload; it does not occur over HTTP.
