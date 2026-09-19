// Hand-rolled routing (docs/plans/00-overview.md, Blocks 2–3): the app has a dozen addresses and no
// router dependency. `parse` and `href` are pure and inverse of each other; `navigate` is pushState plus a
// notification; `useRoute` is the one subscription. Everything the UI knows about the URL is here.

import { type MouseEvent, useSyncExternalStore } from "react";

export type OnboardingStep = 1 | 2 | 3 | 4;

export type Route =
  | { kind: "landing" }
  | { kind: "home" }
  | { kind: "onboarding"; step: OnboardingStep }
  | { kind: "agents" }
  | { kind: "runs" }
  /** `replay` = arrive watching: `/app/runs/:id/replay` starts the run's tape (Replays page's "watch"). */
  | { kind: "run"; id: string; replay?: boolean }
  | { kind: "cycle"; id: string; n: number }
  | { kind: "replays" }
  | { kind: "settings" };

export const LANDING: Route = { kind: "landing" };
export const HOME: Route = { kind: "home" };
export const RUNS: Route = { kind: "runs" };
export const AGENTS: Route = { kind: "agents" };
export const REPLAYS: Route = { kind: "replays" };
export const SETTINGS: Route = { kind: "settings" };

/** `/app/runs/live` is the current run: running, or finished and not yet archived (Block 4's identity rule). */
export const LIVE_RUN: Route = { kind: "run", id: "live" };

export const onboarding = (step: OnboardingStep): Route => ({ kind: "onboarding", step });

// "Skip for now" must land on Home and stay there, or the first-run rule would send the person straight
// back. Remembered for the tab's session only: a fresh visit with still nothing connected gets the wizard again.
const SKIPPED_KEY = "antibody:onboarding-skipped";
export const skipOnboarding = () => sessionStorage.setItem(SKIPPED_KEY, "1");
export const onboardingSkipped = () => sessionStorage.getItem(SKIPPED_KEY) === "1";

// Run ids are history folder names, `live` or `golden` (api/store.py); the same shape the API accepts.
const RUN_ID = /^[A-Za-z0-9T_-]+$/;

function onboardingStep(raw: string | undefined): OnboardingStep {
  const n = Number(raw);
  return n === 2 || n === 3 || n === 4 ? n : 1;
}

/** `/app` → home; anything unknown under it → runs; anything unknown elsewhere → landing. */
export function parse(pathname: string): Route {
  const parts = pathname.split("/").filter(Boolean);
  if (parts[0] !== "app") return LANDING;
  const [, section, id, sub, n] = parts;
  if (section === undefined || section === "home") return HOME;
  if (section === "onboarding") return onboarding(onboardingStep(id));
  // The pre-wizard connect address; the wizard's Connect step is what it meant.
  if (section === "agents") return id === "new" ? onboarding(2) : AGENTS;
  if (section === "replays") return REPLAYS;
  if (section === "settings") return SETTINGS;
  if (section === "runs" && id && RUN_ID.test(id)) {
    if (sub === "cycles" && n !== undefined) {
      const cycle = Number(n);
      if (Number.isInteger(cycle) && cycle > 0) return { kind: "cycle", id, n: cycle };
    }
    if (sub === "replay" && n === undefined) return { kind: "run", id, replay: true };
    return { kind: "run", id };
  }
  return RUNS;
}

export function href(route: Route): string {
  switch (route.kind) {
    case "landing":
      return "/";
    case "home":
      return "/app/home";
    case "onboarding":
      return `/app/onboarding/${route.step}`;
    case "agents":
      return "/app/agents";
    case "runs":
      return "/app/runs";
    case "run":
      return route.replay ? `/app/runs/${route.id}/replay` : `/app/runs/${route.id}`;
    case "cycle":
      return `/app/runs/${route.id}/cycles/${route.n}`;
    case "replays":
      return "/app/replays";
    case "settings":
      return "/app/settings";
  }
}

/**
 * The address a pre-shell `?page=…&n=…` link meant (docs/HANDOFF.md and the ui-1 handoff embed them),
 * or null when the query carries no legacy page. Pure so it can be read as a table.
 */
export function legacyRoute(search: string): Route | null {
  const q = new URLSearchParams(search);
  const page = q.get("page");
  if (page === null) return null;
  const n = Number(q.get("n"));
  switch (page) {
    case "intro":
      return LANDING;
    case "heal":
      return RUNS;
    case "cycle":
      return Number.isInteger(n) && n > 0 ? { kind: "cycle", id: "live", n } : LIVE_RUN;
    case "agents":
    case "results":
      return LIVE_RUN;
    default:
      return null;
  }
}

/**
 * Called once before the first render: rewrites a legacy `?page=` URL, or the pre-wizard `/app/agents/new`,
 * in place, leaving no history entry behind.
 */
export function redirectLegacy(): void {
  const target = legacyRoute(window.location.search) ?? (window.location.pathname === "/app/agents/new" ? onboarding(2) : null);
  if (target) window.history.replaceState(null, "", href(target));
}

const listeners = new Set<() => void>();
const notify = () => listeners.forEach((fn) => fn());

export function navigate(route: Route): void {
  const to = href(route);
  if (to !== window.location.pathname) {
    window.history.pushState(null, "", to);
    // A new screen starts at its top; Back/Forward keep the browser's own scroll restoration.
    window.scrollTo(0, 0);
  }
  notify();
}

/** Like `navigate`, but the current entry is rewritten: Back never returns to the address being left (redirects). */
export function replace(route: Route): void {
  const to = href(route);
  if (to !== window.location.pathname) window.history.replaceState(null, "", to);
  notify();
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  window.addEventListener("popstate", fn);
  return () => {
    listeners.delete(fn);
    window.removeEventListener("popstate", fn);
  };
}

const pathname = () => window.location.pathname;

/** The current route; re-renders on `navigate` and on the browser's Back/Forward. */
export function useRoute(): Route {
  return parse(useSyncExternalStore(subscribe, pathname, pathname));
}

/**
 * Props for an `<a>` that stays a real link (middle-click, cmd-click, copy address all work) but
 * navigates in place on a plain left click.
 */
export function linkProps(route: Route): { href: string; onClick: (e: MouseEvent<HTMLAnchorElement>) => void } {
  return {
    href: href(route),
    onClick: (e) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      navigate(route);
    },
  };
}
