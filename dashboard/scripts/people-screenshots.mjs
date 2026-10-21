// Screenshots of the big-team scenario for docs/evidence/dashboard-people/, plus a card-overlap check.
// Usage: npm run build && node dashboard/scripts/people-screenshots.mjs
// Serves dashboard/dist on port 5174; only page content is captured (no browser chrome, no URLs, no tokens).
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startStaticServer } from '../static-server.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '../../docs/evidence/dashboard-people');
mkdirSync(out, { recursive: true });
const server = await startStaticServer(join(here, '../dist'), 5174);
const browser = await chromium.launch();
const errors = [];
let failed = false;

const sizes = [
  ['1920x1080', { width: 1920, height: 1080 }],
  ['1366x768', { width: 1366, height: 768 }],
  ['375x812', { width: 375, height: 812 }],
];

/** Counts overlapping visible node cards (any pair whose rectangles intersect). */
const overlaps = () =>
  [...document.querySelectorAll('.node')].flatMap((a, i, all) =>
    all.slice(i + 1).filter((b) => {
      const r = a.getBoundingClientRect();
      const q = b.getBoundingClientRect();
      return r.left < q.right - 1 && q.left < r.right - 1 && r.top < q.bottom - 1 && q.top < r.bottom - 1;
    }).map((b) => `${a.dataset.callsign} / ${b.dataset.callsign}`),
  );

async function open(viewport) {
  const page = await browser.newPage({ viewport, deviceScaleFactor: 1 });
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('http://127.0.0.1:5174/r/demo?demo=team');
  await page.waitForSelector('.node');
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(1500);
  return page;
}

for (const [name, viewport] of sizes) {
  const page = await open(viewport);
  const narrow = viewport.width < 700;
  const shot = (file) => page.screenshot({ path: join(out, file), fullPage: true });
  const report = async (label) => {
    const o = await page.evaluate(overlaps);
    const nodes = await page.locator('.node').count();
    const wide = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
    console.log(`${name} ${label}: ${nodes} cards, overlaps: ${o.length ? o.join(', ') : 'none'}, horizontal scroll: ${wide}`);
    if (o.length || wide) failed = true;
  };
  await report('default');
  await shot(`big-team-${name}.png`);
  // Everything expanded: all ended agents drawn too.
  const ended = page.locator('.team-ended');
  for (let i = 0; i < (await ended.count()); i++) await ended.nth(i).click();
  await page.waitForTimeout(1200);
  await report('all ended shown');
  await shot(`big-team-${name}-all-shown.png`);
  for (let i = 0; i < (await ended.count()); i++) await ended.nth(i).click();
  // Focus one person.
  await page.locator('.team-main').nth(1).click();
  await page.waitForTimeout(1200);
  await report('focus');
  await shot(`big-team-${name}-focus.png`);
  // Switch focus straight from one person to another (same agent count), then clear.
  await page.locator('.team-main').nth(0).click();
  await page.waitForTimeout(1200);
  await report('focus switched');
  const unplaced = await page.evaluate(() => [...document.querySelectorAll('.node')].filter((n) => !n.style.transform).length);
  if (unplaced) {
    console.log(`${name}: ${unplaced} cards without a position after the switch`);
    failed = true;
  }
  await shot(`big-team-${name}-focus-switched.png`);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(1200);
  await report('focus cleared');
  await page.close();
}

console.log('console/page errors:', errors.length ? errors : 'none');
await browser.close();
server.close();
if (failed) process.exitCode = 1;
