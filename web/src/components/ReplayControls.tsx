import { Pause, Play } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { api, type ReplayInfo, type Status } from "@/api";
import { fmtClock, fmtTimeShort } from "@/lib/derive";
import { cn } from "@/lib/utils";

/**
 * Transport controls for a replay on the Agents page: pause/play, speed, a click-to-seek bar, the
 * clock, and stop. Every control is a POST to /api/replay/*; the server owns the position (it is a
 * pure function of elapsed recording seconds), and this strip only renders it.
 *
 * Two things make it feel like a player rather than a 1 s poll:
 * - The clock is interpolated locally between polls (`anchor` + wall time × speed), so the bar and
 *   the m:ss move continuously instead of stepping once a second.
 * - Each action's response re-anchors immediately, and polled status is ignored for a short window
 *   after an action so an in-flight pre-action poll cannot yank the bar back for one frame.
 */

const SPEEDS = [1, 3, 5, 10] as const;
const IGNORE_POLL_MS = 900;
const SEEK_STEP_S = 15;

interface Anchor {
  elapsed: number;
  speed: number;
  paused: boolean;
  at: number; // performance.now() when `elapsed` was true
}

interface Props {
  status: Status;
  recordedAt?: string;
  /** Called after any successful action so the page can re-poll status/cycles and snap its dwell. */
  onChanged: () => void;
  onStop: () => void;
}

export default function ReplayControls({ status, recordedAt, onChanged, onStop }: Props) {
  const duration = status.duration_s ?? 0;
  const [anchor, setAnchor] = useState<Anchor>(() => fromStatus(status));
  const lastAction = useRef(0);
  // Wall clock sampled by the ticker; render derives the interpolated position from it (pure).
  const [now, setNow] = useState(() => performance.now());

  useEffect(() => {
    if (performance.now() - lastAction.current < IGNORE_POLL_MS) return;
    setAnchor(fromStatus(status));
    setNow(performance.now());
  }, [status]);

  // Re-sample a few times a second while playing so the interpolated clock moves.
  useEffect(() => {
    if (anchor.paused) return;
    const id = setInterval(() => setNow(performance.now()), 200);
    return () => clearInterval(id);
  }, [anchor.paused]);

  const elapsed = Math.min(
    duration,
    anchor.paused ? anchor.elapsed : anchor.elapsed + (Math.max(0, now - anchor.at) / 1000) * anchor.speed,
  );
  const frac = duration > 0 ? elapsed / duration : 0;

  // Event handlers, not render: the React-compiler purity lint cannot see that from a closure in
  // the body, so they are wrapped in useCallback to mark them as such.
  const apply = useCallback(
    (p: Promise<ReplayInfo>) => {
      lastAction.current = performance.now();
      p.then((info) => {
        const at = performance.now();
        setAnchor((a) => ({
          elapsed: info.elapsed_s ?? 0,
          speed: info.speed ?? a.speed,
          paused: info.paused ?? false,
          at,
        }));
        setNow(at);
        onChanged();
      }).catch(() => onChanged());
    },
    [onChanged],
  );

  const toggle = () => apply(anchor.paused ? api.replayResume() : api.replayPause());
  const setSpeed = (s: number) => {
    if (s !== anchor.speed) apply(api.replaySpeed(s));
  };
  const seekTo = useCallback(
    (t: number) => {
      const clamped = Math.min(duration, Math.max(0, t));
      // Show the jump now; the response confirms it a round-trip later.
      const at = performance.now();
      setAnchor((a) => ({ ...a, elapsed: clamped, at }));
      setNow(at);
      apply(api.replaySeek(clamped));
    },
    [duration, apply],
  );
  const onBarClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    if (rect.width <= 0) return;
    seekTo(((e.clientX - rect.left) / rect.width) * duration);
  };
  const onBarKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "ArrowLeft") seekTo(elapsed - SEEK_STEP_S);
    else if (e.key === "ArrowRight") seekTo(elapsed + SEEK_STEP_S);
    else if (e.key === "Home") seekTo(0);
    else if (e.key === "End") seekTo(duration);
    else if (e.key === " " || e.key === "Enter") toggle();
    else return;
    e.preventDefault();
  };

  const offList = !SPEEDS.includes(anchor.speed as (typeof SPEEDS)[number]);

  return (
    <div className="tabular mt-4 flex items-center gap-x-4 text-[12px] text-[var(--faint)]">
      <span className="shrink-0">replay{recordedAt ? ` · ${fmtTimeShort(recordedAt)}` : ""}</span>

      <button
        type="button"
        onClick={toggle}
        aria-label={anchor.paused ? "Play" : "Pause"}
        title={anchor.paused ? "Play" : "Pause"}
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-[var(--border-2)] text-[var(--muted)] transition-colors hover:border-white/30 hover:text-[var(--fg)]"
      >
        {anchor.paused ? (
          <Play className="ml-px h-3 w-3" strokeWidth={2} fill="currentColor" />
        ) : (
          <Pause className="h-3 w-3" strokeWidth={2} fill="currentColor" />
        )}
      </button>

      <div className="flex shrink-0 items-center gap-x-1" role="group" aria-label="Playback speed">
        {SPEEDS.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setSpeed(s)}
            aria-pressed={anchor.speed === s}
            className={cn(
              "rounded px-1.5 py-0.5 transition-colors",
              anchor.speed === s ? "text-[var(--fg)]" : "text-[var(--faint)] hover:text-[var(--muted)]",
            )}
          >
            {s}×
          </button>
        ))}
        {offList && <span className="px-1.5 text-[var(--fg)]">{anchor.speed}×</span>}
      </div>

      {/* Thin track, tall hit area. Click anywhere to jump; arrows nudge ±15 s of recording. */}
      <div
        role="slider"
        tabIndex={0}
        aria-label="Replay position"
        aria-valuemin={0}
        aria-valuemax={Math.round(duration)}
        aria-valuenow={Math.round(elapsed)}
        aria-valuetext={`${fmtClock(elapsed)} of ${fmtClock(duration)}`}
        onClick={onBarClick}
        onKeyDown={onBarKey}
        className="group flex h-5 min-w-0 flex-1 cursor-pointer items-center rounded outline-none focus-visible:ring-1 focus-visible:ring-white/30"
      >
        <div className="relative h-[2px] w-full rounded-full bg-[var(--border-2)] transition-[height] group-hover:h-[3px]">
          <div className="absolute inset-y-0 left-0 rounded-full bg-[var(--muted)]" style={{ width: `${frac * 100}%` }} />
          <div
            className="absolute top-1/2 h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[var(--fg)] opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
            style={{ left: `${frac * 100}%` }}
          />
        </div>
      </div>

      <span className="shrink-0 text-[var(--muted)]">
        {fmtClock(elapsed)} <span className="text-[var(--faint)]">/ {fmtClock(duration)}</span>
      </span>

      <button
        type="button"
        onClick={onStop}
        className="shrink-0 rounded underline decoration-[var(--faint)]/40 underline-offset-2 transition-colors hover:text-[var(--muted)]"
      >
        stop
      </button>
    </div>
  );
}

function fromStatus(s: Status): Anchor {
  return {
    elapsed: s.elapsed_s ?? 0,
    speed: s.speed ?? 1,
    paused: s.paused ?? false,
    at: performance.now(),
  };
}
