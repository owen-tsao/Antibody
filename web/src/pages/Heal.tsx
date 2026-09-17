import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useState } from "react";

import type { ReplayInfo } from "@/api";
import BackLink from "@/components/BackLink";
import OrbButton from "@/components/OrbButton";
import SettingsDrawer from "@/components/SettingsDrawer";
import { fmtClock, fmtTimeShort } from "@/lib/derive";
import { settingsSummary, type RunSettings } from "@/lib/settings";
import { cn } from "@/lib/utils";
import type { StartMode } from "@/pages/Intro";

const shadow = { textShadow: "0 1px 12px rgba(0, 0, 0, 0.8)" };
const quietLink =
  "rounded text-[11px] uppercase tracking-[0.14em] text-white/85 transition-colors hover:text-white focus-visible:outline-white disabled:cursor-wait";

/**
 * The replay link's text. Ended (the tape played out and is frozen on its last frame) → play it again
 * (`Replay again · 3×`); paused mid-way (Back on Agents) → resume from that position
 * (`Resume replay · 3× · 4:12 / 16:26`); no session with a known recording → what would play
 * (`Replay recorded run · 10:31 PM · 7 cycles`); /api/replay unreachable → the bare label.
 */
function replayLabel(replay: ReplayInfo | null): string {
  if (replay?.active && replay.ended) return `Replay again${replay.speed ? ` · ${replay.speed}×` : ""}`;
  if (replay?.active && replay.speed && replay.duration_s != null && replay.elapsed_s != null) {
    const elapsed = Math.min(replay.elapsed_s, replay.duration_s);
    return `Resume replay · ${replay.speed}× · ${fmtClock(elapsed)} / ${fmtClock(replay.duration_s)}`;
  }
  if (replay?.active) return "Resume replay";
  const rec = replay?.recording;
  if (rec) return `Replay recorded run · ${fmtTimeShort(rec.recorded_at)} · ${rec.cycles} cycles`;
  return "Replay recorded run";
}

// Second screen after the intro. One decision: press Heal. The quiet "settings" link opens a drawer
// with the run's shape (seeds, chaos cycles, repair attempts, second pass, world — each a flag the CLI
// already has); the parent owns those values and sends them with the start request. The quiet replay
// link is the demo fallback (docs/FRONTEND.md §7) and stays visible so it can be reached without a menu.
// With no live loop the screen has exactly two states: no replay session, or a replay paused by Back on
// Agents (resume or stop it here). Heal always starts a real run and discards a paused replay; while a
// real loop runs the replay and settings links are hidden (the API would answer 409; settings only
// shape the next run).
export default function Heal({
  onStart,
  onBack,
  onStopReplay,
  settings,
  onSettingsChange,
  loopRunning = false,
  replay = null,
  error = null,
  busy = false,
}: {
  onStart: (mode: StartMode) => void;
  onBack: () => void;
  /** "stop replay" beside the resume link; the parent re-reads /api/replay afterwards. */
  onStopReplay?: () => void;
  /** What the next Heal press will send; edited in the settings drawer. */
  settings: RunSettings;
  onSettingsChange: (next: RunSettings) => void;
  /** A loop already exists (spawned here or found by pgrep in this checkout): Heal just navigates instead of starting another. */
  loopRunning?: boolean;
  /** GET /api/replay, polled by the parent while this screen is shown; null when it failed. `active` here means paused. */
  replay?: ReplayInfo | null;
  /** Why the last Heal press did not start a run (anything but 2xx/409). */
  error?: string | null;
  /** A start request is in flight. */
  busy?: boolean;
}) {
  const reduced = useReducedMotion();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const fade = (delay: number) => ({
    initial: { opacity: 0, y: reduced ? 0 : 10 },
    animate: { opacity: 1, y: 0 },
    transition: { duration: 0.6, delay, ease: [0.25, 0.1, 0.25, 1] as const },
  });

  const label = loopRunning ? "View agents" : busy ? "Starting…" : "Heal";
  // Only the settings that differ from the defaults, so the orb says "Heal" until someone changes one.
  const summary = label === "Heal" ? settingsSummary(settings) : [];
  // A session exists and is not ours to keep: Back paused it (App.tsx pauses a stray playing one on mount).
  const pausedReplay = !loopRunning && replay?.active === true;

  return (
    <section className="relative flex min-h-screen flex-col items-center justify-center px-6 text-center text-white">
      <BackLink onClick={onBack} label="Back to intro" tone="light" />

      <motion.h2
        {...fade(0.1)}
        className="text-center font-normal leading-[1] tracking-[-0.02em]"
        style={{
          fontFamily: "var(--font-display)",
          fontSize: "clamp(48px, 7vw, 104px)",
          textShadow: "0 2px 36px rgba(0, 0, 0, 0.55)",
        }}
      >
        Let it break. Watch it heal.
      </motion.h2>

      <motion.div {...fade(0.3)} className="mt-14">
        <OrbButton
          onClick={() => onStart("live")}
          disabled={busy}
          aria-busy={busy || undefined}
          aria-label={summary.length ? ["Heal", ...summary].join(" · ") : undefined}
          title={pausedReplay ? "discards the paused replay and starts a real run" : undefined}
          className={cn(
            "h-32 w-32 font-normal tracking-[-0.01em] disabled:cursor-wait disabled:hover:bg-white disabled:hover:text-black",
            label === "Heal" ? "text-[26px]" : "text-[19px]",
          )}
          style={{ fontFamily: "var(--font-display)" }}
        >
          {summary.length ? (
            // "Heal · 1 seed · 2 cycles", set as the word and a small line under it so it fits the disc.
            <span className="flex flex-col items-center leading-none">
              <span>{label}</span>
              <span
                className="tabular mt-1.5 max-w-[104px] text-[10px] leading-[1.3] tracking-[0.02em]"
                style={{ fontFamily: "var(--font-sans)" }}
                aria-hidden
              >
                {summary.map((part, i) => (
                  // Lines break only between items, and the dot stays with the item before it.
                  <span key={part}>
                    <span className="whitespace-nowrap">
                      {part}
                      {i < summary.length - 1 && "\u00a0·"}
                    </span>{" "}
                  </span>
                ))}
              </span>
            </span>
          ) : (
            label
          )}
        </OrbButton>
      </motion.div>

      {error && (
        <p role="alert" className="mt-4 max-w-[48ch] text-[12px] text-white/85" style={shadow}>
          could not start: {error}
        </p>
      )}

      {!loopRunning && (
        <motion.div {...fade(0.5)} className="mt-8 flex items-baseline gap-4">
          <button type="button" disabled={busy} onClick={() => onStart("replay")} className={cn(quietLink, "group tabular")} style={shadow}>
            <span className="u-line">{replayLabel(replay)}</span>
          </button>
          {pausedReplay && onStopReplay && (
            <button
              type="button"
              disabled={busy}
              onClick={onStopReplay}
              className={cn(quietLink, "group text-white/60")}
              style={shadow}
            >
              <span className="u-line">stop replay</span>
            </button>
          )}
          <button
            type="button"
            disabled={busy}
            onClick={() => setSettingsOpen(true)}
            aria-haspopup="dialog"
            aria-expanded={settingsOpen}
            className={cn(quietLink, "group text-white/60")}
            style={shadow}
          >
            <span className="u-line">settings</span>
          </button>
        </motion.div>
      )}

      <AnimatePresence>
        {settingsOpen && (
          <SettingsDrawer settings={settings} onChange={onSettingsChange} onClose={() => setSettingsOpen(false)} />
        )}
      </AnimatePresence>
    </section>
  );
}
