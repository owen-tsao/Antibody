import React from "react";
import { AbsoluteFill, Img, OffthreadVideo, staticFile, useCurrentFrame, useVideoConfig, interpolate, Easing } from "remotion";
import { loadFont } from "@remotion/google-fonts/Inter";
import { loadFont as loadSerif } from "@remotion/google-fonts/InstrumentSerif";
import type { UIShot, StatementShot, MetricShot, LogoShot, TerminalShot, Box, Ev } from "./shots";
import { captureExt } from "./shots";

const { fontFamily } = loadFont("normal", { weights: ["400", "500", "600"], subsets: ["latin"] });
const { fontFamily: serif } = loadSerif("normal", { weights: ["400"], subsets: ["latin"] });

export const FG = "#ffffff";
export const MUTED = "#8a8a8a";
export const FAINT = "#5c5c5c";
export const BORDER = "#2a2a2a";

const easeIO = Easing.inOut(Easing.cubic);
const useT = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return frame / fps;
};

/** The wallpaper every shot sits on: the landing hero, blurred and dimmed to ≤ #525252 so white type reads anywhere
 *  on it without a shade. Cuts never flash because the floor is the same under every shot. */
export const Floor: React.FC<{ children?: React.ReactNode }> = ({ children }) => (
  <AbsoluteFill style={{ background: "#0a0a0a", fontFamily, color: FG }}>
    <Img src={staticFile("wallpaper.jpg")} style={{ position: "absolute", inset: 0, width: 1920, height: 1080 }} />
    <div style={{ position: "absolute", inset: 0, background: "radial-gradient(ellipse 80% 70% at 50% 50%, transparent 40%, rgba(0,0,0,.45) 100%)" }} />
    {children}
  </AbsoluteFill>
);

/** Opacity 0→1 over the first `FADE` seconds of a shot (the cross-dissolve, since the floor below is the same). */
export const useFadeIn = (fade = 0.3) => {
  const t = useT();
  return interpolate(t, [0, fade], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
};

/** The slow 3–5 % push-in every card has. */
const usePush = (dur: number, from = 1, to = 1.04) => {
  const t = useT();
  return interpolate(t, [0, dur], [from, to], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.out(Easing.quad) });
};

const rise = (t: number, delay: number) => ({
  opacity: interpolate(t, [delay, delay + 0.5], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }),
  transform: `translateY(${interpolate(t, [delay, delay + 0.6], [10, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: easeIO })}px)`,
});

export const Statement: React.FC<{ shot: StatementShot }> = ({ shot }) => {
  const t = useT();
  const scale = usePush(shot.dur);
  return (
    <Floor>
      <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", transform: `scale(${scale})`, textAlign: "center", padding: "0 200px" }}>
        {shot.wordmark && (
          <div style={{ ...rise(t, 0.05), fontFamily: serif, fontSize: 132, fontWeight: 400, letterSpacing: -2, lineHeight: 1, marginBottom: 30 }}>{shot.bold}</div>
        )}
        {!shot.wordmark && <div style={{ ...rise(t, 0.05), fontSize: 58, fontWeight: 600, letterSpacing: -1.2, lineHeight: 1.15 }}>{shot.bold}</div>}
        <div style={{ ...rise(t, 0.35), fontSize: 34, fontWeight: 400, color: MUTED, marginTop: shot.wordmark ? 0 : 18, lineHeight: 1.35, maxWidth: 1250 }}>{shot.grey}</div>
      </div>
    </Floor>
  );
};

export const Metric: React.FC<{ shot: MetricShot }> = ({ shot }) => {
  const t = useT();
  const scale = usePush(shot.dur, 1, 1.05);
  return (
    <Floor>
      <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", transform: `scale(${scale})`, textAlign: "center" }}>
        <div style={{ ...rise(t, 0.05), fontSize: 210, fontWeight: 600, letterSpacing: -8, lineHeight: 1, fontVariantNumeric: "tabular-nums" }}>{shot.number}</div>
        <div style={{ ...rise(t, 0.4), fontSize: 30, marginTop: 40, lineHeight: 1.4, padding: "0 200px" }}>
          <span style={{ fontWeight: 600 }}>{shot.bold}</span>
          <span style={{ color: MUTED }}> · {shot.grey}</span>
        </div>
      </div>
    </Floor>
  );
};

export const Logo: React.FC<{ shot: LogoShot }> = ({ shot }) => {
  const t = useT();
  const scale = usePush(shot.dur, 1, 1.03);
  return (
    <Floor>
      <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", transform: `scale(${scale})`, textAlign: "center" }}>
        <div style={{ ...rise(t, 0.05), fontFamily: serif, fontSize: 150, fontWeight: 400, letterSpacing: -2, lineHeight: 1 }}>{shot.bold}</div>
        <div style={{ ...rise(t, 0.4), fontSize: 30, color: MUTED, marginTop: 26 }}>{shot.grey}</div>
      </div>
    </Floor>
  );
};

// --- Terminal ------------------------------------------------------------------------------------------------

const MONO = 'ui-monospace, "SF Mono", Menlo, monospace';

/** The framed app window: rounded, hairline border, deep soft shadow — the Screen Studio look. */
const WINDOW_FRAME: React.CSSProperties = {
  borderRadius: 14,
  overflow: "hidden",
  boxShadow: "0 40px 100px rgba(0,0,0,.6), 0 12px 30px rgba(0,0,0,.45), 0 0 0 1px rgba(255,255,255,.14)",
  background: "#000",
};

export const Terminal: React.FC<{ shot: TerminalShot }> = ({ shot }) => {
  const t = useT();
  const push = interpolate(t, [0, shot.dur], [1, 1.015], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return (
    <Floor>
      <UICaption captions={shot.captions} t={t} />
      <div style={{ ...WINDOW_FRAME, position: "absolute", left: WIN.x, top: WIN.y + 40, width: WIN.w, height: WIN.h - 120, transform: `scale(${push})`, background: "#0a0a0a" }}>
        <div style={{ height: 44, borderBottom: `1px solid ${BORDER}`, display: "flex", alignItems: "center", padding: "0 18px", gap: 8 }}>
          {[0, 1, 2].map((i) => <div key={i} style={{ width: 11, height: 11, borderRadius: 6, background: "#2c2c2c" }} />)}
          <span style={{ marginLeft: 12, fontSize: 13, color: FAINT }}>antibody — zsh</span>
        </div>
        <div style={{ padding: "26px 34px", fontFamily: MONO, fontSize: 20, lineHeight: 1.65, whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
          {shot.lines.map((l, i) => {
            const age = t - l.at;
            if (age < 0) return null;
            const isCmd = l.text.startsWith("$ ");
            // Commands type in; output appears whole.
            const shown = isCmd ? l.text.slice(0, Math.floor(age / 0.012)) : l.text;
            const o = interpolate(age, [0, 0.25], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
            return (
              <div key={i} style={{ opacity: o, color: l.dim ? MUTED : FG, minHeight: 33 }}>
                {isCmd ? <><span style={{ color: FAINT }}>$ </span>{shown.slice(2)}</> : shown}
              </div>
            );
          })}
        </div>
      </div>
    </Floor>
  );
};

// --- UI shot -------------------------------------------------------------------------------------------------

const VIEW = { w: 1440, h: 900 };
const RAIL = 172;
/** The window sits under a caption: 1400 wide, so scale 0.972; top at 168 leaves the caption its room. */
const WIN = { w: 1400, h: 875, x: 260, y: 168 };
const CURSOR_W = 22;

function cursorAt(events: Ev[], t: number): { x: number; y: number; clickAge: number | null } {
  let pos = { x: VIEW.w - 1, y: VIEW.h - 1 };
  let clickAge: number | null = null;
  for (const e of events) {
    if (e.t > t) break;
    if (e.kind === "move" && e.from && e.to && e.ms) {
      const p = Math.min(1, (t - e.t) / (e.ms / 1000));
      const k = easeIO(p);
      pos = { x: e.from.x + (e.to.x - e.from.x) * k, y: e.from.y + (e.to.y - e.from.y) * k };
    }
    if (e.kind === "click") clickAge = t - e.t;
  }
  return { x: pos.x, y: pos.y, clickAge: clickAge !== null && clickAge < 0.6 ? clickAge : null };
}

type View = { s: number; cx: number; cy: number };
const IDENT: View = { s: 1, cx: VIEW.w / 2, cy: VIEW.h / 2 };
const RAMP = 0.7;

/** Zoom state at t: ramps into each zoom's box over RAMP s, holds, ramps out (or straight into the next). */
function viewAt(shot: UIShot, t: number): View {
  const zs = shot.zooms ?? [];
  const target = (z: (typeof zs)[number]): View => {
    const s = z.scale ?? 1.6;
    const half = { w: VIEW.w / s / 2, h: VIEW.h / s / 2 };
    // Content right of the 172 px rail should not drag the rail's edge into a zoom.
    const minX = z.box.x >= RAIL && z.box.x + z.box.width <= VIEW.w - 0 ? Math.max(half.w, Math.min(RAIL + half.w, VIEW.w - half.w)) : half.w;
    const cx = Math.min(VIEW.w - half.w, Math.max(minX, z.box.x + z.box.width / 2));
    const cy = Math.min(VIEW.h - half.h, Math.max(half.h, z.box.y + z.box.height / 2));
    return { s, cx, cy };
  };
  const mix = (a: View, b: View, p: number): View => {
    const k = easeIO(Math.min(1, Math.max(0, p)));
    return { s: a.s + (b.s - a.s) * k, cx: a.cx + (b.cx - a.cx) * k, cy: a.cy + (b.cy - a.cy) * k };
  };
  for (let i = 0; i < zs.length; i++) {
    const z = zs[i]!;
    const prev = zs[i - 1];
    const next = zs[i + 1];
    const from = prev && z.at - prev.until < RAMP ? target(prev) : IDENT;
    const to = next && next.at - z.until < RAMP ? target(next) : IDENT;
    if (t >= z.at && t < z.at + RAMP) return mix(from, target(z), (t - z.at) / RAMP);
    if (t >= z.at + RAMP && t < z.until) return target(z);
    if (t >= z.until && t < z.until + RAMP && !(next && next.at - z.until < RAMP)) return mix(target(z), to, (t - z.until) / RAMP);
  }
  return IDENT;
}

const UICaption: React.FC<{ captions: { at: number; bold: string; grey?: string }[]; t: number }> = ({ captions, t }) => {
  const active = [...captions].reverse().find((c) => t >= c.at);
  if (!active) return null;
  const age = t - active.at;
  const o = interpolate(age, [0, 0.35], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return (
    <div key={active.at} style={{ position: "absolute", top: 62, left: 0, width: "100%", textAlign: "center", fontSize: 31, lineHeight: 1.3, opacity: o, transform: `translateY(${(1 - o) * 8}px)`, padding: "0 160px" }}>
      <span style={{ fontWeight: 600 }}>{active.bold}</span>
      {active.grey && <span style={{ fontWeight: 400, color: MUTED }}> {active.grey}</span>}
    </div>
  );
};

export const UI: React.FC<{ shot: UIShot }> = ({ shot }) => {
  const t = useT();
  const { fps } = useVideoConfig();
  const rate = shot.rate ?? 1;
  const v = viewAt(shot, t);
  const tCap = shot.start + t * rate; // capture time for the cursor log
  const cur = cursorAt(shot.capture.events, tCap);
  const push = interpolate(t, [0, shot.dur], [1, 1.015], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const src = staticFile(`shots/${shot.capture.name}.${captureExt(shot.capture)}`);
  // Full-bleed: the 16:10 capture covers the 16:9 frame (a 45 px crop top and bottom), no window, no wallpaper.
  if (shot.full) {
    const sc = 1920 / VIEW.w;
    return (
      <AbsoluteFill style={{ background: "#000", overflow: "hidden" }}>
        <div style={{ position: "absolute", left: 0, top: (1080 - VIEW.h * sc) / 2, width: VIEW.w, height: VIEW.h, transformOrigin: "0 0", transform: `scale(${sc * push})` }}>
          <OffthreadVideo src={src} startFrom={Math.round(shot.start * fps)} playbackRate={rate} style={{ width: VIEW.w, height: VIEW.h, display: "block" }} muted />
        </div>
      </AbsoluteFill>
    );
  }
  const k = WIN.w / VIEW.w;
  return (
    <Floor>
      <UICaption captions={shot.captions} t={t} />
      <div style={{ ...WINDOW_FRAME, position: "absolute", left: WIN.x, top: WIN.y, width: WIN.w, height: WIN.h, transform: `scale(${push})` }}>
        <div style={{ width: VIEW.w, height: VIEW.h, transformOrigin: "0 0", transform: `scale(${k})` }}>
          <div style={{ width: VIEW.w, height: VIEW.h, transformOrigin: `${v.cx}px ${v.cy}px`, transform: `translate(${VIEW.w / 2 - v.cx}px, ${VIEW.h / 2 - v.cy}px) scale(${v.s})` }}>
            <OffthreadVideo src={src} startFrom={Math.round(shot.start * fps)} playbackRate={rate} style={{ width: VIEW.w, height: VIEW.h, display: "block" }} muted />
            {shot.cursor && (
              <div style={{ position: "absolute", left: cur.x, top: cur.y, pointerEvents: "none" }}>
                {cur.clickAge !== null && (
                  <div style={{ position: "absolute", left: -18, top: -18, width: 36, height: 36, borderRadius: 18, border: "2px solid rgba(255,255,255,.9)", opacity: 1 - cur.clickAge / 0.6, transform: `scale(${0.6 + cur.clickAge})` }} />
                )}
                <svg width={CURSOR_W} height={CURSOR_W * 1.45} viewBox="0 0 20 29" style={{ display: "block", filter: "drop-shadow(0 1px 2px rgba(0,0,0,.6))" }}>
                  <path d="M1.5 1.5 L1.5 22 L7 17 L11 26.5 L14.5 25 L10.5 16 L18 16 Z" fill="#fff" stroke="#000" strokeWidth="1.4" strokeLinejoin="round" />
                </svg>
              </div>
            )}
          </div>
        </div>
      </div>
      {shot.label && (
        <div style={{ position: "absolute", top: WIN.y + WIN.h + 14, left: WIN.x, fontSize: 15, color: FAINT, letterSpacing: 0.2 }}>{shot.label}</div>
      )}
      {shot.overlay && (
        <div style={{ position: "absolute", top: WIN.y + WIN.h + 12, right: 1920 - WIN.x - WIN.w, fontSize: 15, letterSpacing: 0.4, color: MUTED, fontVariantNumeric: "tabular-nums" }}>
          <span style={{ color: FG, fontWeight: 600 }}>{shot.overlay.split(" · ")[0]}</span>
          {shot.overlay.includes(" · ") && <span> · {shot.overlay.split(" · ").slice(1).join(" · ")}</span>}
        </div>
      )}
    </Floor>
  );
};
