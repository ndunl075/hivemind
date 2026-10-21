// Screenshots + accessibility probes for docs/evidence/dashboard.md.
// Usage: npm run build && node dashboard/scripts/screenshots.mjs
// Serves dashboard/dist on port 5173 with the same headers as _headers (including the CSP), so CSP violations show up.
import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, '../dist');
const out = join(here, '../../docs/evidence/dashboard');
mkdirSync(out, { recursive: true });

const headersText = readFileSync(join(dist, '_headers'), 'utf8');
const globalHeaders = Object.fromEntries(
  headersText
    .split(/\r?\n\r?\n/)[0]
    .split(/\r?\n/)
    .slice(1)
    .map((l) => l.trim().split(/:\s(.*)/s).slice(0, 2)),
);
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  let file = join(dist, url.pathname);
  if (!existsSync(file) || url.pathname.endsWith('/')) file = join(dist, 'index.html');
  res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream', ...globalHeaders });
  res.end(readFileSync(file));
});
await new Promise((r) => server.listen(5173, '127.0.0.1', r));

const browser = await chromium.launch();
const report = {};
const violations = [];

async function shoot(name, viewport, path, extra) {
  const page = await browser.newPage({ viewport, deviceScaleFactor: 2 });
  page.on('console', (m) => {
    if (m.type() === 'error') violations.push(`${name}: ${m.text()}`);
  });
  page.on('pageerror', (e) => violations.push(`${name}: ${e.message}`));
  await page.goto(`http://127.0.0.1:5173${path}`);
  await page.waitForSelector('.node');
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(900);
  if (extra) await extra(page);
  await page.screenshot({ path: join(out, `${name}.png`), fullPage: viewport.width < 700 });
  return page;
}

const desktop = await shoot('desktop-1440', { width: 1440, height: 900 }, '/r/demo');
// Let a pulse run, then capture the animated state.
await desktop.waitForTimeout(4500);
await desktop.screenshot({ path: join(out, 'desktop-1440-pulse.png') });

// Keyboard focus: tab to the first node and to a panel, and record the computed outline.
await desktop.keyboard.press('Tab');
const focus = [];
for (let i = 0; i < 8; i++) {
  const info = await desktop.evaluate(() => {
    const el = document.activeElement;
    if (!el || el === document.body) return null;
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return { tag: el.tagName.toLowerCase(), cls: el.className.toString().split(' ')[0], label: el.getAttribute('aria-label'), outline: `${cs.outlineWidth} ${cs.outlineStyle} ${cs.outlineColor}`, offset: cs.outlineOffset, visible: r.width > 0 && r.height > 0 };
  });
  if (info) focus.push(info);
  if (i === 1) await desktop.screenshot({ path: join(out, 'desktop-1440-focus.png') });
  await desktop.keyboard.press('Tab');
}
report.focus = focus;
report.csp = await desktop.evaluate(() => document.querySelectorAll('[style]').length);
await desktop.close();

await shoot('mobile-390', { width: 390, height: 844 }, '/r/demo');
await shoot('desktop-1440-prompt', { width: 1440, height: 900 }, '/r/demo?demo=prompt');
const offline = await shoot('desktop-1440-reconnecting', { width: 1440, height: 900 }, '/r/demo?demo=offline', (p) => p.waitForSelector('[data-banner="reconnect"]', { timeout: 15000 }));
await offline.close();

// Warn mode banner shot is covered by unit tests; the page itself shows the not-enforced banner in the main shot.
console.log(JSON.stringify(report, null, 2));
console.log('console/page errors:', violations.length ? violations : 'none');
await browser.close();
server.close();
