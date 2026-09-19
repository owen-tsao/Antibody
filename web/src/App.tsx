import { useEffect, useState } from "react";

import { api, ApiError, type LoopState, type ReplayInfo } from "@/api";
import ErrorBoundary from "@/components/ErrorBoundary";
import Shell from "@/components/Shell";
import SplashBackdrop from "@/components/ui/splash-backdrop";
import { emptyStateFor } from "@/lib/derive";
import { HOME, LIVE_RUN, linkProps, navigate, onboarding, type Route, useRoute } from "@/lib/routes";
import { loadSettings, saveSettings, toStartBody, type RunSettings } from "@/lib/settings";
import Intro, { type StartMode } from "@/pages/Intro";
import Heal from "@/pages/Heal";
import Agents from "@/pages/Agents";
import Results from "@/pages/Results";
import Cycle from "@/pages/Cycle";

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
  return <AppPages route={route} />;
}

/**
 * The pages under /app. Today's screens keep working at their new addresses until Blocks 3–4 replace
 * them: `runs` is the old Heal screen, `run` is the old Cycles view while something is playing and
 * the old Results view once it is done, `cycle` is the cycle page. State that must outlive one page
 * (the next run's settings, why a start failed) lives here, above the shell's per-route fade.
 */
function AppPages({ route }: { route: Route }) {
  const [startError, setStartError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Set when Replay could not start because a live loop is running; the run page shows the live run
  // with this note instead of a "replay · recorded" label that would be false.
  const [replayNote, setReplayNote] = useState<string | null>(null);
  // The shape of the next run, edited in the settings drawer. Read from localStorage once; written
  // on every change (not on mount) so an untouched browser keeps no key and a cleared one means defaults.
  const [settings, setSettings] = useState<RunSettings>(loadSettings);
  const changeSettings = (next: RunSettings) => {
    setSettings(next);
    saveSettings(next);
  };

  // Nothing plays off-screen: whenever the screen is not the live run — a shell link, browser Back, or
  // a deep link arriving with a tape still playing — a playing replay is frozen where it is, so the
  // runs page can honestly offer "Resume replay". Decided on the API's fresh answer, never a stale
  // flag, so a tape that was just stopped is left alone.
  const onLiveRun = route.kind === "run" && route.id === "live";
  useEffect(() => {
    if (onLiveRun) return;
    api
      .replay()
      .then((info) => (info.active && !info.paused ? api.replayPause() : undefined))
      .catch(() => undefined);
  }, [onLiveRun]);

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
            return <Placeholder title="Home" />;
          case "onboarding":
            return <Placeholder title="Connect your support agent" />;
          case "replays":
            return <Placeholder title="Replays" body="Watch a past run back. This page arrives in a later step." />;
          case "settings":
            return <Placeholder title="Settings" body="Run defaults and model names. This page arrives in a later step." />;
          case "agents": {
            const empty = emptyStateFor(route.kind, health);
            return (
              <main className="px-6 pb-16 pt-8 md:px-10 md:pt-7">
                <div className="mx-auto w-full max-w-[1040px]">
                  <h1 className="display text-[48px] leading-[1]">{empty.title}</h1>
                  <p className="mt-4 max-w-[56ch] text-[13px] leading-[1.6] text-[var(--muted)]">{empty.body}</p>
                  <p className="mt-6 text-[13px]">
                    <a {...linkProps(onboarding(1))} className="group rounded text-[var(--muted)] transition-colors hover:text-[var(--fg)]">
                      <span className="u-line">connect an agent</span>
                    </a>
                  </p>
                </div>
              </main>
            );
          }
          case "runs":
            return (
              <Heal
                onStart={(mode) => void start(mode, loop, replay, refresh)}
                onStopReplay={() => api.replayStop().catch(() => undefined).finally(refresh)}
                settings={settings}
                onSettingsChange={changeSettings}
                loopRunning={loop?.running ?? false}
                replay={replay}
                error={startError}
                busy={busy}
              />
            );
          case "run":
            if (route.id !== "live") return <HistoryRunPlaceholder id={route.id} />;
            // While something is playing the run is the four agents at work; once it is over, the proof.
            return loop?.running || replay?.active ? (
              <Agents replayNote={replayNote} loop={loop} status={status} statusError={statusError} refresh={refresh} />
            ) : (
              <Results onCycle={(n) => navigate({ kind: "cycle", id: "live", n })} />
            );
          case "cycle":
            if (route.id !== "live") return <HistoryRunPlaceholder id={route.id} />;
            return (
              <Cycle
                n={route.n}
                onBack={() => navigate({ kind: "run", id: route.id })}
                onCycle={(n) => navigate({ kind: "cycle", id: route.id, n })}
              />
            );
          case "landing":
            return null;
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

/**
 * `/app/runs/<id>` for an archived run. The read routes already serve any run (`?source=run:<id>`), but
 * today's pages read only the live files; showing them here would label the wrong run. Block 4 builds
 * the real run page. Until then this says so instead of guessing.
 */
function HistoryRunPlaceholder({ id }: { id: string }) {
  return (
    <Placeholder title={id === "golden" ? "Demo tape" : `Run ${id}`}>
      <p className="mt-4 max-w-[56ch] text-[13px] leading-[1.6] text-[var(--muted)]">
        Past runs open here in a later step. Until then, the{" "}
        <a {...linkProps(LIVE_RUN)} className="group rounded text-[var(--muted)] transition-colors hover:text-[var(--fg)]">
          <span className="u-line">current run</span>
        </a>{" "}
        is the one on screen.
      </p>
    </Placeholder>
  );
}
