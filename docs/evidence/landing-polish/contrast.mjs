// Usage: node contrast.mjs <site-url>   (needs playwright; run from the repo root)
// Hides every text glyph, screenshots the page, samples the background under each text box,
// and reports the worst WCAG contrast of the real text color against those pixels.
import { chromium } from "playwright";
const [, , url] = process.argv;
const b = await chromium.launch();
for (const [w, h, scheme] of [[1920, 1080, "dark"], [1440, 900, "dark"], [390, 844, "dark"]]) {
  const p = await b.newPage({ viewport: { width: w, height: h }, colorScheme: scheme, reducedMotion: "reduce" });
  await p.goto(url); await p.waitForLoadState("networkidle");
  const sel = [["tagline", "#tagline"], ["hero label", ".hero .label"], ["Download link", ".toplink"], ["brand name", ".brand span"], ["Get Hivemind", ".hero .pill"]];
  const boxes = await p.evaluate(sel => sel.map(([n, s]) => { const e = document.querySelector(s), r = e.getBoundingClientRect(), c = getComputedStyle(e).color; return [n, r.x, r.y, r.width, r.height, c, parseFloat(getComputedStyle(e).fontSize), getComputedStyle(e).fontWeight]; }), sel);
  await p.addStyleTag({ content: "h1,.hero .label,.toplink,.brand span,.hero .pill{color:transparent!important;text-shadow:none!important;transition:none!important}.w{opacity:1!important;filter:none!important}h1{filter:none!important}" });
  const png = (await p.screenshot()).toString("base64");
  const res = await p.evaluate(async ([png, boxes]) => {
    const img = new Image(); img.src = "data:image/png;base64," + png; await img.decode();
    const cv = document.createElement("canvas"); cv.width = img.width; cv.height = img.height; const cx = cv.getContext("2d"); cx.drawImage(img, 0, 0);
    const lum = ([r, g, b]) => { const f = v => { v /= 255; return v <= .03928 ? v / 12.92 : Math.pow((v + .055) / 1.055, 2.4); }; return .2126 * f(r) + .7152 * f(g) + .0722 * f(b); };
    return boxes.map(([n, x, y, bw, bh, col, fs, fw]) => {
      const m = col.match(/[\d.]+/g).map(Number); const fg = lum(m); let worst = 99;
      const d = cx.getImageData(Math.max(0, Math.floor(x)), Math.max(0, Math.floor(y)), Math.max(1, Math.min(Math.ceil(bw), img.width - Math.floor(x))), Math.max(1, Math.ceil(bh))).data;
      for (let i = 0; i < d.length; i += 16) { const L = lum([d[i], d[i + 1], d[i + 2]]); const c = (Math.max(fg, L) + .05) / (Math.min(fg, L) + .05); if (c < worst) worst = c; }
      return n + " " + fs + "px/" + fw + ": min " + worst.toFixed(2) + ":1";
    });
  }, [png, boxes]);
  console.log(`${w} ${scheme}\n  ` + res.join("\n  "));
  await p.close();
}
await b.close();
