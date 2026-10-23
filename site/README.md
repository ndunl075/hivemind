# Hivemind landing page

A plain static folder: HTML, CSS and a little JS. No build step, no framework, no CDN. Fonts (Inter, Geist Mono) are self-hosted in `fonts/`.

## Where it is served

The live page is https://www.usefrontierdigital.com/hivemind, served by the fdlanding repo. To publish a change, merge it here, then in fdlanding run `node scripts/sync-hivemind.mjs <copy of this folder> <commit>` on a `git archive` of `site/` at that commit, build, and merge there (Vercel deploys it). Asset references here must stay relative, because the sync rewrites them to `/hivemind/...`.

## Editing

- **Tagline:** the `<h1 id="tagline">` in `index.html`. It is the only place the headline lives.
- **Download links:** the `data-release` attribute in `index.html` holds the release URL (currently `v0.1.0-preview`); bump it for each release. The zips must be named `hivemind-windows.zip` and `hivemind-mac.zip`. With JS off, the buttons go to the releases page.
- **Setup guide:** the footer links to `docs/setup.md` on GitHub.
- **Dashboard image:** `dashboard.png` is a copy of `docs/evidence/dashboard/desktop-1440.png`; replace it when the dashboard changes.

## Preview locally

```sh
npx serve site
```

The page is dark only (`color-scheme: dark`) and respects `prefers-reduced-motion`.
