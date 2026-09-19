import { useEffect, useState } from "react";

import { api } from "@/api";
import ErrorBoundary from "@/components/ErrorBoundary";
import Shell from "@/components/Shell";
import SplashBackdrop from "@/components/ui/splash-backdrop";
import { HOME, LIVE_RUN, linkProps, navigate, type Route, useRoute } from "@/lib/routes";
import { loadSettings, saveSettings, type RunSettings } from "@/lib/settings";
import Intro from "@/pages/Intro";
import Home from "@/pages/Home";
import AgentsList from "@/pages/Agents";
import Onboarding from "@/pages/Onboarding";
import Runs from "@/pages/Runs";
import Replays from "@/pages/Replays";
import Settings from "@/pages/Settings";
import RunLive from "@/pages/RunLive";
import Results from "@/pages/Results";
import Cycle from "@/pages/Cycle";

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
 * The pages under /app. `run` is the old Cycles view while something is playing and the old Results view
 * once it is done, `cycle` is the cycle page — both being rewritten by lane 4B (docs/plans/00-overview.md
 * Block 4.6); everything else is the shell's pages.
 */
function AppPages({ route, settings, onSettingsChange }: { route: Route; settings: RunSettings; onSettingsChange: (next: RunSettings) => void }) {
  // The "a live run is in progress · showing it instead" note left with the Heal page; the run branch below
  // still names the prop until lane 4B's rewrite of that branch lands, so it reads null here meanwhile.
  const replayNote = null;

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
            if (route.id !== "live") return <HistoryRunPlaceholder id={route.id} />;
            // While something is playing the run is the four agents at work; once it is over, the proof.
            return loop?.running || replay?.active ? (
              <RunLive replayNote={replayNote} loop={loop} status={status} statusError={statusError} refresh={refresh} />
            ) : (
              <Results loop={loop} onCycle={(n) => navigate({ kind: "cycle", id: "live", n })} />
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
        }
      }}
    </Shell>
  );
}

/** A titled page with quiet lines beneath: the shape every page under the shell shares, used where a page is not built yet. */
function Placeholder({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <main className="px-6 pb-16 pt-8 md:px-10 md:pt-7">
      <div className="mx-auto w-full max-w-[1040px]">
        <h1 className="display text-[48px] leading-[1]">{title}</h1>
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
