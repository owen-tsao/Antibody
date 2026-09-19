import { useEffect, useState } from "react";

import { api } from "@/api";
import ErrorBoundary from "@/components/ErrorBoundary";
import Shell from "@/components/Shell";
import SplashBackdrop from "@/components/ui/splash-backdrop";
import { HOME, navigate, type Route, useRoute } from "@/lib/routes";
import { loadSettings, saveSettings, type RunSettings } from "@/lib/settings";
import Intro from "@/pages/Intro";
import Home from "@/pages/Home";
import AgentsList from "@/pages/Agents";
import Onboarding from "@/pages/Onboarding";
import Runs from "@/pages/Runs";
import Replays from "@/pages/Replays";
import Settings from "@/pages/Settings";
import Run from "@/pages/Run";
import Cycle from "@/pages/Cycle";
import { replayIsFor } from "@/lib/derive";

/**
 * `/` is the landing page: the gradient and liquid metal live only here, and unmount before the run
 * page mounts its four orb canvases (docs/FRONTEND.md §5). Everything else is the app, inside the shell.
 */
export default function App() {
  const route = useRoute();
  // The shape of the next run, edited in the start dialog, the Settings page and the wizard's First run
  // step. Read from localStorage once; written on every change (not on mount) so an untouched browser keeps no key.
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
 * The pages under /app. `run` is the run page for any id (`pages/Run`), `cycle` its cycle page; the rest are
 * the shell's pages. Only the replay rule lives here, above the shell's per-route fade.
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
    <Shell route={route}>
      {({ loop, replay, status, statusError, health, refresh }) => {
        switch (route.kind) {
          case "home":
            return <Home loop={loop} health={health} refresh={refresh} settings={settings} onSettingsChange={onSettingsChange} />;
          case "onboarding":
          case "landing":
            // Rendered above the shell by App; never reached here.
            return null;
          case "replays":
            return <Replays />;
          case "settings":
            return <Settings settings={settings} onSettingsChange={onSettingsChange} health={health} />;
          case "agents":
            return <AgentsList health={health} />;
          case "runs":
            return <Runs loop={loop} health={health} refresh={refresh} settings={settings} onSettingsChange={onSettingsChange} />;
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
