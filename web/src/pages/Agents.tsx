import { AnimatePresence } from "framer-motion";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { api, type Status } from "@/api";
import BackLink, { ForwardLink } from "@/components/BackLink";
import CyclesBox from "@/components/CyclesBox";
import ErrorBoundary from "@/components/ErrorBoundary";
import ReplayControls from "@/components/ReplayControls";
import { Orb } from "@/components/ui/orb";
import { useDwell } from "@/hooks/useDwell";
import { usePoll } from "@/hooks/usePoll";
import {
  type Agent,
  AGENT_LABEL,
  AGENTS,
  cycleViews,
  fmtTime,
  isActiveWord,
  isRunning,
  ORB_GREY,
  orbStates,
  orbWord,
  phaseVerb,
  runSummary,
} from "@/lib/derive";
import { cn } from "@/lib/utils";

// Size of the fixed legit-user suite (chaos/scenarios.py LEGIT_SCENARIOS). Same constant Results
// uses, so the two pages print the same "legit 3/3". /api/manifest replaces it in Slice 3.
const LEGIT_SIZE = 3;

// Fixed per orb so the blobs do not reshuffle on every re-render (orb.tsx seeds its PRNG from this).
const ORB_SEED: Record<Agent, number> = { chaos: 1000, target: 2000, judge: 3000, repair: 4000 };

/**
 * One hue per agent, shown only while that agent is active (orbStates → "thinking"); idle and done
 * are the grey preset. The orb's ramp is black → pair[0] → pair[1] → white, so each pair is a light
 * tint and a saturated mid-tone from the same Tailwind family, which reads as "the orb is that
 * colour" rather than a tinted grey. Chaos and Repair take the two signal tokens in index.css
 * (--danger #f87171 → red-300/600; --live #4ade80 → green-200/600); Target and Judge take the two
 * remaining hues that stay distinct from both at 96 px (amber, blue).
 */
const ORB_COLORS: Record<Agent, [string, string]> = {
  chaos: ["#fca5a5", "#dc2626"],
  target: ["#fde68a", "#d97706"],
  judge: ["#bfdbfe", "#2563eb"],
  repair: ["#bbf7d0", "#16a34a"],
};

// A phase change is what the dwell protects; a new `since` or `attempt` inside the same phase is not.
const phaseKey = (s: Status | null) => s?.phase ?? "idle";

export default function Agents({
  replayNote = null,
  onBack,
  onResults,
}: {
  /** Why Replay did not start (a live run owns the screen instead); shown quietly beside the headline. */
  replayNote?: string | null;
  onBack: () => void;
  onResults: () => void;
}) {
  // status.json is the only thing that drives the orbs; 1 s is the spec's cadence. The dwell only
  // delays *when* a phase that really arrived is shown (min 1.2 s each), so `chaos` is not skipped.
  // A replay transport action (seek/speed/pause) bumps `epoch` so the jump shows at once.
  const { data: polled, error: statusError, refresh: refreshStatus } = usePoll(api.status, 1_000);
  const [epoch, setEpoch] = useState(0);
  const status = useDwell(polled, phaseKey, undefined, undefined, epoch);
  const running = isRunning(status);
  // "replay · recorded" is a claim about the data on screen, so only the API may make it. status
  // arrives every second, state every few, so either flag lights the label without a lag.
  const { data: state } = usePoll(api.state, status?.replay ? 2_000 : 10_000);
  const replay = status?.replay === true || state?.source === "replay";
  // Replayed cycles land on the recording's schedule, so they need the running cadence too.
  const {
    data: cycles,
    error: cyclesError,
    refresh: refreshCycles,
  } = usePoll(api.cycles, running || replay ? 2_000 : 10_000);
  const onReplayChanged = useCallback(() => {
    setEpoch((n) => n + 1);
    refreshStatus();
    refreshCycles();
  }, [refreshStatus, refreshCycles]);

  // Each orb lerps toward whatever its ref holds on every frame (orb.tsx useFrame), so updating the
  // refs is enough for a smooth fade at 1 s polling and through the dwell hold. Done in an effect
  // rather than during render so React is not asked to read/write refs while rendering.
  const chaosColors = useRef<[string, string]>(ORB_GREY);
  const targetColors = useRef<[string, string]>(ORB_GREY);
  const judgeColors = useRef<[string, string]>(ORB_GREY);
  const repairColors = useRef<[string, string]>(ORB_GREY);
  const colorRefs: Record<Agent, React.RefObject<[string, string]>> = {
    chaos: chaosColors,
    target: targetColors,
    judge: judgeColors,
    repair: repairColors,
  };
  const orbs = orbStates(status);
  useEffect(() => {
    chaosColors.current = orbs.chaos === "thinking" ? ORB_COLORS.chaos : ORB_GREY;
    targetColors.current = orbs.target === "thinking" ? ORB_COLORS.target : ORB_GREY;
    judgeColors.current = orbs.judge === "thinking" ? ORB_COLORS.judge : ORB_GREY;
    repairColors.current = orbs.repair === "thinking" ? ORB_COLORS.repair : ORB_GREY;
  }, [orbs.chaos, orbs.target, orbs.judge, orbs.repair]);

  const sum = runSummary(cycles ?? [], LEGIT_SIZE);
  const verb = phaseVerb(status);
  const views = useMemo(() => cycleViews(cycles ?? [], status, LEGIT_SIZE), [cycles, status]);

  const recordedAt = state?.recorded_at ?? status?.recorded_at ?? cycles?.[0]?.timestamp;
  // The transport reads the raw poll, not the dwelled status: the dwell holds the previous object for
  // up to 1.2 s at each phase change, and re-anchoring the clock from that stale `elapsed_s` would
  // flick the bar backwards at every boundary. Only the orbs want smoothing.
  const tape = polled ?? status;
  const transport = tape?.replay === true && tape.duration_s != null;
  // Results is reachable once the loop has finished and there is something to show. `loop.running`
  // is computed from the live process by the API, so a crashed loop still counts as finished.
  const done = !running && !(state?.loop.running ?? false) && (cycles?.length ?? 0) > 0;

  const stopReplay = () => {
    api.replayStop().catch(() => undefined).finally(onBack);
  };
  // Back leaves a replay frozen where it is (Heal offers "Resume replay"); it must not keep playing
  // off-screen. Fire-and-forget: the page changes now, the API catches up within the poll.
  const back = () => {
    if (status?.replay) api.replayPause().catch(() => undefined);
    onBack();
  };

  const loading = !status && !statusError && !cycles && !cyclesError;
  const unreachable = statusError && !status && !cycles;

  return (
    <main className="min-h-full px-6 pb-16 pt-16 md:px-10 md:pt-20">
      <BackLink onClick={back} label="Back" />
      <AnimatePresence>{done && <ForwardLink onClick={onResults} label="Results" />}</AnimatePresence>

      <div className="mx-auto w-full max-w-[1040px]">
        {/* Header: the page's job, then one quiet line of where the run stands. The only large text. */}
        <header>
          <h1 className="text-[40px] font-medium leading-none tracking-[-0.025em]">Cycles</h1>
          <p className="tabular mt-3 text-[13px] text-[var(--muted)]">
            {unreachable ? (
              <span className="text-[var(--faint)]">api unreachable</span>
            ) : loading ? (
              <span className="text-[var(--faint)]">loading…</span>
            ) : (
              <>
                {running
                  ? `cycle ${status?.cycle ?? "—"} · ${verb}`
                  : sum.cycles > 0
                    ? `run complete · ${sum.cycles} ${sum.cycles === 1 ? "cycle" : "cycles"} · config v${sum.version ?? 0}`
                    : "no cycles yet"}
                {replay && !transport && (
                  <span className="text-[var(--faint)]">
                    {` · replay${recordedAt ? ` · recorded ${fmtTime(recordedAt)}` : ""} · `}
                    <button
                      type="button"
                      onClick={stopReplay}
                      className="rounded text-[var(--faint)] underline decoration-[var(--faint)]/40 underline-offset-2 hover:text-[var(--muted)]"
                    >
                      stop replay
                    </button>
                  </span>
                )}
                {!replay && replayNote && <span className="text-[var(--faint)]">{` · ${replayNote}`}</span>}
              </>
            )}
          </p>
          {/* The replay is a recording being played, so it gets a player: pause, speed, seek, clock.
              The line above stays about the agents; this strip is about the tape. */}
          {transport && tape && (
            <ReplayControls status={tape} recordedAt={recordedAt} onChanged={onReplayChanged} onStop={stopReplay} />
          )}
        </header>

        {/* The run's numbers sit directly over the four agents they describe, centred with them. */}
        <section className="mt-10">
          {!loading && !unreachable && (
            <p className="tabular mb-6 text-center text-[13px] text-[var(--muted)]">
              {sum.cycles === 0 ? (
                running ? "measuring baseline…" : "no cycles yet"
              ) : (
                <>
                  <Stat n={sum.accepted} label="patches accepted" />
                  <Sep />
                  <Stat n={sum.rejected} label="rejected" />
                  <Sep />
                  <Stat n={sum.blocked} label={sum.blocked === 1 ? "attack blocked" : "attacks blocked"} />
                  <Sep />
                  <Stat n={sum.suiteSize} label={sum.suiteSize === 1 ? "test in suite" : "tests in suite"} />
                  <Sep />
                  legit users <span className="text-[var(--fg)]">{sum.legit}</span>
                </>
              )}
            </p>
          )}

          {/* Four agents. The gate is not an agent: it is step five inside the cycles box. Kept
              compact so the box's tabs and first steps are above the fold on a 720p projector. */}
          <div className="grid grid-cols-2 gap-y-8 sm:grid-cols-4">
            {AGENTS.map((agent) => {
              // The orbs answer one question only: who is working right now. Whether the attack
              // landed is the plan's job (Judge → FAIL), so no red caption here.
              const word = orbWord(agent, status);
              return (
                <figure key={agent} className="flex flex-col items-center">
                  <div className="bg-muted relative h-24 w-24 rounded-full p-1 shadow-[inset_0_2px_8px_rgba(0,0,0,0.5)]">
                    <div className="bg-background h-full w-full overflow-hidden rounded-full shadow-[inset_0_0_12px_rgba(0,0,0,0.3)]">
                      <ErrorBoundary label={`${agent} orb`} fallback={<div className="h-full w-full rounded-full bg-[#2a2a2a]" />}>
                        <Orb colors={ORB_GREY} colorsRef={colorRefs[agent]} seed={ORB_SEED[agent]} agentState={orbs[agent]} />
                      </ErrorBoundary>
                    </div>
                  </div>
                  <figcaption className="mt-3 text-center">
                    <div className="text-[13px] font-medium">{AGENT_LABEL[agent]}</div>
                    <div className={cn("text-[12px]", isActiveWord(word) ? "text-[var(--muted)]" : "text-[var(--faint)]")}>
                      {word}
                    </div>
                  </figcaption>
                </figure>
              );
            })}
          </div>
        </section>

        <section className="mt-10">
          {views.length > 0 ? (
            <ErrorBoundary
              label="cycles"
              fallback={<p className="text-[13px] text-[var(--faint)]">the cycle list hit an error; the run continues</p>}
            >
              <CyclesBox views={views} />
            </ErrorBoundary>
          ) : (
            <p className="text-[13px] text-[var(--faint)]">
              {cyclesError && !cycles
                ? "api unreachable"
                : !cycles
                  ? "loading…"
                  : running
                    ? "measuring baseline…"
                    : "no cycles yet"}
            </p>
          )}
        </section>
      </div>
    </main>
  );
}

function Stat({ n, label }: { n: number; label: string }) {
  return (
    <>
      <span className="text-[var(--fg)]">{n}</span> {label}
    </>
  );
}

function Sep() {
  return <span className="mx-2 text-[var(--faint)]">·</span>;
}
