import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { type ReactNode, useCallback } from "react";

import { api, type LoopState, type ReplayInfo, type Status } from "@/api";
import ApiDown from "@/components/ApiDown";
import { usePoll } from "@/hooks/usePoll";
import { shellPill } from "@/lib/derive";
import { AGENTS, LANDING, LIVE_RUN, linkProps, RUNS, type Route } from "@/lib/routes";
import { cn } from "@/lib/utils";

/**
 * The persistent frame around everything under /app (docs/plans/00-overview.md Block 2): a left rail
 * from md up, a top bar below it. Two destinations, the wordmark back to the landing page, and one
 * line about the current run. It owns the three polls that line needs and hands `loop` and `replay`
 * to its children, so the pages under it do not poll the same routes a second time.
 *
 * Content fades 120 ms on route change; no slides. Reduced motion turns the fade off.
 */

// Cheap file reads on a local API; the pill must notice a run starting within a beat of the click.
// Status drives the run page's orbs, whose spec cadence is 1 s while something is playing.
const POLL_MS = 2_000;
const LIVE_STATUS_MS = 1_000;
const FADE_S = 0.12;

export interface ShellData {
  loop: LoopState | null;
  replay: ReplayInfo | null;
  /** The raw /api/status row (undwelled); the run page smooths it itself. */
  status: Status | null;
  statusError: string | null;
  /** Poll all three routes now (after an action whose effect the next tick would show late). */
  refresh: () => void;
}

const items = [
  { route: AGENTS, label: "Agents", active: (r: Route) => r.kind === "agents" },
  { route: RUNS, label: "Runs", active: (r: Route) => r.kind === "runs" || r.kind === "run" || r.kind === "cycle" },
];

export default function Shell({ route, children }: { route: Route; children: (data: ShellData) => ReactNode }) {
  const reduced = useReducedMotion();
  const { data: loop, error: loopError, refresh: refreshLoop } = usePoll(api.loop, POLL_MS);
  const { data: replay, error: replayError, refresh: refreshReplay } = usePoll(api.replay, POLL_MS);
  const live = !!loop?.running || !!replay?.active;
  const { data: status, error: statusError, refresh: refreshStatus } = usePoll(api.status, live ? LIVE_STATUS_MS : POLL_MS);
  const refresh = useCallback(() => {
    refreshLoop();
    refreshReplay();
    refreshStatus();
  }, [refreshLoop, refreshReplay, refreshStatus]);

  const pill = shellPill(loop, replay, status);
  // Down means neither poll has ever answered; a hiccup after first contact keeps the last value.
  const down = !loop && !replay && !!loopError && !!replayError;

  // One page-level key per screen: cycle 3 → cycle 4 is a new screen, the run's live/finished swap is not.
  const key = route.kind === "cycle" ? `cycle-${route.id}-${route.n}` : route.kind === "run" ? `run-${route.id}` : route.kind;

  const nav = (
    <nav aria-label="Sections" className="flex items-center gap-5 md:flex-col md:items-stretch md:gap-1">
      {items.map((it) => {
        const active = it.active(route);
        return (
          <a
            key={it.label}
            {...linkProps(it.route)}
            aria-current={active ? "page" : undefined}
            className={cn(
              "rounded text-[13px] transition-colors md:-mx-2 md:px-2 md:py-1",
              active ? "font-medium text-[var(--fg)]" : "text-[var(--muted)] hover:text-[var(--fg)]",
            )}
          >
            {it.label}
          </a>
        );
      })}
    </nav>
  );

  const line = down ? (
    <ApiDown onRetry={refresh} className="text-[12px]" />
  ) : pill ? (
    <a {...linkProps(LIVE_RUN)} className="group inline-flex items-center gap-2 rounded text-[12px] text-[var(--muted)] transition-colors hover:text-[var(--fg)]">
      <span
        aria-hidden
        className={cn("inline-block h-1.5 w-1.5 rounded-full", pill.live ? "bg-[var(--live)]" : "bg-[var(--faint)]")}
      />
      <span className="tabular u-line">{pill.label}</span>
    </a>
  ) : null;

  const wordmark = (
    <a {...linkProps(LANDING)} className="display rounded text-[22px] leading-none text-[var(--fg)]" aria-label="Antibody — home">
      Antibody
    </a>
  );

  return (
    <div className="min-h-full md:grid md:grid-cols-[200px_minmax(0,1fr)]">
      {/* Top bar, below md. */}
      <header className="sticky top-0 z-20 flex items-center justify-between gap-6 border-b border-[var(--border)] bg-[var(--bg)] px-6 py-3 md:hidden">
        <div className="flex items-center gap-6">
          {wordmark}
          {nav}
        </div>
        {line}
      </header>

      {/* Left rail, md and up. */}
      <aside className="hidden border-r border-[var(--border)] md:sticky md:top-0 md:flex md:h-screen md:flex-col md:px-6 md:py-7">
        {wordmark}
        <div className="mt-10">{nav}</div>
        <div className="mt-auto min-h-[1.25rem]">{line}</div>
      </aside>

      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={key}
          className="min-w-0"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: reduced ? 0 : FADE_S, ease: "linear" }}
        >
          {children({ loop, replay, status, statusError, refresh })}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
