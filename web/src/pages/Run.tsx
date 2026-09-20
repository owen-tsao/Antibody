import { AnimatePresence, motion } from "framer-motion";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { api, ApiError, type CycleRecord, type Manifest, type ReadSource, type RollbackResult, type State, type Status } from "@/api";
import AgentCard, { CARD_FRAME } from "@/components/AgentCard";
import AgentSwitcher from "@/components/AgentSwitcher";
import ApiDown from "@/components/ApiDown";
import CyclesBox from "@/components/CyclesBox";
import ErrorBoundary from "@/components/ErrorBoundary";
import HealOrb from "@/components/HealOrb";
import Page from "@/components/Page";
import ReplayControls from "@/components/ReplayControls";
import RunResults from "@/components/RunResults";
import type { ShellData } from "@/components/Shell";
import { MetalFrame } from "@/components/ui/liquid-metal-border";
import { Orb } from "@/components/ui/orb";
import { useDwell } from "@/hooks/useDwell";
import { usePoll } from "@/hooks/usePoll";
import { useMotionPref } from "@/hooks/useMotionPref";
import {
  type Agent,
  AGENT_LABEL,
  AGENTS,
  agentSubline,
  cycleViews,
  emptyLiveFace,
  fmtTime,
  idleFaceSettling,
  isActiveWord,
  isRunning,
  lastRunFace,
  ORB_GREY,
  orbStates,
  orbWord,
  phaseVerb,
  readSource,
  recordingFor,
  replayIsFor,
  rollbackVersions,
  runHeaderLine,
  runMode,
  runSummary,
  runTitle,
  selectedAgent,
  summaryLine,
} from "@/lib/derive";
import { agent as agentRoute, linkProps, replace } from "@/lib/routes";
import { usePrefs } from "@/lib/prefs";
import type { RunSettings } from "@/lib/settings";
import { cn } from "@/lib/utils";

// Fixed per orb so the blobs do not reshuffle on every re-render (orb.tsx seeds its PRNG from this).
const ORB_SEED: Record<Agent, number> = { chaos: 1000, target: 2000, judge: 3000, repair: 4000 };

/**
 * One hue per agent, shown only while that agent is active; idle and done are the grey preset. Chaos and
 * Repair take the two signal tokens in index.css (--danger, --live); Target and Judge take the two remaining
 * hues that stay distinct from both at 96 px (amber, blue).
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
 * "target: openai-agents via HTTP" / "target: built-in", from the manifest's `target`. Null until the backend
 * reports a `transport`. The backend's word for the built-in agent is "in-process" (chaos/target.py).
 */
function targetLine(t: Manifest["target"] | undefined): string | null {
  if (!t?.transport) return null;
  if (t.transport === "in-process") return "target: built-in";
  return `target: ${t.name} via ${t.transport === "http" ? "HTTP" : t.transport}`;
}

const quietLink = "group rounded text-[var(--muted)] transition-colors hover:text-[var(--fg)] disabled:cursor-default disabled:text-[var(--faint)]";

/**
 * Start this run's tape at `speed` (the Display preference; at 1× the recording's 47 s gates look frozen, 3×
 * plays the golden run in ~5.5 min), or join it if it is already the one playing. A tape of this run that has
 * run to its end is resumed, which restarts it from 0 (api/replay.py). Another run's tape is stopped first:
 * nothing plays off-screen. `onStarting` fires right before the tape (re)starts (labels), `onStarted` once it is
 * playing, so the caller can drop the frame it holds and read the tape's first one — not the old files. Rejects
 * with the API's error (409 when a live loop owns the screen).
 */
async function joinTape(id: string, speed: number, onStarting: () => void, onStarted: () => void): Promise<void> {
  const rec = recordingFor(id);
  if (!rec) return;
  const cur = await api.replay();
  if (replayIsFor(cur, id)) {
    if (cur.ended) {
      onStarting();
      await api.replayResume();
      onStarted();
    }
    return;
  }
  if (cur.active) await api.replayStop();
  onStarting();
  await api.replayStart(speed, rec);
  onStarted();
}

/**
 * `/app/runs/:id` and `/app/run` — one page, five faces (docs/plans/08-rework-round-2.md §4): `starting` and
 * `live` while the loop runs, `watching` while this run's tape plays, `finished` for a history row, and for
 * the current run two idle faces — **last run** (files still in `runs/`: the orbs at rest over the results,
 * See results · Clear) and **empty** (nothing in `runs/`: the selected agent's card with the Heal orb on it).
 * Reads follow the mode: `run:<id>` (or `golden`/`live`) when static, `live` + the shell's `/api/status`
 * while watching, because a replay only ever overrides `live` reads (api/main.py `_read_source`).
 */
export default function Run({
  id,
  replay: arriveWatching,
  shell,
  settings,
  onSettingsChange,
}: {
  id: string;
  /** `/app/runs/:id/replay`: start the tape on arrival. */
  replay: boolean;
  shell: ShellData;
  settings: RunSettings;
  onSettingsChange: (next: RunSettings) => void;
}) {
  const { loop, replay, status: polled, statusError, refresh, agents } = shell;
  const { prefs } = usePrefs();
  // The run row; 404 for `live` until run.json lands, which is "starting…", not an error. Only the live
  // row changes while the page is open (finished_at, versions), so history rows are read once a minute.
  // usePoll keeps the last good row across errors, so when a new run archives the old one `/app/run`
  // reads `live` rather than `starting` for one 5 s beat; the header line is right again on the next tick.
  const rowFn = useCallback(() => api.run(id), [id]);
  const { data: row, error: rowError, reset: resetRow } = usePoll(rowFn, id === "live" ? 5_000 : 60_000);

  const mode = runMode(id, row, loop, replay);
  const watching = mode === "watching";
  const playing = watching || mode === "live" || mode === "starting";
  const source: ReadSource = watching ? "live" : readSource(id);

  // Each answer carries the source it was read from, and the page keeps the last answer per source. Stopping a
  // replay then shows the run's own rows at once instead of the tape's last frame or a "loading…" flash.
  const cyclesFn = useCallback(() => api.cycles(source).then((c) => ({ source, c })), [source]);
  const stateFn = useCallback(() => api.state(source).then((s) => ({ source, s })), [source]);
  const { data: cyclesTagged, error: cyclesError, refresh: refreshCycles, reset: resetCycles } = usePoll(cyclesFn, playing ? 2_000 : 10_000);
  const { data: stateTagged, error: stateError, refresh: refreshState, reset: resetState } = usePoll(stateFn, watching ? 2_000 : 10_000);
  const [bySource, setBySource] = useState<Partial<Record<ReadSource, { cycles?: CycleRecord[]; state?: State }>>>({});
  // Stored during render, guarded (the way CyclesBox tracks its shown cycle): usePoll keeps the same reference
  // while the JSON is unchanged, so this settles after one pass and never loops.
  if (cyclesTagged && bySource[cyclesTagged.source]?.cycles !== cyclesTagged.c) {
    setBySource((m) => ({ ...m, [cyclesTagged.source]: { ...m[cyclesTagged.source], cycles: cyclesTagged.c } }));
  }
  if (stateTagged && bySource[stateTagged.source]?.state !== stateTagged.s) {
    setBySource((m) => ({ ...m, [stateTagged.source]: { ...m[stateTagged.source], state: stateTagged.s } }));
  }
  // The files behind `live` just changed under the page (Clear filed them away, a tape took over or let go):
  // the frame held for `live` goes, and the polls forget their answers and ask again. Forgetting is what makes
  // it stick — the polls keep last-good data on purpose, and the store above would otherwise put the old answers
  // straight back. The current run's row is included (a kept row would say "last run" over an empty tree); a
  // history run's row cannot change and stays.
  const dropLive = useCallback(() => {
    setBySource((m) => ({ ...m, live: undefined }));
    if (id === "live") resetRow();
    resetCycles();
    resetState();
  }, [id, resetRow, resetCycles, resetState]);
  // usePoll picks up a new fetcher on its next tick; a mode change should not wait for one.
  useEffect(() => {
    refreshCycles();
    refreshState();
  }, [source, refreshCycles, refreshState]);
  const cycles = bySource[source]?.cycles ?? null;
  const state = bySource[source]?.state ?? null;

  const { data: manifest } = usePoll(api.manifest, 60_000);

  // The dwell only delays *when* a phase that really arrived is shown (min 1.2 s each), so `chaos` is not
  // skipped. A replay transport action bumps `epoch` so the jump shows at once. A finished run has no phase
  // signal of its own: the shell's status belongs to whatever is live, so it is not shown here.
  const [epoch, setEpoch] = useState(0);
  const status = useDwell(playing ? polled : null, phaseKey, undefined, undefined, epoch);
  const running = isRunning(status);
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

  // Clear: file the finished run under history/ and land on the empty face — through `dropLive`, so the page
  // passes through "loading…" and never shows the tape's cycles under the old run's header for a tick.
  const [clearing, setClearing] = useState(false);
  const [clearError, setClearError] = useState<string | null>(null);
  const clearRun = () => {
    if (clearing) return;
    setClearing(true);
    setClearError(null);
    api
      .runsArchive()
      .then(dropLive)
      .catch((e: unknown) => setClearError(e instanceof ApiError && e.status === 409 ? "a run is in progress" : e instanceof Error ? e.message : String(e)))
      .finally(() => {
        setClearing(false);
        refresh();
      });
  };

  // A tape letting go of `live` — stopped here, stopped from another page, or replaced — changes the files
  // behind it as much as Clear does, and `source` stays "live" either way, so the source effect above does not
  // fire. History run pages switch source instead and keep their own held frame, so only `live` drops here.
  const wasWatching = useRef(watching);
  useEffect(() => {
    if (id === "live" && wasWatching.current && !watching) dropLive();
    wasWatching.current = watching;
  }, [id, watching, dropLive]);

  // "watch it back": this run's tape at the Display preference's speed. A tape of another run is stopped first (nothing plays off-screen);
  // an already-playing tape of this run is simply joined. 409 means a live loop owns the screen. The `live`
  // frame held from a previous tape is dropped once the new one is playing, so its last frame never shows as
  // the first of this one. Both labels are set only after the first round trip, so the same function can run
  // from the arrival effect below without a synchronous state change inside an effect.
  const [replayNote, setReplayNote] = useState<string | null>(null);
  const [startingReplay, setStartingReplay] = useState(false);
  const watch = useCallback(async () => {
    try {
      await joinTape(
        id,
        prefs.replaySpeed,
        () => {
          setStartingReplay(true);
          setReplayNote(null);
        },
        dropLive,
      );
    } catch (e) {
      setReplayNote(e instanceof ApiError && e.status === 409 ? "a live run is in progress · it owns the screen" : e instanceof Error ? e.message : String(e));
    } finally {
      setStartingReplay(false);
      refresh();
    }
  }, [id, refresh, prefs.replaySpeed, dropLive]);
  // Arriving at `/replay` starts the tape once per arrival (StrictMode runs effects twice; the ref keeps that
  // from being two `replayStart`s). Leaving `/replay` re-arms it, so Back to the address starts it again.
  const startedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!arriveWatching) {
      startedFor.current = null;
      return;
    }
    if (startedFor.current === id) return;
    startedFor.current = id;
    void watch();
  }, [arriveWatching, id, watch]);
  const stopReplay = () => {
    api
      .replayStop()
      .catch(() => undefined)
      .finally(() => {
        refresh();
        // A refresh on `/replay` would start the tape again; the address now says what is on screen.
        if (arriveWatching) replace({ kind: "run", id });
      });
  };

  // Roll back: second click confirms, Escape cancels. The API copies the version in as the next live config
  // and merges the suites; its answer is shown in full (the patch note names the run, `newer_tests` says what
  // it never saw). The version live now *is* leaves the list — rolling back to it again would only add an
  // identical config.
  const [rolled, setRolled] = useState<RollbackResult | null>(null);
  const [rolledTo, setRolledTo] = useState<number | null>(null);
  const versions = rollbackVersions(id, row, loop, rolledTo);
  const [confirm, setConfirm] = useState<number | null>(null);
  const [rolling, setRolling] = useState(false);
  const [rollbackError, setRollbackError] = useState<string | null>(null);
  useEffect(() => {
    if (confirm === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setConfirm(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [confirm]);
  const rollBack = (version: number) => {
    if (rolling) return;
    if (confirm !== version) {
      setConfirm(version);
      return;
    }
    setConfirm(null);
    setRolling(true);
    setRollbackError(null);
    api
      .rollback({ run: id, version })
      .then((res) => {
        setRolled(res);
        setRolledTo(version);
      })
      .catch((e: unknown) => setRollbackError(e instanceof Error ? e.message : String(e)))
      .finally(() => setRolling(false));
  };

  // Each orb lerps toward whatever its ref holds on every frame (orb.tsx useFrame), so updating the refs is
  // enough for a smooth fade at 1 s polling and through the dwell hold.
  const chaosColors = useRef<[string, string]>(ORB_GREY);
  const targetColors = useRef<[string, string]>(ORB_GREY);
  const judgeColors = useRef<[string, string]>(ORB_GREY);
  const repairColors = useRef<[string, string]>(ORB_GREY);
  const colorRefs: Record<Agent, React.RefObject<[string, string]>> = { chaos: chaosColors, target: targetColors, judge: judgeColors, repair: repairColors };
  const orbs = orbStates(status);
  useEffect(() => {
    chaosColors.current = orbs.chaos === "thinking" ? ORB_COLORS.chaos : ORB_GREY;
    targetColors.current = orbs.target === "thinking" ? ORB_COLORS.target : ORB_GREY;
    judgeColors.current = orbs.judge === "thinking" ? ORB_COLORS.judge : ORB_GREY;
    repairColors.current = orbs.repair === "thinking" ? ORB_COLORS.repair : ORB_GREY;
  }, [orbs.chaos, orbs.target, orbs.judge, orbs.repair]);

  const sum = runSummary(cycles ?? []);
  const verb = phaseVerb(status);
  const views = useMemo(() => cycleViews(cycles ?? [], status), [cycles, status]);

  const recordedAt = state?.recorded_at ?? status?.recorded_at ?? cycles?.[0]?.timestamp;
  // The transport reads the raw poll, not the dwelled status: re-anchoring the clock from a held `elapsed_s`
  // would flick the bar backwards at every phase boundary. Only the orbs want smoothing.
  const tape = polled ?? status;
  const transport = watching && tape?.replay === true && tape.duration_s != null;

  const target = targetLine(manifest?.target);
  const booting = id === "live" && loop === null && !statusError;
  // At rest, the current run's face is decided by three reads that land in any order; none of it paints
  // until all three are in (docs/plans/08-rework-round-2.md, follow-ups §6).
  const settling = idleFaceSettling(id, mode, { row, rowError, cycles, cyclesError, state, stateError });
  const loading = booting || settling || (!cycles && !cyclesError && !row && !rowError);
  const unreachable = !!cyclesError && !cycles && !!statusError;
  const retry = () => {
    refresh();
    refreshCycles();
  };
  const owned = mode === "live" && !!loop?.running && !loop.external;
  // A positive exit code is the loop dying on its own; negative is the signal "stop run" sends.
  const crashed = id === "live" && !!loop && !loop.running && loop.exit_code !== null && loop.exit_code > 0 && !watching;
  const empty = emptyLiveFace(id, mode, rowError, state);
  const lastRun = lastRunFace(id, mode, state);

  const headerLine = (): React.ReactNode => {
    if (unreachable) return <ApiDown onRetry={retry} />;
    if (loading) return <span className="text-[var(--faint)]">loading…</span>;
    if (mode === "starting") return "starting · measuring baseline…";
    if (playing) return running ? `cycle ${status?.cycle ?? "—"} · ${verb}` : watching ? "replay" : "waiting for the loop…";
    if (crashed) {
      return (
        <>
          {`the loop stopped (exit ${loop.exit_code}) — `}
          <a href={api.loopLogUrl()} target="_blank" rel="noreferrer" className={quietLink}>
            open log
          </a>
        </>
      );
    }
    if (row) return runHeaderLine(row);
    return rowError ?? "no run yet";
  };

  const selected = selectedAgent(agents, settings.target);
  const finishedActions = mode === "finished" && !loading && !unreachable && (recordingFor(id) !== null || versions.length > 0);
  // The orbs show while something plays and, at rest, over the last run's results.
  const orbGrid = (playing || lastRun) && !loading && !unreachable;

  const actions = (
    <>
      {finishedActions && (
        <div className="tabular flex flex-wrap items-baseline gap-x-5 gap-y-1 text-[13px]">
          {recordingFor(id) !== null && (
            <button type="button" onClick={() => void watch()} disabled={startingReplay} className={cn(quietLink, "text-[var(--fg)]")}>
              <span className="u-line">{startingReplay ? "starting replay…" : "watch it back"}</span>
            </button>
          )}
          {versions.length > 0 &&
            (confirm !== null ? (
              <span className="text-[var(--muted)]">
                <button type="button" onClick={() => rollBack(confirm)} className="group rounded text-[var(--fg)]">
                  confirm roll back to v{confirm}
                </button>
                {" · "}
                <button type="button" onClick={() => setConfirm(null)} className={cn(quietLink, "text-[var(--faint)]")}>
                  cancel
                </button>
              </span>
            ) : (
              <span className="text-[var(--faint)]">
                {rolling ? "rolling back… " : "roll back to "}
                {versions.map((v, i) => (
                  <span key={v}>
                    {i > 0 && " · "}
                    <button type="button" onClick={() => rollBack(v)} disabled={rolling} className={quietLink}>
                      v{v}
                    </button>
                  </span>
                ))}
              </span>
            ))}
          {replayNote && <span className="text-[var(--faint)]">{replayNote}</span>}
        </div>
      )}
      {mode === "finished" && (rolled || rollbackError) && (
        <p className={cn("tabular text-[13px]", rollbackError ? "text-[var(--danger)]" : "text-[var(--fg)]")}>
          {rollbackError ??
            `${rolled!.config.patch_note} → live is now v${rolled!.config.version} · ${rolled!.newer_tests} ${rolled!.newer_tests === 1 ? "test is" : "tests are"} newer than this config`}
        </p>
      )}
    </>
  );

  const cyclesSection = (
    <section>
      {unreachable || loading ? null : views.length > 0 ? (
        <ErrorBoundary label="cycles" fallback={<p className="text-[13px] text-[var(--faint)]">the cycle list hit an error; the run continues</p>}>
          <CyclesBox views={views} />
        </ErrorBoundary>
      ) : (
        <p className="text-[13px] text-[var(--faint)]">
          {/* An error here with the API answering (`unreachable` is false) is the run's own 404, already in the header. */}
          {cyclesError && !cycles ? null : !cycles ? "loading…" : playing ? `${verb ?? "measuring baseline"}…` : "no cycles yet"}
        </p>
      )}
    </section>
  );

  return (
    <Page
      title={runTitle(id)}
      action={
        owned && !loading ? (
          <button type="button" onClick={stopRun} disabled={stopping} className={cn(quietLink, "text-[13px]")}>
            {stopping ? "stopping…" : "stop run"}
          </button>
        ) : watching && !transport && !loading ? (
          <button type="button" onClick={stopReplay} className={cn(quietLink, "text-[13px]")}>
            stop replay
          </button>
        ) : lastRun && !loading ? (
          <span className="flex items-center gap-5 text-[13px]">
            {clearError && (
              <span role="alert" className="text-[var(--danger)]">
                {clearError}
              </span>
            )}
            <button type="button" onClick={clearRun} disabled={clearing || !!loop?.running} className={quietLink}>
              {clearing ? "clearing…" : "clear"}
            </button>
            {row?.agent && (
              <a {...linkProps(agentRoute(row.agent.id))} className={cn(quietLink, "text-[var(--fg)]")}>
                <span className="u-line">See results</span>
              </a>
            )}
          </span>
        ) : undefined
      }
    >
      {empty ? (
        <section className="mx-auto flex w-full max-w-[720px] flex-col items-center py-6">
          {selected ? (
            <AgentCard
              agent={selected}
              ratio="free"
              title="upper"
              className="min-h-[440px] w-full"
              subline={agentSubline(selected, false)}
              name={<AgentSwitcher agents={agents} selected={selected} onSelect={(agentId) => onSettingsChange({ ...settings, target: agentId })} size="hero" />}
            >
              <div className="absolute inset-x-0 bottom-0 z-30 flex flex-col items-center rounded-b-[26px] pb-8 pt-4" style={{ background: "linear-gradient(to top, rgba(0,0,0,.55), rgba(0,0,0,0))" }}>
                <HealOrb shell={shell} settings={settings} target={selected} />
              </div>
            </AgentCard>
          ) : (
            <div className={cn(CARD_FRAME, "min-h-[440px] w-full")} aria-hidden />
          )}
          {unreachable && (
            <p className="mt-6 text-[13px]">
              <ApiDown onRetry={retry} />
            </p>
          )}
          {crashed && <p className="tabular mt-6 text-[13px] text-[var(--muted)]">{headerLine()}</p>}
        </section>
      ) : (
        <>
          <header>
            <p className="tabular text-[13px] text-[var(--muted)]">
              {headerLine()}
              {watching && !transport && !loading && recordedAt && <span className="text-[var(--faint)]">{` · recorded ${fmtTime(recordedAt)}`}</span>}
            </p>
            {mode === "finished" && !loading && !unreachable && sum.cycles > 0 && <p className="tabular mt-1 text-[13px] text-[var(--muted)]">{summaryLine(sum)}</p>}
            {transport && tape && <ReplayControls status={tape} recordedAt={recordedAt} onChanged={onReplayChanged} onStop={stopReplay} />}
            {(finishedActions || rolled || rollbackError) && <div className="mt-3 flex flex-col gap-2">{actions}</div>}
          </header>

          {/* While something plays: the run's numbers over the four agents doing the work. A finished run has no
              "who is working now" to show, so its numbers sit in the header instead. */}
          {orbGrid && (
            <section className="mt-10">
              {playing && (
              <div className="mb-8 flex justify-center">
                <StatsPlate stateKey={sum.cycles === 0 ? (running || mode === "starting" ? "measuring" : "none") : "stats"}>
                  {sum.cycles === 0 ? (
                    running || mode === "starting" ? `${verb ?? "measuring baseline"}…` : "no cycles yet"
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
              <div className="grid grid-cols-2 gap-y-8 sm:grid-cols-4">
                {AGENTS.map((agent) => {
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
                        <div className={cn("text-[12px]", isActiveWord(word) ? "text-[var(--muted)]" : "text-[var(--faint)]")}>{word}</div>
                      </figcaption>
                    </figure>
                  );
                })}
              </div>
              {target && playing && !watching && <p className="tabular mt-8 text-center text-[12px] text-[var(--faint)]">{target}</p>}
            </section>
          )}

          {/* A history run reads by version; anything playing shows the cycles as they happen. */}
          <div className="mt-10">
            {mode === "finished" && id !== "live" && cycles ? <RunResults runId={id} row={row} cycles={cycles} state={state} /> : cyclesSection}
          </div>
        </>
      )}
    </Page>
  );
}

const PLATE_PAD_X = 20; // px-5 on the inner surface
const PLATE_RIM = 1.5;

/**
 * The stats plate. Its content changes shape once ("measuring baseline…" → the five numbers, and again
 * whenever a count grows a digit), so the frame's width is animated rather than snapped: a ResizeObserver
 * reports the text's natural width and the frame springs to it. The words crossfade on `stateKey`.
 */
function StatsPlate({ stateKey, children }: { stateKey: string; children: React.ReactNode }) {
  const reduced = useMotionPref();
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
