// Renders the film with headless Chromium.
//   node render.cjs stills 1.2 10.8 ...                -> out/still-<t>.png
//   node render.cjs segment <from> <to> <file.mkv>      -> frames [from,to), lossless
// Each output frame averages SUB subframes across a 180 degree shutter (real motion blur).
const { chromium } = require("playwright");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

const OUT = path.join(__dirname, "out");
const SUB = 4, SHUTTER = 0.5;
fs.mkdirSync(OUT, { recursive: true });

(async () => {
  const [mode, ...args] = process.argv.slice(2);
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  await page.goto("file://" + path.join(__dirname, "index.html"));
  await page.evaluate(() => window.FILM.ready);
  await page.waitForTimeout(300);
  const fps = await page.evaluate(() => window.FILM.FPS);
  const shot = async (t) => {
    await page.evaluate((t) => window.FILM.renderFrame(t), t);
    return page.screenshot({ type: "png" });
  };

  if (mode === "stills") {
    for (const s of args) fs.writeFileSync(path.join(OUT, `still-${s}.png`), await shot(+s));
  } else if (mode === "segment") {
    const [from, to, file] = [+args[0], +args[1], args[2]];
    const ff = spawn("ffmpeg", ["-y", "-loglevel", "error", "-f", "image2pipe", "-framerate", String(fps * SUB), "-c:v", "png", "-i", "-",
      "-vf", `tmix=frames=${SUB},select='eq(mod(n\\,${SUB})\\,${SUB - 1})',setpts=N/(${fps}*TB)`, "-r", String(fps),
      "-c:v", "ffv1", "-pix_fmt", "rgb24", file], { stdio: ["pipe", "inherit", "inherit"] });
    for (let f = from; f < to; f++) {
      for (let k = 0; k < SUB; k++) {
        const buf = await shot((f + (k / SUB) * SHUTTER) / fps);
        if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once("drain", r));
      }
    }
    ff.stdin.end();
    await new Promise((r) => ff.on("close", r));
  }
  await browser.close();
})();
