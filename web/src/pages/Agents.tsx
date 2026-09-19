import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { api, type LoopState, type Manifest, type Status } from "@/api";
import ApiDown from "@/components/ApiDown";
import CyclesBox from "@/components/CyclesBox";
import ErrorBoundary from "@/components/ErrorBoundary";
import ReplayControls from "@/components/ReplayControls";
import { MetalFrame } from "@/components/ui/liquid-metal-border";
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

/**
 * "target: openai-agents via HTTP" / "target: built-in", from the manifest's `target`. Null until the
 * backend reports a `transport`: without it there is no honest way to say how the agent is reached,
 * so the line is not drawn rather than guessed. The backend's word for the built-in agent is
 * "in-process" (chaos/target.py); "builtin" is kept for the runs list, which stores that spelling.
 */
function targetLine(t: Manifest["target"] | undefined): string | null {
  if (!t?.transport) return null;
  const transport = t.transport.toLowerCase();
  if (transport === "in-process" || transport === "builtin" || transport === "built-in") return "target: built-in";
  return `target: ${t.name} via ${transport === "http" ? "HTTP" : t.transport}`;
}

export default function Agents({
  replayNote = null,
  loop,
  status: polled,
  statusError,
  refresh,
}: {
  /** Why Replay did not start (a live run owns the screen instead); shown quietly beside the headline. */
  replayNote?: string | null;
  /** From the shell's polls (docs/FRONTEND.md "Routes"): /api/loop is the process truth — whether a run we
   *  own is alive (→ "stop run") or how it ended (→ "the loop stopped (exit N)"). */
  loop: LoopState | null;
  /** The raw /api/status row, 1 s while something plays. status.json is the only thing that drives the orbs. */
  status: Status | null;
  statusError: string | null;
  /** Re-poll the shell's routes now, after an action whose effect the next tick would show late. */
  refresh: () => void;
}) {
  // The dwell only delays *when* a phase that really arrived is shown (min 1.2 s each), so `chaos` is
  // not skipped. A replay transport action (seek/speed/pause) bumps `epoch` so the jump shows at once.
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
    refresh();
    refreshCycles();
  }, [refresh, refreshCycles]);

  const [stopping, setStopping] = useState(false);
  const stopRun = () => {
    if (stopping) return;
    setStopping(true);
    api
      .loopStop()
      .catch(() => undefined)
      .finally(() => {
        setStopping(false);
        refresh();
      });
  };
  // Both are static facts about this API; fetched once, quietly ignored if the route is not there
  // yet (health lands with plan 03, `target.transport` with plan 01). Neither is a poll: nothing
  // about them changes while the page is open.
  const [hasKey, setHasKey] = useState<boolean | null>(null);
  const [target, setTarget] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    api
      .health()
      .then((h) => alive && setHasKey(h.has_api_key))
      .catch(() => undefined);
    api
      .manifest()
      .then((m) => alive && setTarget(targetLine(m.target)))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

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

  const stopReplay = () => {
    api.replayStop().catch(() => undefined).finally(refresh);
  };

  const loading = !status && !statusError && !cycles && !cyclesError;
  const unreachable = statusError && !status && !cycles;
  const retry = () => {
    refresh();
    refreshCycles();
  };

  // "stop run" only for a process this API spawned: an external loop (found via pgrep) is someone
  // else's terminal and the API refuses to kill it anyway.
  const owned = !!loop?.running && !loop.external;
  // A positive exit code is the loop dying on its own (weave.init without a key, a traceback).
  // Negative is a signal, which is what "stop run" sends — not a failure to announce.
  const crashed = !!loop && !loop.running && loop.exit_code !== null && loop.exit_code > 0 && !replay;
  // The key gap only matters when the user asked for a live run and the loop is not (or no longer)
  // alive — a Replay on screen needs no key and gets no warning.
  const noKey = hasKey === false && !replay && !loop?.running;

  return (
    <main className="min-h-full px-6 pb-16 pt-8 md:px-10 md:pt-7">
      <div className="mx-auto w-full max-w-[1040px]">
        {/* Header: the page's job, then one quiet line of where the run stands. The only large text. */}
        <header>
          <h1 className="display text-[48px] leading-[1]">Cycles</h1>
          <p className="tabular mt-4 text-[13px] text-[var(--muted)]">
            {unreachable ? (
              <ApiDown onRetry={retry} />
            ) : loading ? (
              <span className="text-[var(--faint)]">loading…</span>
            ) : (
              <>
                {running ? (
                  `cycle ${status?.cycle ?? "—"} · ${verb}`
                ) : crashed ? (
                  <>
                    {`the loop stopped (exit ${loop.exit_code}) — `}
                    <a
                      href={api.loopLogUrl()}
                      target="_blank"
                      rel="noreferrer"
                      className="group rounded transition-colors hover:text-[var(--fg)]"
                    >
                      <span className="u-line">open log</span>
                    </a>
                  </>
                ) : sum.cycles > 0 ? (
                  `run complete · ${sum.cycles} ${sum.cycles === 1 ? "cycle" : "cycles"} · config v${sum.version ?? 0}`
                ) : (
                  "no cycles yet"
                )}
                {owned && (
                  <span className="text-[var(--faint)]">
                    {" · "}
                    <button
                      type="button"
                      onClick={stopRun}
                      disabled={stopping}
                      className="group rounded text-[var(--faint)] transition-colors hover:text-[var(--muted)] disabled:cursor-default"
                    >
                      <span className="u-line">{stopping ? "stopping…" : "stop run"}</span>
                    </button>
                  </span>
                )}
                {replay && !transport && (
                  <span className="text-[var(--faint)]">
                    {` · replay${recordedAt ? ` · recorded ${fmtTime(recordedAt)}` : ""} · `}
                    <button
                      type="button"
                      onClick={stopReplay}
                      className="group rounded text-[var(--faint)] transition-colors hover:text-[var(--muted)]"
                    >
                      <span className="u-line">stop replay</span>
                    </button>
                  </span>
                )}
                {!replay && replayNote && <span className="text-[var(--faint)]">{` · ${replayNote}`}</span>}
              </>
            )}
          </p>
          {/* One line, only when it applies: a live run was asked for and the API has no key to
              run it. Replay needs none, so a replay on screen gets no warning. */}
          {!unreachable && !loading && noKey && (
            <p className="tabular mt-1 text-[13px] text-[var(--muted)]">
              Set <span className="code text-[var(--fg)]">WANDB_API_KEY</span> to run live; Replay works without it.
            </p>
          )}
          {/* The replay is a recording being played, so it gets a player: pause, speed, seek, clock.
              The line above stays about the agents; this strip is about the tape. */}
          {transport && tape && (
            <ReplayControls status={tape} recordedAt={recordedAt} onChanged={onReplayChanged} onStop={stopReplay} />
          )}
        </header>

        {/* The run's numbers sit directly over the four agents they describe, centred with them, in
            the same shell as the cycles box: black surface, liquid-metal rim, white words. */}
        <section className="mt-10">
          {!loading && !unreachable && (
            <div className="mb-8 flex justify-center">
              <StatsPlate stateKey={sum.cycles === 0 ? (running ? "measuring" : "none") : "stats"}>
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
                    <span>
                      legit users <span className="font-medium">{sum.legit}</span>
                    </span>
                  </>
                )}
              </StatsPlate>
            </div>
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
          {/* Which agent the four above are working on. Nothing until the manifest says how the
              target is reached (plan 01 Step 5); a guessed label would be a claim we cannot back. */}
          {target && !unreachable && (
            <p className="tabular mt-8 text-center text-[12px] text-[var(--faint)]">{target}</p>
          )}
        </section>

        <section className="mt-10">
          {views.length > 0 ? (
            <ErrorBoundary
              label="cycles"
              fallback={<p className="text-[13px] text-[var(--faint)]">the cycle list hit an error; the run continues</p>}
            >
              <CyclesBox views={views} />
            </ErrorBoundary>
          ) : unreachable ? null : (
            <p className="text-[13px] text-[var(--faint)]">
              {cyclesError && !cycles ? (
                <ApiDown onRetry={retry} />
              ) : !cycles ? (
                "loading…"
              ) : running ? (
                "measuring baseline…"
              ) : (
                "no cycles yet"
              )}
            </p>
          )}
        </section>
      </div>
    </main>
  );
}

const PLATE_PAD_X = 20; // px-5 on the inner surface
const PLATE_RIM = 1.5;

/**
 * The stats plate. Its content changes shape once ("measuring baseline…" → the five numbers, and
 * again whenever a count grows a digit), so the frame's width is animated rather than snapped: the
 * text is laid out at its natural width inside the clipped frame, a ResizeObserver reports that
 * width, and the frame springs to it. The words themselves crossfade on `stateKey` so the new line
 * does not appear mid-stretch. `initial={false}` keeps the first paint from growing out of nothing.
 */
function StatsPlate({ stateKey, children }: { stateKey: string; children: React.ReactNode }) {
  const reduced = useReducedMotion();
  const measure = useRef<HTMLSpanElement | null>(null);
  const [width, setWidth] = useState<number | null>(null);

  useLayoutEffect(() => {
    const el = measure.current;
    if (!el) return;
    const read = () => setWidth(el.offsetWidth + 2 * PLATE_PAD_X + 2 * PLATE_RIM);
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <motion.div
      className="max-w-full"
      initial={false}
      animate={width !== null ? { width } : undefined}
      transition={reduced ? { duration: 0 } : { type: "spring", stiffness: 240, damping: 30, mass: 0.9 }}
    >
      <MetalFrame radius={8} thickness={PLATE_RIM} innerClassName="overflow-hidden px-5 py-2.5">
        <span ref={measure} className="tabular inline-flex w-max whitespace-nowrap text-[13px] leading-none text-[var(--fg)]">
          <AnimatePresence mode="wait" initial={false}>
            <motion.span
              key={stateKey}
              className="inline-flex items-baseline gap-x-2.5"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: reduced ? 0 : 0.16 }}
            >
              {children}
            </motion.span>
          </AnimatePresence>
        </span>
      </MetalFrame>
    </motion.div>
  );
}

function Stat({ n, label }: { n: number; label: string }) {
  return (
    <span>
      <span className="font-medium">{n}</span> {label}
    </span>
  );
}

function Sep() {
  return <span className="text-[var(--faint)]">·</span>;
}
