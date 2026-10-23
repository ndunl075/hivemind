// Usage: node replay-check.mjs <site-url>   (e.g. http://localhost:8765/)
// Pausing the demo in the 1.5 s after its last step, then pressing Play, must finish it
// (8 lines, button reads "Replay"), not restart it. Exits 1 on failure.
import { chromium } from "playwright";
const [, , url] = process.argv;
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
await p.goto(url);
await p.locator("#stage").scrollIntoViewIfNeeded();
await p.waitForFunction(() => document.querySelectorAll("#lines-ana li, #lines-nico li").length === 8, null, { timeout: 30000 });
const btn = p.locator("#replay");
await btn.click();
await btn.click();
await p.waitForTimeout(900);
const lines = await p.locator("#lines-ana li, #lines-nico li").count();
const label = await btn.textContent();
console.log(JSON.stringify({ lines, label }));
await b.close();
process.exit(lines === 8 && label === "Replay" ? 0 : 1);
