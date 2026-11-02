# Hivemind launch film

A 28 second, 1920×1080, 60 fps launch film cut on a 120 BPM grid (a cut lands every 0.5 s beat). It uses the landing page's brand (navy, lavender, Inter, Geist Mono, the hex mark) on flat color, with no gradients, glass or texture. Each frame averages four subframes across a 180° shutter, so fast moves get real motion blur.

| Time | Scene |
|---|---|
| 0:00 | "Two agents. One file." |
| 0:01.5 | codex-ana and claude-nico both edit `src/auth/login.ts`; one overwrites the other |
| 0:04 | Duplicate work. Lost changes. Merge conflicts. One per beat |
| 0:05.75 | The mark draws, its core floods the frame lavender, wordmark lands |
| 0:08.5 | "Real-time coordination for your AI agents." |
| 0:11 | Live terminals: claim, hold, blocked (camera push), message flies between panes, push, release |
| 0:17.5 | One owner per task / One writer per file / Agents that talk |
| 0:20.5 | Dashboard: pull out from the blocked edit to the whole board |
| 0:24 | End card |

## Files

- `index.html`, `timeline.js`: the composition. Open `index.html?play` in a browser for a live preview.
- `render.cjs`, `render-all.sh`: frame-accurate render with headless Chromium (Playwright) into ffmpeg.
- `score.py`: a 120 BPM music bed and sound design, synthesized with numpy on the same cues as `timeline.js`. Writes `out/score.wav` (music and effects) and `out/sfx.wav` (effects only, for laying a licensed 120 BPM track underneath).

## Build

```sh
./render-all.sh            # picture -> out/picture.mkv
python3 score.py           # audio   -> out/score.wav
ffmpeg -i out/picture.mkv -i out/score.wav -c:v libx264 -preset slow -crf 15 -pix_fmt yuv420p \
  -map 0:v -map 1:a -c:a aac -b:a 256k -movflags +faststart -shortest hivemind-launch.mp4
```

To change timing, edit the times in `timeline.js` and the matching cues in `score.py`.
