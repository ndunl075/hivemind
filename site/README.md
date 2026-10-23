# Hivemind landing page

A plain static folder: HTML, CSS and a little JS. No build step, no framework, no CDN. Fonts (Inter, Geist Mono) are self-hosted in `fonts/`.

## Cloudflare Pages settings

| Setting | Value |
|---|---|
| Framework preset | None |
| Build command | *(leave empty)* |
| Build output directory | `site` |
| Root directory | `/` (repo root) |

Nothing is deployed from this PR. Deploy only after the page has been approved.

## Editing

- **Tagline:** the `<h1 id="tagline">` in `index.html`. It is the only place the headline lives.
- **Download links:** `app.js` (`base`) and the `href`s in the footer of `index.html` (used when JS is off). They point at the `hivemind-windows.zip` and `hivemind-mac.zip` assets of the latest GitHub release.
- **Setup guide:** the footer link `#setup` is a placeholder.
- **Dashboard image:** `dashboard.png` is a copy of `docs/evidence/dashboard/desktop-1440.png`; replace it when the dashboard changes.

## Preview locally

```sh
npx serve site
```

The page follows `prefers-color-scheme` (dark is the default look) and `prefers-reduced-motion`.
