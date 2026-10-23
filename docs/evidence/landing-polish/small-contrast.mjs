// node small-contrast.mjs <url>: worst contrast of each small-text element against the pixels behind it.
import { createRequire } from 'node:module';
const require = createRequire(new URL('../../../package.json', import.meta.url));
const { chromium } = require('@playwright/test');
const url = process.argv[2];
const SEL = ['.copy', '.row .who', '.row.dim .t', '.label', '.step .bad', '.step .good b', '.vis-note', '.fine', '.tag', '.chip', '.links a', '.bubble .who'];
const b = await chromium.launch();
for (const [w, h] of [[1920, 1080], [1440, 900], [390, 844], [320, 640]]) {
  const p = await b.newPage({ viewport: { width: w, height: h }, colorScheme: 'light', reducedMotion: 'reduce' });
  await p.goto(url); await p.waitForLoadState('networkidle'); await p.addStyleTag({content:'*,*::before,*::after{transition:none!important;animation:none!important}.hm-hide,.hm-hide *,.hm-hide::before,.hm-hide::after,.hm-hide *::before,.hm-hide *::after{color:transparent!important;text-shadow:none!important}'});
  const worst = {};
  for (const sel of SEL) {
    const n = await p.locator(sel).count();
    for (let i = 0; i < n; i++) {
      const el = p.locator(sel).nth(i);
      if (!(await el.isVisible())) continue;
      await el.scrollIntoViewIfNeeded();
      const info = await el.evaluate(e => { const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); let op = 1; for (let x = e; x; x = x.parentElement) op *= parseFloat(getComputedStyle(x).opacity); return { x: r.x, y: r.y, w: r.width, h: r.height, c: cs.color, fs: parseFloat(cs.fontSize), fw: cs.fontWeight, op, txt: e.textContent.trim().slice(0, 30) }; });
      if (info.w < 2 || info.h < 2 || info.y < 0 || info.y + info.h > h) continue;
      await el.evaluate(e => e.classList.add('hm-hide'));
      const png = await p.screenshot({ clip: { x: Math.max(0, info.x), y: info.y, width: Math.min(info.w, w - Math.max(0, info.x)), height: info.h } });
      await el.evaluate(e => e.classList.remove('hm-hide'));
      const c = await p.evaluate(async ([png, col, op]) => {
        const img = new Image(); img.src = 'data:image/png;base64,' + png; await img.decode();
        const cv = document.createElement('canvas'); cv.width = img.width; cv.height = img.height; const cx = cv.getContext('2d'); cx.drawImage(img, 0, 0);
        const d = cx.getImageData(0, 0, img.width, img.height).data;
        const m = col.match(/[\d.]+/g).map(Number); const a = (m[3] ?? 1) * op;
        const lum = ([r, g, bb]) => { const f = v => { v /= 255; return v <= .03928 ? v / 12.92 : Math.pow((v + .055) / 1.055, 2.4); }; return .2126 * f(r) + .7152 * f(g) + .0722 * f(bb); };
        let worst = 99;
        for (let i = 0; i < d.length; i += 16) {
          const bg = [d[i], d[i + 1], d[i + 2]]; const fg = [0, 1, 2].map(k => m[k] * a + bg[k] * (1 - a));
          const L1 = lum(fg), L2 = lum(bg); const r = (Math.max(L1, L2) + .05) / (Math.min(L1, L2) + .05); if (r < worst) worst = r;
        }
        return worst;
      }, [png.toString('base64'), info.c, info.op]);
      const need = (info.fs >= 24 || (info.fs >= 18.66 && +info.fw >= 700)) ? 3 : 4.5;
      if (!worst[sel] || c < worst[sel].c) worst[sel] = { c, need, txt: info.txt };
    }
  }
  console.log(w + 'x' + h);
  for (const [s, v] of Object.entries(worst)) console.log(`  ${v.c < v.need ? 'FAIL' : 'ok  '} ${s} ${v.c.toFixed(2)} (needs ${v.need}) "${v.txt}"`);
  await p.close();
}
await b.close();
