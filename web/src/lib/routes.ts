// Hand-rolled routing (docs/plans/00-overview.md, Block 2): the app has six addresses and no router
// dependency. `parse` and `href` are pure and inverse of each other; `navigate` is pushState plus a
// notification; `useRoute` is the one subscription. Everything the UI knows about the URL is here.

import { type MouseEvent, useSyncExternalStore } from "react";

export type Route =
  | { kind: "landing" }
  | { kind: "agents" }
  | { kind: "agent-new" }
  | { kind: "runs" }
  | { kind: "run"; id: string }
  | { kind: "cycle"; id: string; n: number };

export const LANDING: Route = { kind: "landing" };
export const RUNS: Route = { kind: "runs" };
export const AGENTS: Route = { kind: "agents" };

/** `/app/runs/live` is the current run: running, or finished and not yet archived (Block 4's identity rule). */
export const LIVE_RUN: Route = { kind: "run", id: "live" };

// Run ids are history folder names, `live` or `golden` (api/store.py); the same shape the API accepts.
const RUN_ID = /^[A-Za-z0-9T_-]+$/;

/** `/app` and anything unknown under it → runs; anything unknown elsewhere → landing. */
export function parse(pathname: string): Route {
  const parts = pathname.split("/").filter(Boolean);
  if (parts[0] !== "app") return LANDING;
  const [, section, id, sub, n] = parts;
  if (section === "agents") return id === "new" ? { kind: "agent-new" } : AGENTS;
  if (section === "runs" && id && RUN_ID.test(id)) {
    if (sub === "cycles" && n !== undefined) {
      const cycle = Number(n);
      if (Number.isInteger(cycle) && cycle > 0) return { kind: "cycle", id, n: cycle };
    }
    return { kind: "run", id };
  }
  return RUNS;
}

export function href(route: Route): string {
  switch (route.kind) {
    case "landing":
      return "/";
    case "agents":
      return "/app/agents";
    case "agent-new":
      return "/app/agents/new";
    case "runs":
      return "/app/runs";
    case "run":
      return `/app/runs/${route.id}`;
    case "cycle":
      return `/app/runs/${route.id}/cycles/${route.n}`;
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

/** Called once before the first render: rewrites a legacy `?page=` URL in place, leaving no history entry behind. */
export function redirectLegacy(): void {
  const target = legacyRoute(window.location.search);
  if (target) window.history.replaceState(null, "", href(target));
}

const listeners = new Set<() => void>();
const notify = () => listeners.forEach((fn) => fn());

export function navigate(route: Route): void {
  const to = href(route);
  if (to !== window.location.pathname) window.history.pushState(null, "", to);
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
