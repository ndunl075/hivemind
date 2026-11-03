# Hivemind launch film

A 26 second, 1920×1080, 60 fps launch film. Everything is drawn on one canvas from the brand's own parts: the navy, the mark's three colors (#E4E5EA, #8E8EA0, #A99BFF), Inter, and the hexagon itself. The only product imagery is the real dashboard screenshot from `site/`. Each frame averages four subframes across a 180° shutter, so moving shapes get real motion blur.

The idea: agents are the hexagon cells of the mark. They work side by side, collide when they can't see each other, then resolve into the mark itself, two cells that overlap and share a lavender core.

| Time | Scene |
|---|---|
| 0:00 | Agents draw on and work across a hex field. "Your AI agents work side by side." |
| 0:05.5 | Three pairs land on the same cell and conflict. "None of them knows what the others are doing." |
| 0:09 | Everyone reorganizes around one shared core and connects to it |
| 0:11 | The camera pushes into the center pair, which is the Hivemind mark; wordmark wipes on |
| 0:14 | Real dashboard: the blocked edit, agent messages, then the full board |
| 0:22 | End card |

The master has no audio. Lay a licensed track under it; the strongest beats are the collisions (5.6 to 6.9 s), the resolve (9.0 s), the lockup (12.2 s) and the end card (22.0 s).

## Files

- `index.html`, `timeline.js`: the composition. Open `index.html?play` in a browser for a live preview.
- `render.cjs`, `render-all.sh`: frame-accurate render with headless Chromium (Playwright) into ffmpeg.

## Build

```sh
./render-all.sh   # picture -> out/picture.mkv
ffmpeg -i out/picture.mkv -c:v libx264 -preset slow -crf 14 -pix_fmt yuv420p -movflags +faststart hivemind-launch.mp4
```
