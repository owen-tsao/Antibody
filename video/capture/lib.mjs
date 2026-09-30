// Shared capture helpers: a headed (real-GPU) browser at 1440×900 @2x, a lossless-ish frame screencast, a
// synthetic-cursor event log, and a deterministic save path. Every shot script is `record(name, async (s) => { ... })`.
//
// Why headed + screencast instead of Playwright's recordVideo: headless Chromium renders WebGL through SwiftShader
// (~15 fps on the hero shader) and recordVideo encodes VP8 at 1 Mbps in realtime mode. Headed Chromium gets the Metal
// GPU (~60 fps) and Page.startScreencast hands us every composited frame as a JPEG-100 at device pixels; we pack those
// into a 60 fps CRF-12 H.264 clip, so the only lossy step left is the final master.
import { chromium } from "playwright";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

export const BASE = process.env.ANTIBODY_URL ?? "http://127.0.0.1:8000";
export const VIEW = { width: 1440, height: 900 };
const DPR = 2;
const OUT_FPS = 60;

// Saved run defaults the dashboard reads on load (lib/settings.ts SETTINGS_KEY). The Heal shot needs the airline
// agent as the target with the Sep 22 run's shape; other shots just need a stable, quiet UI.
export const RUN_SETTINGS = {
  seeds: null,
  chaosCycles: 2,
  repairAttempts: 1,
  secondPass: true,
  untilQuiet: null,
  world: "auto",
  target: "example-airline",
  domain: "airline",
  vulnerability: true,
};

export async function record(name, fn, { settings = RUN_SETTINGS, prefs = { motion: "full", replaySpeed: 3, pollCadence: "normal" } } = {}) {
  const rawDir = `out/raw/${name}`;
  await rm(rawDir, { recursive: true, force: true });
  await mkdir(rawDir, { recursive: true });
  const browser = await chromium.launch({
    headless: false,
    args: [
      "--ignore-gpu-blocklist",
      "--enable-gpu-rasterization",
      `--window-size=${VIEW.width},${VIEW.height + 120}`,
      "--window-position=0,0",
      // A covered or backgrounded window would throttle rAF and starve the screencast.
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
    ],
  });
  const ctx = await browser.newContext({ viewport: VIEW, deviceScaleFactor: DPR, reducedMotion: "no-preference" });
  await ctx.addInitScript(
    ([s, p]) => {
      window.localStorage.setItem("antibody.settings.v1", JSON.stringify(s));
      window.localStorage.setItem("antibody.prefs.v1", JSON.stringify(p));
      window.sessionStorage.setItem("antibody:onboarding-skipped", "1");
    },
    [settings, prefs],
  );
  const page = await ctx.newPage();

  // Frames stream in as they are composited; each is written straight to disk with its wall-clock timestamp.
  const cdp = await ctx.newCDPSession(page);
  const stamps = [];
  const writes = [];
  cdp.on("Page.screencastFrame", (e) => {
    const i = stamps.length;
    stamps.push(e.metadata.timestamp);
    writes.push(writeFile(`${rawDir}/${String(i).padStart(6, "0")}.jpg`, Buffer.from(e.data, "base64")));
    cdp.send("Page.screencastFrameAck", { sessionId: e.sessionId }).catch(() => {});
  });
  await cdp.send("Page.startScreencast", { format: "jpeg", quality: 100, everyNthFrame: 1, maxWidth: VIEW.width * DPR, maxHeight: VIEW.height * DPR });

  const events = [];
  let cur = { x: VIEW.width / 2, y: VIEW.height / 2 };
  // Wall-clock seconds, rebased onto the first frame when saved so events and video share one clock.
  const now = () => Date.now() / 1000;

  const s = {
    page,
    events,
    now,
    /** Navigate and settle. */
    async go(path, settle = 1800) {
      await page.goto(BASE + path, { waitUntil: "networkidle" });
      await page.waitForTimeout(settle);
      events.push({ t: now(), kind: "nav", path });
    },
    async hold(ms) {
      await page.waitForTimeout(ms);
    },
    /** Move the (invisible) mouse to a point over `ms`, logging start and end for the drawn cursor. */
    async moveTo(x, y, ms = 700) {
      events.push({ t: now(), kind: "move", from: cur, to: { x, y }, ms });
      await page.mouse.move(x, y, { steps: Math.max(8, Math.round(ms / 16)) });
      cur = { x, y };
      await page.waitForTimeout(ms);
    },
    /** Centre of an element, in viewport coordinates. */
    async centre(locator) {
      const b = await locator.boundingBox();
      if (!b) throw new Error("no box for locator");
      return { x: b.x + b.width / 2, y: b.y + b.height / 2, box: b };
    },
    async hover(locator, ms = 700) {
      const c = await s.centre(locator);
      await s.moveTo(c.x, c.y, ms);
      return c;
    },
    async click(locator, ms = 700) {
      const c = await s.hover(locator, ms);
      events.push({ t: now(), kind: "click", at: { x: c.x, y: c.y } });
      await page.mouse.down();
      await page.waitForTimeout(90);
      await page.mouse.up();
      return c;
    },
    async type(text, delay = 28) {
      events.push({ t: now(), kind: "type", text });
      await page.keyboard.type(text, { delay });
    },
    /** Scroll the document by `dy` over `ms`, eased per animation frame so every composited frame moves. */
    async scroll(dy, ms = 900) {
      events.push({ t: now(), kind: "scroll", dy, ms });
      await page.evaluate(
        ([dy, ms]) =>
          new Promise((done) => {
            const y0 = window.scrollY;
            const t0 = performance.now();
            const ease = (p) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);
            const step = () => {
              const p = Math.min(1, (performance.now() - t0) / ms);
              window.scrollTo(0, y0 + dy * ease(p));
              if (p < 1) requestAnimationFrame(step);
              else done();
            };
            requestAnimationFrame(step);
          }),
        [dy, ms],
      );
    },
    /** Log a named zoom target (viewport box) for the composition to aim at. */
    async mark(label, locator) {
      const b = await locator.boundingBox();
      events.push({ t: now(), kind: "mark", label, box: b });
      return b;
    },
  };

  let error = null;
  try {
    await fn(s);
  } catch (e) {
    error = e;
    console.error(`[${name}] failed:`, e.message);
  }
  const tEnd = now();
  await cdp.send("Page.stopScreencast").catch(() => {});
  await Promise.all(writes);
  await ctx.close();
  await browser.close();

  if (stamps.length < 2) throw new Error(`${name}: screencast produced ${stamps.length} frames`);
  const t0 = stamps[0];
  const duration = tEnd - t0;
  // ffmpeg's concat demuxer holds each frame until the next one arrived, which is exactly the compositor's timing.
  const list = stamps.map((ts, i) => {
    const next = i + 1 < stamps.length ? stamps[i + 1] : tEnd;
    return `file '${String(i).padStart(6, "0")}.jpg'\nduration ${Math.max(1 / OUT_FPS, next - ts).toFixed(4)}`;
  });
  list.push(`file '${String(stamps.length - 1).padStart(6, "0")}.jpg'`);
  await writeFile(`${rawDir}/list.txt`, list.join("\n") + "\n");
  await mkdir("public/shots", { recursive: true });
  const out = `public/shots/${name}.mp4`;
  await exec("npx", [
    "remotion", "ffmpeg", "-y", "-loglevel", "error",
    "-f", "concat", "-safe", "0", "-i", `${rawDir}/list.txt`,
    "-fps_mode", "cfr", "-r", String(OUT_FPS),
    "-c:v", "libx264", "-crf", "12", "-preset", "medium", "-pix_fmt", "yuv420p", "-movflags", "+faststart",
    out,
  ], { maxBuffer: 1 << 24 });
  await rm(rawDir, { recursive: true, force: true });

  const rebased = events.map((e) => ({ ...e, t: +(e.t - t0).toFixed(3) }));
  await writeFile(`public/shots/${name}.json`, JSON.stringify({ name, duration: +duration.toFixed(3), view: VIEW, fps: stamps.length / duration, events: rebased }, null, 1));
  console.log(`${name}: ${duration.toFixed(1)}s, ${stamps.length} frames (${(stamps.length / duration).toFixed(0)} fps) -> ${out} (${events.length} events)${error ? " WITH ERROR" : ""}`);
  if (error) process.exitCode = 1;
}
