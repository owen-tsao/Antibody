import { lazy, Suspense, useEffect, useState } from "react";

import { api, ApiError, type LoopState, type ReplayInfo } from "@/api";
import ErrorBoundary from "@/components/ErrorBoundary";
import SplashBackdrop from "@/components/ui/splash-backdrop";
import Intro, { type StartMode } from "@/pages/Intro";
import Heal from "@/pages/Heal";
import Agents from "@/pages/Agents";
import Results from "@/pages/Results";
import Cycle from "@/pages/Cycle";

export type Page = "intro" | "heal" | "agents" | "results" | "cycle";

// How many novel attacks a Heal press asks the loop for (`--chaos-cycles`). 1 for the demo: the two seed
// attacks already tell the break → repair → block story, and each extra Chaos cycle costs ~2 min of
// gates on stage (the 3-cycle run measured 15 min end to end). The stepper and the "until N in a row
// are blocked" rule are deferred, not rejected; the backend contract (`mode`, `chaos_cycles`) is unchanged.
const DEMO_CHAOS_CYCLES = 1;

// Replay is the demo fallback for a slow live loop, so it must not be equally slow: at 1× the
// recording's 47 s gates look frozen. 3× plays the 7-cycle golden run in ~5.5 min with a visible
// phase change every few seconds. The header labels the speed so nothing is passed off as real time.
const REPLAY_SPEED = 3;

// Shown on Agents when Replay was pressed while a real run owns the screen (the API returns 409).
const REPLAY_BUSY_NOTE = "a live run is in progress · showing it instead";

// Heal re-reads /api/loop and /api/replay at this cadence so its labels track reality: a run that
// finished stops saying "View agents", and the "Resume replay · m:ss / m:ss" progress moves.
const HEAL_POLL_MS = 2_000;

// ?demo=<name> renders one pasted component in isolation so each can be verified
// exactly as shipped before it is wired to real data. Not part of the product.
const demos = {
  hero: lazy(() => import("@/demos/LiquidMetalHeroDemo")),
  orb: lazy(() => import("@/demos/OrbDemo")),
  list: lazy(() => import("@/demos/InteractiveListPreviewDemo")),
  plan: lazy(() => import("@/demos/AgentPlanDemo")),
} as const;

const PAGES: readonly Page[] = ["intro", "heal", "agents", "results", "cycle"];

export default function App() {
  const params = new URLSearchParams(window.location.search);
  const demo = params.get("demo");
  const initial = params.get("page");
  const initialN = Number(params.get("n"));
  const [page, setPage] = useState<Page>(PAGES.includes(initial as Page) ? (initial as Page) : "intro");
  // `?page=cycle&n=3` deep-links one cycle; otherwise the number is set when a Results row is clicked.
  const [cycleN, setCycleN] = useState<number | null>(Number.isInteger(initialN) && initialN > 0 ? initialN : null);

  // Heal screen state (docs/FRONTEND.md §4.1). `loop` decides whether Heal spawns a run or just navigates;
  // `replay` decides whether the quiet link starts, resumes, or describes the recording. Both are
  // polled while the Heal screen is shown so a finished run does not leave "View agents" behind.
  const [loop, setLoop] = useState<LoopState | null>(null);
  const [replay, setReplay] = useState<ReplayInfo | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Set when Replay could not start because a live loop is running; Agents shows the live run with
  // this note instead of a "replay · recorded" label that would be false.
  const [replayNote, setReplayNote] = useState<string | null>(null);

  const refreshHeal = () => {
    api.loop().then(setLoop).catch(() => setLoop(null));
    api.replay().then(setReplay).catch(() => setReplay(null));
  };
  useEffect(() => {
    if (page !== "heal") return;
    // Heal knows two replay states: none, or paused. Back on Agents pauses before navigating, but a
    // `?page=heal` deep link (or a lost pause request) can arrive with one still playing; freeze it
    // here so nothing advances off-screen and the link can honestly say "Resume".
    api
      .replay()
      .then((info) => (info.active && !info.paused ? api.replayPause() : info))
      .then(setReplay)
      .catch(() => setReplay(null));
    api.loop().then(setLoop).catch(() => setLoop(null));
    const timer = setInterval(refreshHeal, HEAL_POLL_MS);
    return () => clearInterval(timer);
  }, [page]);
  // Keep the address bar honest so a refresh (or a shared link) lands on the same screen.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    q.set("page", page);
    if (page === "cycle" && cycleN !== null) q.set("n", String(cycleN));
    else q.delete("n");
    window.history.replaceState(null, "", `?${q.toString()}`);
  }, [page, cycleN]);

  const start = async (mode: StartMode) => {
    setReplayNote(null);
    setStartError(null);
    if (mode === "replay") {
      // Paused by Back: continue from where it stopped. If the session vanished meanwhile (404),
      // Agents simply shows whatever the API serves now.
      if (replay?.active) {
        await api.replayResume().catch(() => undefined);
        setPage("agents");
        return;
      }
      setBusy(true);
      try {
        await api.replayStart(REPLAY_SPEED);
        setPage("agents");
      } catch (e) {
        if (e instanceof ApiError && e.status === 409) {
          // Either a live loop owns the screen (say so) or a replay is already playing (just watch it).
          const live = await api.loop().catch(() => null);
          setReplayNote(live?.running ? REPLAY_BUSY_NOTE : null);
          setPage("agents");
        } else {
          setStartError(e instanceof Error ? e.message : String(e));
        }
      } finally {
        setBusy(false);
      }
      return;
    }
    if (loop?.running) {
      setPage("agents");
      return;
    }
    setBusy(true);
    try {
      // Heal always means a real run. The API also discards a (paused) replay on start; doing it here
      // first keeps the UI honest if the start then fails (no "Resume replay" over a run that never began).
      if (replay?.active) await api.replayStop().catch(() => undefined);
      await api.loopStart({ mode: "fixed", chaos_cycles: DEMO_CHAOS_CYCLES });
      setPage("agents");
    } catch (e) {
      // 409 = a loop is already running (possibly one the API did not spawn); watching it is the
      // right outcome, so it is not an error here.
      if (e instanceof ApiError && e.status === 409) setPage("agents");
      else {
        setStartError(e instanceof Error ? e.message : String(e));
        refreshHeal();
      }
    } finally {
      setBusy(false);
    }
  };

  const stopReplay = async () => {
    await api.replayStop().catch(() => undefined);
    refreshHeal();
  };

  if (demo && Object.hasOwn(demos, demo)) {
    const Demo = demos[demo as keyof typeof demos];
    return (
      <Suspense fallback={null}>
        <Demo />
      </Suspense>
    );
  }

  // The gradient + liquid metal are mounted once for both splash screens so intro -> heal does not
  // remount the shaders. They unmount before Agents mounts its four orb canvases (docs/FRONTEND.md §5).
  const onGradient = page === "intro" || page === "heal";

  const openCycle = (n: number) => {
    setCycleN(n);
    setPage("cycle");
  };

  return (
    <>
      {onGradient && (
        <ErrorBoundary label="splash backdrop" fallback={null}>
          <SplashBackdrop />
        </ErrorBoundary>
      )}
      {page === "intro" && <Intro onNext={() => setPage("heal")} />}
      {page === "heal" && (
        <Heal
          onBack={() => setPage("intro")}
          onStart={start}
          onStopReplay={stopReplay}
          loopRunning={loop?.running ?? false}
          replay={replay}
          error={startError}
          busy={busy}
        />
      )}
      {page === "agents" && (
        <Agents replayNote={replayNote} onBack={() => setPage("heal")} onResults={() => setPage("results")} />
      )}
      {page === "results" && <Results onAgents={() => setPage("agents")} onCycle={openCycle} />}
      {page === "cycle" && (cycleN === null ? (
        // Deep link without a number: nothing to show, fall through to the list.
        <Results onAgents={() => setPage("agents")} onCycle={openCycle} />
      ) : (
        <Cycle n={cycleN} onBack={() => setPage("results")} onCycle={openCycle} />
      ))}
    </>
  );
}
