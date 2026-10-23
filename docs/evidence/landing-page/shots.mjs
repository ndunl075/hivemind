// Usage: node shots.mjs <site-url> <out-dir>   (e.g. http://localhost:8765/ docs/evidence/landing-page)
// Needs playwright (a repo devDependency); run from the repo root after `npm ci`.
import { chromium } from "playwright";
const [, , url, out] = process.argv;
const b = await chromium.launch();
const shots = [["desktop-1440", 1440, 900, "dark"], ["mobile-390", 390, 844, "dark"], ["desktop-1440-light", 1440, 900, "light"], ["mobile-320", 320, 640, "dark"]];
for (const [name, w, h, scheme] of shots) {
  const ctx = await b.newContext({ viewport: { width: w, height: h }, colorScheme: scheme, reducedMotion: "reduce" });
  const p = await ctx.newPage();
  const errs = [];
  p.on("console", m => m.type() === "error" && errs.push(m.text()));
  p.on("pageerror", e => errs.push(String(e)));
  await p.goto(url);
  await p.waitForLoadState("networkidle");
  const over = await p.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  const lines = await p.evaluate(() => { const h = document.getElementById("tagline"); return Math.round(h.getBoundingClientRect().height / parseFloat(getComputedStyle(h).lineHeight)); });
  console.log(name, "overflow:", over, "errors:", errs.length, "tagline lines:", lines);
  await p.screenshot({ path: `${out}/${name}.jpg`, type: "jpeg", quality: 55, fullPage: true });
  await ctx.close();
}
// Animation with motion on: pause stops it, play resumes, it finishes with 8 lines.
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
const p = await ctx.newPage();
await p.goto(url);
await p.evaluate(() => document.getElementById("stage").scrollIntoView());
await p.waitForTimeout(3000);
await p.click("#replay");
const n1 = await p.evaluate(() => document.querySelectorAll(".lines li.on").length);
await p.waitForTimeout(3500);
const n2 = await p.evaluate(() => document.querySelectorAll(".lines li.on").length);
console.log("paused:", n1 === n2, "button:", await p.textContent("#replay"));
await p.click("#replay");
await p.waitForTimeout(13000);
console.log("demo lines:", await p.evaluate(() => document.querySelectorAll(".lines li.on").length), "button:", await p.textContent("#replay"));
await p.screenshot({ path: `${out}/demo-1440.jpg`, type: "jpeg", quality: 55 });
// OS labelling
for (const [name, ua, tp] of [["windows", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120", 0], ["mac", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605", 0], ["iphone", "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)", 5], ["linux", "Mozilla/5.0 (X11; Linux x86_64) Chrome/120", 0]]) {
  const c = await b.newContext({ userAgent: ua, hasTouch: tp > 0 });
  await c.addInitScript(`Object.defineProperty(navigator, "maxTouchPoints", { get: () => ${tp} })`); // host may have a touch screen
  const q = await c.newPage();
  await q.goto(url);
  console.log("os", name, "->", await q.evaluate(() => document.getElementById("dl-main").textContent + " / " + document.getElementById("dl-alt").textContent + " / note hidden: " + document.getElementById("dl-note").hidden));
  await c.close();
}
await b.close();
