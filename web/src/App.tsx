import { useEffect, useState } from "react";

import { api, ApiError, type LoopState, type ReplayInfo } from "@/api";
import ErrorBoundary from "@/components/ErrorBoundary";
import Shell from "@/components/Shell";
import SplashBackdrop from "@/components/ui/splash-backdrop";
import { HOME, LIVE_RUN, navigate, type Route, useRoute } from "@/lib/routes";
import { loadSettings, saveSettings, toStartBody, type RunSettings } from "@/lib/settings";
import Intro, { type StartMode } from "@/pages/Intro";
import Heal from "@/pages/Heal";
import Home from "@/pages/Home";
import AgentsList from "@/pages/Agents";
import Onboarding from "@/pages/Onboarding";
import Run from "@/pages/Run";
import Cycle from "@/pages/Cycle";
import { replayIsFor } from "@/lib/derive";

// Replay is the demo fallback for a slow live loop, so it must not be equally slow: at 1× the
// recording's 47 s gates look frozen. 3× plays the 7-cycle golden run in ~5.5 min with a visible
// phase change every few seconds. The header labels the speed so nothing is passed off as real time.
const REPLAY_SPEED = 3;

// Shown on the live run when Replay was pressed while a real run owns the screen (the API returns 409).
const REPLAY_BUSY_NOTE = "a live run is in progress · showing it instead";

/**
 * `/` is the landing page: the gradient and liquid metal live only here, and unmount before the run
 * page mounts its four orb canvases (docs/FRONTEND.md §5). Everything else is the app, inside the shell.
 */
export default function App() {
  const route = useRoute();
  // The shape of the next run, edited in the settings drawer and the wizard's First run step. Read from
  // localStorage once; written on every change (not on mount) so an untouched browser keeps no key.
  const [settings, setSettings] = useState<RunSettings>(loadSettings);
  const changeSettings = (next: RunSettings) => {
    setSettings(next);
    saveSettings(next);
  };
  if (route.kind === "landing") {
    return (
      <>
        <ErrorBoundary label="splash backdrop" fallback={null}>
          <SplashBackdrop />
        </ErrorBoundary>
        <Intro onNext={() => navigate(HOME)} />
      </>
    );
  }
  // The wizard is a full screen of its own, like the landing: no rail until there is something to show in it.
  if (route.kind === "onboarding") {
    return <Onboarding step={route.step} settings={settings} onSettingsChange={changeSettings} />;
  }
  return <AppPages route={route} settings={settings} onSettingsChange={changeSettings} />;
}

/**
 * The pages under /app. `runs` is still the old Heal screen until Block 4A replaces it; `run` is the run
 * page for any id (`pages/Run`), `cycle` its cycle page. State that must outlive one page (why a start
 * failed) lives here, above the shell's per-route fade.
 */
function AppPages({ route, settings, onSettingsChange }: { route: Route; settings: RunSettings; onSettingsChange: (next: RunSettings) => void }) {
  const [startError, setStartError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Set when Replay could not start because a live loop is running. Only the old Heal page's start path
  // writes it now; the run page reports its own 409. Goes with Heal (Block 4.7).
  const [, setReplayNote] = useState<string | null>(null);

  // Nothing plays off-screen (Block 4's replay rule): whenever the run on screen changes — a shell link,
  // browser Back, another run's page — a tape that is not that run's is stopped, so the rail's "Current
  // run" only ever reports what is visible. Decided on the API's fresh answer, never a stale poll. A
  // `/replay` arrival is left to the run page, which swaps tapes itself before starting its own.
  const runOnScreen = route.kind === "run" || route.kind === "cycle" ? route.id : null;
  const arrivingToWatch = route.kind === "run" && route.replay === true;
  useEffect(() => {
    if (arrivingToWatch) return;
    api
      .replay()
      .then((info) => (info.active && !replayIsFor(info, runOnScreen) ? api.replayStop() : undefined))
      .catch(() => undefined);
  }, [runOnScreen, arrivingToWatch]);

  const start = async (mode: StartMode, loop: LoopState | null, replay: ReplayInfo | null, refresh: () => void) => {
    setReplayNote(null);
    setStartError(null);
    if (mode === "replay") {
      // Paused by leaving the run page: continue from where it stopped. If the session vanished
      // meanwhile (404), the run page simply shows whatever the API serves now.
      if (replay?.active) {
        await api.replayResume().catch(() => undefined);
        navigate(LIVE_RUN);
        return;
      }
      setBusy(true);
      try {
        await api.replayStart(REPLAY_SPEED);
        navigate(LIVE_RUN);
      } catch (e) {
        if (e instanceof ApiError && e.status === 409) {
          // Either a live loop owns the screen (say so) or a replay is already playing (just watch it).
          const live = await api.loop().catch(() => null);
          setReplayNote(live?.running ? REPLAY_BUSY_NOTE : null);
          navigate(LIVE_RUN);
        } else {
          setStartError(e instanceof Error ? e.message : String(e));
        }
      } finally {
        setBusy(false);
        refresh();
      }
      return;
    }
    if (loop?.running) {
      navigate(LIVE_RUN);
      return;
    }
    setBusy(true);
    try {
      // Heal always means a real run. The API also discards a (paused) replay on start; doing it here
      // first keeps the UI honest if the start then fails (no "Resume replay" over a run that never began).
      if (replay?.active) await api.replayStop().catch(() => undefined);
      await api.loopStart(toStartBody(settings));
      navigate(LIVE_RUN);
    } catch (e) {
      // 409 = a loop is already running (possibly one the API did not spawn); watching it is the
      // right outcome, so it is not an error here.
      if (e instanceof ApiError && e.status === 409) navigate(LIVE_RUN);
      else setStartError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      refresh();
    }
  };

  return (
    <Shell route={route}>
      {({ loop, replay, status, statusError, health, refresh }) => {
        switch (route.kind) {
          case "home":
            return <Home loop={loop} />;
          case "onboarding":
          case "landing":
            // Rendered above the shell by App; never reached here.
            return null;
          case "replays":
            return <Placeholder title="Replays" body="Watch a past run back. This page arrives in a later step." />;
          case "settings":
            return <Placeholder title="Settings" body="Run defaults and model names. This page arrives in a later step." />;
          case "agents":
            return <AgentsList health={health} />;
          case "runs":
            return (
              <Heal
                onStart={(mode) => void start(mode, loop, replay, refresh)}
                onStopReplay={() => api.replayStop().catch(() => undefined).finally(refresh)}
                settings={settings}
                onSettingsChange={onSettingsChange}
                loopRunning={loop?.running ?? false}
                replay={replay}
                error={startError}
                busy={busy}
              />
            );
          case "run":
            return <Run id={route.id} replay={route.replay === true} shell={{ loop, replay, status, statusError, health, refresh }} navigate={navigate} />;
          case "cycle":
            return (
              <Cycle
                id={route.id}
                n={route.n}
                onBack={() => navigate({ kind: "run", id: route.id })}
                onCycle={(n) => navigate({ kind: "cycle", id: route.id, n })}
              />
            );
        }
      }}
    </Shell>
  );
}

/** A titled page with one quiet line: the shape every page under the shell shares, used where a page is not built yet. */
function Placeholder({ title, body, children }: { title: string; body?: string; children?: React.ReactNode }) {
  return (
    <main className="px-6 pb-16 pt-8 md:px-10 md:pt-7">
      <div className="mx-auto w-full max-w-[1040px]">
        <h1 className="display text-[48px] leading-[1]">{title}</h1>
        {body && <p className="mt-4 max-w-[56ch] text-[13px] leading-[1.6] text-[var(--muted)]">{body}</p>}
        {children}
      </div>
    </main>
  );
}
