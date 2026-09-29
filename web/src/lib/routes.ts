// Hand-rolled routing (docs/plans/00-overview.md, Blocks 2–3; 07-app-rework.md): the app has a dozen
// addresses and no router dependency. `parse` and `href` are pure; `href(parse(p)) === p` for every
// canonical address, and the few legacy addresses `parse` still accepts are rewritten by `redirectLegacy`.
// `navigate` is pushState plus a notification; `useRoute` is the one subscription. Everything the UI
// knows about the URL is here.

import { type MouseEvent, useSyncExternalStore } from "react";

export type OnboardingStep = 1 | 2 | 3 | 4 | 5;

export const SETTINGS_SECTIONS = ["run-defaults", "display", "models", "environment", "access"] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

export type Route =
  | { kind: "landing" }
  | { kind: "home" }
  | { kind: "onboarding"; step: OnboardingStep }
  | { kind: "agents" }
  | { kind: "agent"; id: string }
  | { kind: "runs" }
  | { kind: "schedules" }
  /**
   * The review inbox (plan 11 §2), or its editor for one version of one run (`/app/review/:run/:version`).
   * The old `?run=<id>&v=<n>` query still parses to the editor and is rewritten by `redirectLegacy`.
   */
  | { kind: "review"; run?: string; v?: number }
  /**
   * `id: "live"` is the current run (`/app/run`): running, or finished and not yet archived (Block 4's
   * identity rule). `replay` = arrive watching: `/app/runs/:id/replay` starts the run's tape.
   */
  | { kind: "run"; id: string; replay?: boolean }
  | { kind: "cycle"; id: string; n: number }
  | { kind: "settings"; section: SettingsSection };

export const LANDING: Route = { kind: "landing" };
export const HOME: Route = { kind: "home" };
export const RUNS: Route = { kind: "runs" };
export const SCHEDULES: Route = { kind: "schedules" };
export const AGENTS: Route = { kind: "agents" };
export const REVIEW: Route = { kind: "review" };
export const SETTINGS: Route = { kind: "settings", section: "run-defaults" };
export const LIVE_RUN: Route = { kind: "run", id: "live" };

export const onboarding = (step: OnboardingStep): Route => ({ kind: "onboarding", step });
export const agent = (id: string): Route => ({ kind: "agent", id });
export const settings = (section: SettingsSection): Route => ({ kind: "settings", section });
/** The Review editor for version `v` of `run`. */
export const reviewVersion = (run: string, v: number): Route => ({ kind: "review", run, v });

// "Skip for now" must land in the app and stay there, or the first-run rule would send the person straight
// back. Remembered for the tab's session only: a fresh visit with still nothing connected gets the wizard again.
const SKIPPED_KEY = "antibody:onboarding-skipped";
export const skipOnboarding = () => sessionStorage.setItem(SKIPPED_KEY, "1");
export const onboardingSkipped = () => sessionStorage.getItem(SKIPPED_KEY) === "1";

// Run ids are history folder names, `live` or `golden` (api/store.py); agent ids are `token_urlsafe` or the
// two fixed names (api/agents.py). Both fit the same shape the API accepts.
const ID = /^[A-Za-z0-9T_-]+$/;

function onboardingStep(raw: string | undefined): OnboardingStep {
  const n = Number(raw);
  return n === 2 || n === 3 || n === 4 || n === 5 ? n : 1;
}

function isSection(raw: string | undefined): raw is SettingsSection {
  return (SETTINGS_SECTIONS as readonly string[]).includes(raw ?? "");
}

/** A run address's tail: `/replay` or `/cycles/:n`, shared by `/app/run` and `/app/runs/:id`. */
function runRoute(id: string, sub: string | undefined, n: string | undefined): Route {
  if (sub === "cycles" && n !== undefined) {
    const cycle = Number(n);
    if (Number.isInteger(cycle) && cycle > 0) return { kind: "cycle", id, n: cycle };
  }
  if (sub === "replay" && n === undefined) return { kind: "run", id, replay: true };
  return { kind: "run", id };
}

/**
 * The Review address: `/app/review/:run/:version` is the editor; the retired `?run=<id>&v=<n>` query still means
 * it (and `?run=` alone means the inbox — there is no per-run page any more). Anything malformed is the inbox.
 */
function reviewRoute(id: string | undefined, sub: string | undefined, search: string): Route {
  if (id !== undefined) {
    const v = Number(sub);
    return ID.test(id) && sub !== undefined && Number.isInteger(v) && v >= 0 ? reviewVersion(id, v) : REVIEW;
  }
  const q = new URLSearchParams(search);
  const run = q.get("run");
  const v = Number(q.get("v"));
  if (!run || !ID.test(run) || !q.has("v") || !Number.isInteger(v) || v < 0) return REVIEW;
  return reviewVersion(run, v);
}

/**
 * `/app` → home; anything unknown under it → runs; anything unknown elsewhere → landing. Retired
 * addresses still resolve (`/app/replays`, `/app/runs/live…`, `/app/agents/new`) so old links and bookmarks
 * work; `redirectLegacy` then rewrites the bar. Only the Review page's retired query is read.
 */
export function parse(pathname: string, search = ""): Route {
  const parts = pathname.split("/").filter(Boolean);
  if (parts[0] !== "app") return LANDING;
  const [, section, id, sub, n] = parts;
  if (section === undefined || section === "home") return HOME;
  if (section === "onboarding") return onboarding(onboardingStep(id));
  if (section === "agents") {
    if (id === undefined) return AGENTS;
    // The pre-wizard connect address; the wizard's Connect step is what it meant.
    if (id === "new") return onboarding(2);
    return ID.test(id) ? agent(id) : AGENTS;
  }
  if (section === "run") return runRoute("live", id, sub);
  if (section === "replays") return RUNS;
  if (section === "schedules") return SCHEDULES;
  if (section === "review") return reviewRoute(id, sub, search);
  if (section === "settings") return isSection(id) ? settings(id) : SETTINGS;
  if (section === "runs" && id && ID.test(id)) return runRoute(id, sub, n);
  return RUNS;
}

/** The address as `pathname`; no canonical address carries a query string any more. */
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
    case "agent":
      return `/app/agents/${route.id}`;
    case "runs":
      return "/app/runs";
    case "schedules":
      return "/app/schedules";
    case "review":
      return route.run !== undefined && route.v !== undefined ? `/app/review/${route.run}/${route.v}` : "/app/review";
    case "run": {
      const base = route.id === "live" ? "/app/run" : `/app/runs/${route.id}`;
      return route.replay ? `${base}/replay` : base;
    }
    case "cycle":
      return route.id === "live" ? `/app/run/cycles/${route.n}` : `/app/runs/${route.id}/cycles/${route.n}`;
    case "settings":
      return `/app/settings/${route.section}`;
  }
}

/**
 * The address a pre-shell `?page=…&n=…` link meant (docs/HANDOFF.md and the ui-1 handoff embed them),
 * or null when the query carries no legacy page. Pure so it can be read as a table.
 */
function legacyRoute(search: string): Route | null {
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

/** The bar's address as `parse`/`href` see it: pathname plus query. */
const address = () => window.location.pathname + window.location.search;

/**
 * Called once before the first render: rewrites a legacy `?page=` URL, or any retired path `parse` still
 * accepts, to its canonical address in place, leaving no history entry behind.
 */
export function redirectLegacy(): void {
  const target = legacyRoute(window.location.search) ?? parse(window.location.pathname, window.location.search);
  const to = href(target);
  if (to !== address()) window.history.replaceState(null, "", to);
}

const listeners = new Set<() => void>();
const notify = () => listeners.forEach((fn) => fn());

export function navigate(route: Route): void {
  const to = href(route);
  if (to !== address()) {
    window.history.pushState(null, "", to);
    // A new screen starts at its top; Back/Forward keep the browser's own scroll restoration.
    window.scrollTo(0, 0);
  }
  notify();
}

/** Like `navigate`, but the current entry is rewritten: Back never returns to the address being left (redirects). */
export function replace(route: Route): void {
  const to = href(route);
  if (to !== address()) window.history.replaceState(null, "", to);
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

/** The current route; re-renders on `navigate` and on the browser's Back/Forward. */
export function useRoute(): Route {
  useSyncExternalStore(subscribe, address, address);
  return parse(window.location.pathname, window.location.search);
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
