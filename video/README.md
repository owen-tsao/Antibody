# Antibody demo video

The 3½-minute demo is built, not recorded: Playwright drives the dashboard and captures each shot; Remotion lays the
captures into a framed window on a blurred wallpaper with captions, zooms and a drawn cursor, between typeset cards.
Everything on screen is the real app reading real run files. The shot list and its provenance live in
`../docs/DEMO_VIDEO.md`.

## Render

```sh
cd video && npm install
npm run render            # → out/antibody-demo.mp4 (about 13 minutes: the sources are 2880×1800 at 60 fps)
npm run preview           # Remotion studio, scrub any frame
```

The README copy (720p, under GitHub's 10 MB cap) is an ffmpeg pass over the master:

```sh
npx remotion ffmpeg -i out/antibody-demo.mp4 -vf scale=1280:720 -c:v libx264 -b:v 340k -maxrate 420k -bufsize 800k -preset slow -pix_fmt yuv420p -movflags +faststart -an out/antibody-demo-readme.mp4
```

`public/shots/*.mp4` are not in git (regenerable, ~60 MB). Without them the render fails on the first UI shot; either
ask Owen for the captures or re-capture.

## Re-capture

Needs the API up on `127.0.0.1:8000` serving a fresh `web/dist`, and, for the live shots, the airline example agent on
`:8792/:8793`. Capture runs a **headed** Chromium (a window opens for the length of the shot — leave it uncovered) so
the shaders render on the real GPU; frames come off the compositor as JPEG-100 at 2× and are packed into a 60 fps
CRF-12 clip with Remotion's bundled ffmpeg. Each script is one shot and writes `public/shots/<name>.mp4` + `.json`
(the event log `src/shots.ts` reads for cursor, zoom and page-change timing).

```sh
node capture/s01.mjs          # landing hero
node capture/s03a.mjs         # home page, the airline agent's hero card
node capture/s03-08.mjs       # Sep 22 cycle 6, top of page (break); add --fix for the page opened at repair/gate/diff
node capture/s10.mjs          # Sep 22 run list
node capture/s15a.mjs         # built-in agent's 22-cycle run
node capture/s07.mjs          # presses Heal: starts a real run — use out/s07-dance.sh, which restores runs/ after
node capture/s13.mjs          # approves the live run's pending fix: writes runs/approvals.json (reset it to {} first)
node capture/s14.mjs          # gateway rows in shadow; --enforce for the blocked row (both read history/gateway.jsonl)
node capture/s15b.mjs; node capture/s15c.mjs
```

Nothing scrolls on camera: the screencast only emits frames on repaint, so a scroll on a static page stutters. Open
pages pre-scrolled (`--fix`, `scrollIntoView` before the shot's `start`) and let the composition zoom instead.

Shots 7, 13 and 14 change state on disk; read `docs/DEMO_VIDEO.md` "What changed in v3" before re-running them.
To check one frame of a capture: `npx remotion ffmpeg -ss <seconds> -i public/shots/<name>.mp4 -frames:v 1 out/check.png`.

## Music

Drop a licensed ambient track at `public/music.mp3`, set `MUSIC = "music.mp3"` in `src/shots.ts`, re-render.
