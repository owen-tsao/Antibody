import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { Activity, Bot, History, House, KeyRound, Menu, PanelLeft, Play, Settings, Unplug, X } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";

import { api, type Health, type LoopState, type ReplayInfo, type Status } from "@/api";
import ApiDown from "@/components/ApiDown";
import { useModal } from "@/hooks/useModal";
import { usePoll } from "@/hooks/usePoll";
import { AGENTS, HOME, href, LANDING, LIVE_RUN, linkProps, REPLAYS, RUNS, SETTINGS, type Route } from "@/lib/routes";
import { NO_KEY_LINE } from "@/lib/ui";
import { cn } from "@/lib/utils";

/**
 * The persistent frame around everything under /app (docs/plans/00-overview.md Block 3): a Linear-style
 * rail from md up — sections of nouns, one active row, a "Current run" item while something plays — and a
 * top bar with a menu button below md that opens the same rail as an overlay. The rail collapses to icons
 * (`[`, persisted). It owns the polls the pages share (`loop`, `replay`, `status`, `health`) and renders
 * its children as a function of that data, so no page polls those routes a second time.
 *
 * Content fades 120 ms on route change; no slides. Reduced motion turns every animation off.
 */

// Cheap file reads on a local API; "Current run" must notice a run starting within a beat of the click.
// Status drives the run page's orbs, whose spec cadence is 1 s while something is playing.
const POLL_MS = 2_000;
const LIVE_STATUS_MS = 1_000;
// Whether a key is set is static for the API's lifetime.
const HEALTH_MS = 60_000;
const FADE_S = 0.12;

const RAIL_W = 240;
const RAIL_COLLAPSED_W = 48;
const RAIL_KEY = "antibody.rail.v1";

export interface ShellData {
  loop: LoopState | null;
  replay: ReplayInfo | null;
  /** The raw /api/status row (undwelled); the run page smooths it itself. */
  status: Status | null;
  statusError: string | null;
  /** GET /api/health; null until it answers. `has_api_key === false` disables every start control. */
  health: Health | null;
  /** Poll all three run routes now (after an action whose effect the next tick would show late). */
  refresh: () => void;
}

interface Item {
  route: Route;
  label: string;
  icon: typeof House;
  active: (r: Route) => boolean;
}

const HOME_ITEM: Item = { route: HOME, label: "Home", icon: House, active: (r) => r.kind === "home" };
const CURRENT_RUN_ITEM: Item = { route: LIVE_RUN, label: "Current run", icon: Activity, active: (r) => r.kind === "run" && r.id === "live" };
const WORKSPACE: Item[] = [
  { route: AGENTS, label: "Agents", icon: Bot, active: (r) => r.kind === "agents" },
  // The live run is "Current run" above; Runs stays lit for it too, as the section it belongs to.
  { route: RUNS, label: "Runs", icon: Play, active: (r) => r.kind === "runs" || r.kind === "run" || r.kind === "cycle" },
  { route: REPLAYS, label: "Replays", icon: History, active: (r) => r.kind === "replays" },
  { route: SETTINGS, label: "Settings", icon: Settings, active: (r) => r.kind === "settings" },
];

function readCollapsed(): boolean {
  try {
    return window.localStorage.getItem(RAIL_KEY) === "collapsed";
  } catch {
    return false;
  }
}

function writeCollapsed(v: boolean): void {
  try {
    window.localStorage.setItem(RAIL_KEY, v ? "collapsed" : "expanded");
  } catch {
    // Storage unavailable: the choice lasts for this page load.
  }
}

/** `[` toggles the rail unless the person is typing somewhere. */
function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

export default function Shell({ route, children }: { route: Route; children: (data: ShellData) => ReactNode }) {
  const reduced = useReducedMotion();
  const { data: loop, error: loopError, refresh: refreshLoop } = usePoll(api.loop, POLL_MS);
  const { data: replay, error: replayError, refresh: refreshReplay } = usePoll(api.replay, POLL_MS);
  const live = !!loop?.running || !!replay?.active;
  const { data: status, error: statusError, refresh: refreshStatus } = usePoll(api.status, live ? LIVE_STATUS_MS : POLL_MS);
  const { data: health } = usePoll(api.health, HEALTH_MS);
  const refresh = useCallback(() => {
    refreshLoop();
    refreshReplay();
    refreshStatus();
  }, [refreshLoop, refreshReplay, refreshStatus]);

  // Down means neither poll has ever answered; a hiccup after first contact keeps the last value.
  const down = !loop && !replay && !!loopError && !!replayError;

  const [collapsed, setCollapsed] = useState(readCollapsed);
  const toggle = useCallback(() => setCollapsed((c) => !c), []);
  useEffect(() => writeCollapsed(collapsed), [collapsed]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "[" || e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target)) return;
      e.preventDefault();
      toggle();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggle]);

  // Below md the rail is an overlay. It is open *for one address*, so navigating anywhere closes it
  // without an effect; the backdrop closes it too, and `useModal` handles Esc, focus and scroll.
  const address = href(route);
  const [menuOpenAt, setMenuOpenAt] = useState<string | null>(null);
  const menuOpen = menuOpenAt === address;
  const setMenuOpen = useCallback((open: boolean) => setMenuOpenAt(open ? href(route) : null), [route]);
  const closeMenu = useCallback(() => setMenuOpen(false), [setMenuOpen]);
  const menuPanel = useRef<HTMLElement>(null);
  useModal(menuPanel, closeMenu, menuOpen);

  // One page-level key per screen: cycle 3 → cycle 4 is a new screen, the run's live/finished swap is not.
  const key = route.kind === "cycle" ? `cycle-${route.id}-${route.n}` : route.kind === "run" ? `run-${route.id}` : route.kind;

  const noKey = health !== null && !health.has_api_key;
  // A paused replay is still the current run, but the dot alone would read as "nothing happening".
  const currentRunLabel = replay?.active && replay.paused ? "Current run · paused" : "Current run";

  const rail = (compact: boolean) => {
    const row = (it: Item, dot?: "live" | "idle", label = it.label) => {
      const active = it.active(route);
      const Icon = it.icon;
      return (
        <a
          key={it.label}
          {...linkProps(it.route)}
          aria-current={active ? "page" : undefined}
          title={compact ? label : undefined}
          className={cn(
            "flex h-7 items-center gap-2.5 rounded-md text-[13px] transition-colors",
            compact ? "justify-center px-0" : "px-2",
            active ? "bg-[var(--hover)] font-medium text-[var(--fg)]" : "text-[var(--muted)] hover:bg-[var(--hover)] hover:text-[var(--fg)]",
          )}
        >
          <span className="relative inline-flex h-4 w-4 shrink-0 items-center justify-center">
            <Icon className="h-[15px] w-[15px]" strokeWidth={1.75} aria-hidden />
            {dot && (
              <span
                aria-hidden
                className={cn(
                  "absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full ring-2 ring-[var(--bg-rail)]",
                  dot === "live" ? "bg-[var(--live)] motion-safe:animate-pulse" : "bg-[var(--faint)]",
                )}
              />
            )}
          </span>
          {!compact && <span className="truncate">{label}</span>}
        </a>
      );
    };
    return (
      <>
        <div className={cn("flex h-7 items-center", compact ? "justify-center" : "justify-between px-2")}>
          <a {...linkProps(LANDING)} className="display rounded text-[20px] leading-none text-[var(--fg)]" aria-label="Antibody — home">
            {compact ? "A" : "Antibody"}
          </a>
        </div>
        <nav aria-label="Sections" className="mt-6 flex flex-col gap-0.5">
          {row(HOME_ITEM)}
          {live && row(CURRENT_RUN_ITEM, loop?.running ? "live" : "idle", currentRunLabel)}
          {!compact ? (
            <p className="mb-1 mt-5 px-2 text-[10.5px] font-medium uppercase tracking-[0.08em] text-[var(--faint)]">Workspace</p>
          ) : (
            <span aria-hidden className="mx-auto my-3 h-px w-4 bg-[var(--border-2)]" />
          )}
          {WORKSPACE.map((it) => row(it))}
        </nav>
        <div className={cn("mt-auto flex flex-col gap-2 text-[12px] leading-[1.5]", compact ? "items-center" : "px-2")}>
          {down ? (
            compact ? (
              <button type="button" onClick={refresh} title="api unreachable · retry" aria-label="API unreachable. Retry" className="rounded p-1 text-[var(--faint)] hover:text-[var(--muted)]">
                <Unplug className="h-[15px] w-[15px]" strokeWidth={1.75} aria-hidden />
              </button>
            ) : (
              <ApiDown onRetry={refresh} />
            )
          ) : noKey ? (
            compact ? (
              <span title={NO_KEY_LINE} className="p-1 text-[var(--faint)]">
                <KeyRound className="h-[15px] w-[15px]" strokeWidth={1.75} aria-hidden />
              </span>
            ) : (
              <p className="text-[var(--faint)]">{NO_KEY_LINE}</p>
            )
          ) : null}
        </div>
      </>
    );
  };

  return (
    <div className="min-h-full md:flex">
      {/* Top bar, below md. */}
      <header className="sticky top-0 z-20 flex items-center gap-4 border-b border-[var(--border-2)] bg-[var(--bg-rail)] px-4 py-2.5 md:hidden">
        <button
          type="button"
          onClick={() => setMenuOpen(true)}
          aria-label="Open menu"
          aria-expanded={menuOpen}
          className="rounded-md p-1 text-[var(--muted)] hover:bg-[var(--hover)] hover:text-[var(--fg)]"
        >
          <Menu className="h-[18px] w-[18px]" strokeWidth={1.75} aria-hidden />
        </button>
        <a {...linkProps(LANDING)} className="display rounded text-[20px] leading-none text-[var(--fg)]" aria-label="Antibody — home">
          Antibody
        </a>
        {live && (
          <a {...linkProps(LIVE_RUN)} className="ml-auto inline-flex items-center gap-2 rounded text-[12px] text-[var(--muted)]">
            <span aria-hidden className={cn("h-1.5 w-1.5 rounded-full", loop?.running ? "bg-[var(--live)] motion-safe:animate-pulse" : "bg-[var(--faint)]")} />
            {currentRunLabel}
          </a>
        )}
      </header>
      <AnimatePresence>
        {menuOpen && (
          <motion.div
            key="menu"
            className="fixed inset-0 z-30 md:hidden"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: reduced ? 0 : FADE_S }}
          >
            <div className="absolute inset-0 bg-[var(--scrim)]" onClick={closeMenu} aria-hidden />
            <aside
              ref={menuPanel}
              role="dialog"
              aria-modal="true"
              aria-label="Sections"
              tabIndex={-1}
              className="absolute inset-y-0 left-0 flex w-[240px] flex-col border-r border-[var(--border-2)] bg-[var(--bg-rail)] px-3 py-4 outline-none"
            >
              {rail(false)}
              <button
                type="button"
                onClick={closeMenu}
                aria-label="Close menu"
                className="absolute right-2 top-3 rounded-md p-1 text-[var(--muted)] hover:text-[var(--fg)]"
              >
                <X className="h-4 w-4" strokeWidth={1.75} aria-hidden />
              </button>
            </aside>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Left rail, md and up. */}
      <motion.aside
        className="hidden shrink-0 border-r border-[var(--border-2)] bg-[var(--bg-rail)] md:sticky md:top-0 md:flex md:h-screen md:flex-col md:py-4"
        initial={false}
        animate={{ width: collapsed ? RAIL_COLLAPSED_W : RAIL_W, paddingLeft: collapsed ? 6 : 12, paddingRight: collapsed ? 6 : 12 }}
        transition={{ duration: reduced ? 0 : 0.18, ease: [0.2, 0.65, 0.3, 0.9] }}
      >
        {rail(collapsed)}
        <button
          type="button"
          onClick={toggle}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          aria-pressed={collapsed}
          title={`${collapsed ? "Expand" : "Collapse"} · [`}
          className={cn(
            "mt-3 flex h-7 items-center gap-2.5 rounded-md text-[12px] text-[var(--faint)] transition-colors hover:bg-[var(--hover)] hover:text-[var(--muted)]",
            collapsed ? "justify-center" : "px-2",
          )}
        >
          <PanelLeft className="h-[15px] w-[15px] shrink-0" strokeWidth={1.75} aria-hidden />
          {!collapsed && <span>Collapse</span>}
          {!collapsed && <kbd className="code ml-auto text-[11px] text-[var(--faint)]">[</kbd>}
        </button>
      </motion.aside>

      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={key}
          className="min-w-0 flex-1"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: reduced ? 0 : FADE_S, ease: "linear" }}
        >
          {children({ loop, replay, status, statusError, health, refresh })}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
