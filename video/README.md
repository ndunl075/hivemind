# Hivemind launch film

A 49 second, 1920×1080, 60 fps launch video built from the landing page's own design system (colors, Inter and Geist Mono, the hex mark, the demo copy and the dashboard screenshot from `site/`). Every frame is a pure function of time, so the film renders the same way every time.

| Time | Scene |
|---|---|
| 0:00 | Logo builds: the two hex outlines draw on, the lavender core lands, the wordmark reveals |
| 0:04 | "Your AI agents work fast. They just can't see each other." |
| 0:08 | Collision: codex-ana and claude-nico both write `src/auth/login.ts`, conflict |
| 0:14 | Introducing Hivemind: "Real-time coordination for your AI agents." |
| 0:19 | Product demo: a blocked edit, then a message, with the shared board updating |
| 0:31 | Tasks, file locks, messages |
| 0:37 | Live dashboard |
| 0:43 | End card with URL |

## Files

- `index.html`, `timeline.js`: the composition. Open `index.html?play` in a browser for a live preview.
- `render.cjs`, `render-all.sh`: frame-accurate render with headless Chromium (Playwright) into ffmpeg.
- `score.py`: the music and sound design, synthesized with numpy and timed to the same cues as `timeline.js`.

## Build

```sh
./render-all.sh            # picture -> out/picture.mkv
python3 score.py           # audio   -> out/score.wav
ffmpeg -i out/picture.mkv -i out/score.wav -c:v libx264 -preset slow -crf 16 -pix_fmt yuv420p \
  -c:a aac -b:a 256k -movflags +faststart -shortest hivemind-launch.mp4
```

To change timing, edit the times in `timeline.js` and the matching cues in `score.py`.
