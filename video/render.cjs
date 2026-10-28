// Renders the film with headless Chromium.
//   node render.js stills 1.2 10.8 ...   -> out/still-<t>.png
//   node render.js segment <from> <to> <file.mov>   -> frames [from,to) as lossless video
const { chromium } = require("playwright");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

const OUT = path.join(__dirname, "out");
fs.mkdirSync(OUT, { recursive: true });

(async () => {
  const [mode, ...args] = process.argv.slice(2);
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  await page.goto("file://" + path.join(__dirname, "index.html"));
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300);
  // bake the static backdrop (noise clouds are expensive to filter every frame)
  const bgPage = await browser.newPage({ viewport: { width: 2040, height: 1200 } });
  await bgPage.goto("file://" + path.join(__dirname, "index.html") + "?bgonly");
  await bgPage.waitForTimeout(300);
  const bg = (await bgPage.screenshot({ type: "png" })).toString("base64");
  await bgPage.close();
  await page.evaluate((b) => { document.getElementById("bg").innerHTML = '<img src="data:image/png;base64,' + b + '" style="display:block;width:2040px;height:1200px">'; }, bg);
  await page.waitForTimeout(200);
  const fps = await page.evaluate(() => window.FILM.FPS);
  const shot = async (t) => {
    await page.evaluate((t) => window.FILM.renderFrame(t), t);
    return page.screenshot({ type: "png" });
  };

  if (mode === "stills") {
    for (const s of args) fs.writeFileSync(path.join(OUT, `still-${s}.png`), await shot(+s));
  } else if (mode === "segment") {
    const [from, to, file] = [+args[0], +args[1], args[2]];
    const ff = spawn("ffmpeg", ["-y", "-loglevel", "error", "-f", "image2pipe", "-framerate", String(fps), "-c:v", "png", "-i", "-",
      "-c:v", "ffv1", "-pix_fmt", "rgb24", file], { stdio: ["pipe", "inherit", "inherit"] });
    for (let f = from; f < to; f++) {
      const buf = await shot(f / fps);
      if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once("drain", r));
    }
    ff.stdin.end();
    await new Promise((r) => ff.on("close", r));
  }
  await browser.close();
})();
