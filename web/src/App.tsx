import { useEffect, useState } from "react";

import { api, type Agent, type LoopState, type RunRow } from "@/api";
import ErrorBoundary from "@/components/ErrorBoundary";
import Shell from "@/components/Shell";
import SplashBackdrop from "@/components/ui/splash-backdrop";
import { isFirstRun, replayIsFor } from "@/lib/derive";
import { loadPrefs, PrefsContext, savePrefs, type Prefs } from "@/lib/prefs";
import { HOME, navigate, onboarding, onboardingSkipped, replace, type Route, useRoute } from "@/lib/routes";
import { loadSettings, saveSettings, type RunSettings } from "@/lib/settings";
import Intro from "@/pages/Intro";
import Home from "@/pages/Home";
import AgentPage from "@/pages/Agent";
import Agents from "@/pages/Agents";
import Onboarding from "@/pages/Onboarding";
import Review from "@/pages/Review";
import Runs from "@/pages/Runs";
import Schedules from "@/pages/Schedules";
import Settings from "@/pages/Settings";
import Run from "@/pages/Run";
import Cycle from "@/pages/Cycle";

/** Display preferences live above every page so `usePoll` and every motion read see one value. */
export default function App() {
  const [prefs, setPrefsState] = useState<Prefs>(loadPrefs);
  const setPrefs = (next: Prefs) => {
    setPrefsState(next);
    savePrefs(next);
  };
  return (
    <PrefsContext.Provider value={{ prefs, setPrefs }}>
      <Routed />
    </PrefsContext.Provider>
  );
}

/**
 * `/` is the landing page: the gradient and liquid metal live only here, and unmount before the run
 * page mounts its four orb canvases (docs/FRONTEND.md §5). Everything else is the app, inside the shell.
 */
function Routed() {
  const route = useRoute();
  // The shape of the next run, edited on the Settings page, the rail's agent switcher
  // and the wizard's First run step. Read from localStorage once; written on every change (not on mount)
  // so an untouched browser keeps no key.
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
 * The pages under /app. `run` is the run page for any id (`pages/Run`; `live` is Current run), `cycle` its
 * cycle page; the rest are the shell's pages. Only the replay rule and the first-run rule live here, above
 * the shell's per-route fade.
 */
function AppPages({ route, settings, onSettingsChange }: { route: Route; settings: RunSettings; onSettingsChange: (next: RunSettings) => void }) {
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

  return (
    <Shell route={route} settings={settings} onSettingsChange={onSettingsChange}>
      {(data) => {
        const { loop, agents, runs, runsError, refresh } = data;
        return (
          <>
            <FirstRun agents={agents} runs={runs} loop={loop} />
            {(() => {
              switch (route.kind) {
                case "onboarding":
                case "landing":
                  // Rendered above the shell by App; never reached here.
                  return null;
                case "home":
                  return <Home shell={data} settings={settings} onSettingsChange={onSettingsChange} />;
                case "settings":
                  return <Settings section={route.section} settings={settings} onSettingsChange={onSettingsChange} shell={data} />;
                case "agents":
                  return <Agents shell={data} settings={settings} onSettingsChange={onSettingsChange} />;
                case "agent":
                  return <AgentPage id={route.id} shell={data} />;
                case "runs":
                  return <Runs runs={runs} runsError={runsError} loop={loop} refresh={refresh} />;
                case "schedules":
                  return <Schedules shell={data} settings={settings} />;
                case "review":
                  return <Review run={route.run} v={route.v} shell={data} />;
                case "run":
                  return (
                    <Run
                      id={route.id}
                      replay={route.replay === true}
                      shell={data}
                      settings={settings}
                      onSettingsChange={onSettingsChange}
                    />
                  );
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
            })()}
          </>
        );
      }}
    </Shell>
  );
}

/**
 * The first-run rule on every shell page: nothing connected, nothing run → the wizard. Lives here rather than
 * on Home so it holds on any deep link; a component so it can sit inside the shell's render prop without hooks in a switch.
 */
function FirstRun({ agents, runs, loop }: { agents: Agent[] | null; runs: RunRow[] | null; loop: LoopState | null }) {
  const redirect = isFirstRun(agents, runs, loop) === true && !onboardingSkipped();
  useEffect(() => {
    if (redirect) replace(onboarding(1));
  }, [redirect]);
  return null;
}
