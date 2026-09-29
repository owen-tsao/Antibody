import { Clock, Gear, House, Key, List, ListChecks, Plugs, Pulse, SidebarSimple, SquaresFour, VideoCamera, X } from "@phosphor-icons/react";
import { AnimatePresence, motion } from "framer-motion";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";

import { api, type Agent, type Health, type LoopState, type ReplayInfo, type RunRow, type Status } from "@/api";
import AgentSwitcher from "@/components/AgentSwitcher";
import ApiDown from "@/components/ApiDown";
import Panel from "@/components/Panel";
import TokenField from "@/components/TokenField";
import { useModal } from "@/hooks/useModal";
import { usePoll } from "@/hooks/usePoll";
import { useMotionPref } from "@/hooks/useMotionPref";
import { replayRunId, selectedAgent } from "@/lib/derive";
import { AGENTS, HOME, href, LANDING, linkProps, LIVE_RUN, REVIEW, RUNS, SCHEDULES, SETTINGS, type Route } from "@/lib/routes";
import type { RunSettings } from "@/lib/settings";
import { eyebrow, NO_KEY_LINE } from "@/lib/ui";
import { cn } from "@/lib/utils";

/**
 * The persistent frame around everything under /app (docs/plans/07-app-rework.md §2): a 240 px rail —
 * wordmark, the selected agent as a switcher, Home and the nouns (Agents, Current run, Runs, Schedules, Review)
 * in one group, Settings and the key line at the bottom — and a
 * top bar with a menu button below md that opens the same rail as an overlay. The rail collapses to icons
 * from its own toggle (persisted; no keyboard shortcut — nothing in the app has one). It owns the polls the
 * pages share (`loop`, `replay`, `status`, `health`, `agents`, `runs`) and renders its children as a
 * function of that data, so no page polls those routes a second time.
 *
 * Content fades 120 ms on route change; no slides. Reduced motion turns every animation off.
 */

// Cheap file reads on a local API; "Current run" must notice a run starting within a beat of the click.
// Status drives the run page's orbs, whose spec cadence is 1 s while something is playing.
const POLL_MS = 2_000;
const LIVE_STATUS_MS = 1_000;
// Agents and runs change when someone acts, not by themselves; pages `refresh()` after an action.
const LIST_MS = 10_000;
// Whether a key is set is static for the API's lifetime.
const HEALTH_MS = 60_000;
const FADE_S = 0.12;

const RAIL_W = 240;
const RAIL_COLLAPSED_W = 52;
const RAIL_KEY = "antibody.rail.v1";

export interface ShellData {
  loop: LoopState | null;
  replay: ReplayInfo | null;
  /** The raw /api/status row (undwelled); the run page smooths it itself. */
  status: Status | null;
  statusError: string | null;
  /** GET /api/health; null until it answers. `has_api_key === false` disables every start control. */
  health: Health | null;
  /** GET /api/agents and GET /api/runs, shared by the rail and the pages; null until each answers. */
  agents: Agent[] | null;
  agentsError: string | null;
  runs: RunRow[] | null;
  runsError: string | null;
  /** The rail's "api unreachable": both 2 s polls have missed two ticks (or never answered) and it is not a 401. A page
   * holding its own one-shot reads re-reads when this turns false again — its next tick would be a long way off. */
  down: boolean;
  /** Poll every shared route now (after an action whose effect the next tick would show late). */
  refresh: () => void;
}

interface Item {
  route: Route;
  label: string;
  icon: typeof SquaresFour;
  active: (r: Route) => boolean;
}

const NAV: Item[] = [
  { route: HOME, label: "Home", icon: House, active: (r) => r.kind === "home" },
  { route: AGENTS, label: "Agents", icon: SquaresFour, active: (r) => r.kind === "agents" || r.kind === "agent" },
  // Always present: idle it holds the Heal orb, live it is the run. A playing tape is also "current".
  { route: LIVE_RUN, label: "Current run", icon: Pulse, active: (r) => (r.kind === "run" || r.kind === "cycle") && r.id === "live" },
  { route: RUNS, label: "Runs", icon: VideoCamera, active: (r) => r.kind === "runs" || ((r.kind === "run" || r.kind === "cycle") && r.id !== "live") },
  { route: SCHEDULES, label: "Schedules", icon: Clock, active: (r) => r.kind === "schedules" },
  { route: REVIEW, label: "Review", icon: ListChecks, active: (r) => r.kind === "review" },
];
const SETTINGS_ITEM: Item = { route: SETTINGS, label: "Settings", icon: Gear, active: (r) => r.kind === "settings" };

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

export default function Shell({
  route,
  settings,
  onSettingsChange,
  children,
}: {
  route: Route;
  settings: RunSettings;
  onSettingsChange: (next: RunSettings) => void;
  children: (data: ShellData) => ReactNode;
}) {
  const reduced = useMotionPref();
  const { data: loop, error: loopError, status: loopStatus, failing: loopFailing, refresh: refreshLoop } = usePoll(api.loop, POLL_MS);
  const { data: replay, error: replayError, status: replayStatus, failing: replayFailing, refresh: refreshReplay } = usePoll(api.replay, POLL_MS);
  const live = !!loop?.running || !!replay?.active;
  const { data: status, error: statusError, refresh: refreshStatus } = usePoll(api.status, live ? LIVE_STATUS_MS : POLL_MS);
  const { data: health, refresh: refreshHealth } = usePoll(api.health, HEALTH_MS);
  const { data: agents, error: agentsError, refresh: refreshAgents } = usePoll(api.agents, LIST_MS);
  const { data: runs, error: runsError, refresh: refreshRuns } = usePoll(api.runs, LIST_MS);
  const refresh = useCallback(() => {
    refreshHealth();
    refreshLoop();
    refreshReplay();
    refreshStatus();
    refreshAgents();
    refreshRuns();
  }, [refreshHealth, refreshLoop, refreshReplay, refreshStatus, refreshAgents, refreshRuns]);

  // Down means the API never answered, or both polls have now missed two ticks in a row (~4 s): one miss
  // is a hiccup and keeps the last value silently; a page already open keeps its last-good data either way.
  // Locked comes first: an API that answers 401 is there, it wants the token (api/auth.py).
  const locked = loopStatus === 401 || replayStatus === 401;
  const neverAnswered = !loop && !replay && !!loopError && !!replayError;
  const down = !locked && (neverAnswered || (loopFailing >= 2 && replayFailing >= 2));

  const [collapsed, setCollapsed] = useState(readCollapsed);
  const toggle = useCallback(() => setCollapsed((c) => !c), []);
  useEffect(() => writeCollapsed(collapsed), [collapsed]);

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
  const key =
    route.kind === "cycle" ? `cycle-${route.id}-${route.n}` : route.kind === "run" ? `run-${route.id}` : route.kind === "agent" ? `agent-${route.id}` : route.kind;

  const noKey = health !== null && !health.has_api_key;
  const selected = selectedAgent(agents, settings.target);
  // A word, not a dot: the label itself says what state the run is in.
  const currentRunSuffix = loop?.running ? "running" : replay?.active ? (replay.paused ? "paused" : "watching") : null;
  // A playing tape is the current run; its address is the tape's own (`/app/runs/golden`), not `live`.
  const tapeId = replayRunId(replay);
  const currentRun: Item = tapeId
    ? { ...NAV[2], route: { kind: "run", id: tapeId }, active: (r) => (r.kind === "run" || r.kind === "cycle") && (r.id === tapeId || r.id === "live") }
    : NAV[2];
  // The tape's address is lit by the Current run row above, so Runs must not light for it too.
  const runsItem: Item = tapeId ? { ...NAV[3], active: (r) => NAV[3].active(r) && !((r.kind === "run" || r.kind === "cycle") && r.id === tapeId) } : NAV[3];

  const rail = (compact: boolean) => {
    const row = (it: Item, suffix?: string | null) => {
      const active = it.active(route);
      const Icon = it.icon;
      return (
        <a
          key={it.label}
          {...linkProps(it.route)}
          aria-current={active ? "page" : undefined}
          title={compact ? it.label : undefined}
          className={cn(
            "flex h-8 items-center gap-2.5 rounded-md text-[13px] transition-colors",
            compact ? "justify-center px-0" : "px-2.5",
            active ? "bg-[var(--hover)] font-medium text-[var(--fg)]" : "text-[var(--muted)] hover:bg-[var(--hover)] hover:text-[var(--fg)]",
          )}
        >
          <Icon size={16} weight={active ? "fill" : "regular"} className="shrink-0" aria-hidden />
          {!compact && (
            <span className="flex min-w-0 flex-1 items-baseline gap-2">
              <span className="truncate">{it.label}</span>
              {suffix && <span className="ml-auto text-[11px] font-normal text-[var(--faint)]">{suffix}</span>}
            </span>
          )}
        </a>
      );
    };
    return (
      <>
        <div className={cn("flex h-8 items-center", compact ? "justify-center" : "justify-between px-2.5")}>
          <a {...linkProps(LANDING)} className="display rounded text-[20px] leading-none text-[var(--fg)]" aria-label="Antibody — home">
            {compact ? "A" : "Antibody"}
          </a>
          {!compact && (
            <button
              type="button"
              onClick={toggle}
              aria-label="Collapse sidebar"
              className="hidden rounded-md p-1 text-[var(--faint)] transition-colors hover:bg-[var(--hover)] hover:text-[var(--fg)] md:inline-flex"
            >
              <SidebarSimple size={16} aria-hidden />
            </button>
          )}
        </div>

        <AgentSwitcher
          agents={agents}
          selected={selected}
          onSelect={(id) => onSettingsChange({ ...settings, target: id })}
          iconOnly={compact}
          className="mt-5"
        />

        <nav aria-label="Sections" className="mt-5 flex flex-col gap-0.5">
          {!compact && <p className={cn(eyebrow, "mb-1 px-2.5")}>Workspace</p>}
          {row(NAV[0])}
          {row(NAV[1])}
          {row(currentRun, currentRunSuffix)}
          {row(runsItem)}
          {row(NAV[4])}
          {row(NAV[5])}
        </nav>

        <div className={cn("mt-auto flex flex-col gap-0.5 border-t border-[var(--border)] pt-3", compact && "items-center")}>
          {row(SETTINGS_ITEM)}
          {down ? (
            compact ? (
              <button type="button" onClick={refresh} title="api unreachable · retry" aria-label="API unreachable. Retry" className="rounded p-1 text-[var(--faint)] hover:text-[var(--muted)]">
                <Plugs size={16} aria-hidden />
              </button>
            ) : (
              <p className="px-2.5 pt-1 text-[12px] leading-[1.5]">
                <ApiDown onRetry={refresh} />
              </p>
            )
          ) : noKey ? (
            compact ? (
              <span title={NO_KEY_LINE} className="p-1 text-[var(--faint)]">
                <Key size={16} aria-hidden />
              </span>
            ) : (
              <p className="px-2.5 pt-1 text-[12px] leading-[1.5] text-[var(--faint)]">{NO_KEY_LINE}</p>
            )
          ) : null}
          {compact && (
            <button
              type="button"
              onClick={toggle}
              aria-label="Expand sidebar"
              className="mt-2 hidden rounded-md p-1 text-[var(--faint)] transition-colors hover:bg-[var(--hover)] hover:text-[var(--fg)] md:inline-flex"
            >
              <SidebarSimple size={16} aria-hidden />
            </button>
          )}
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
          <List size={18} aria-hidden />
        </button>
        <a {...linkProps(LANDING)} className="display rounded text-[20px] leading-none text-[var(--fg)]" aria-label="Antibody — home">
          Antibody
        </a>
        {currentRunSuffix && (
          <a {...linkProps(currentRun.route)} className="ml-auto rounded text-[12px] text-[var(--muted)]">
            Current run · {currentRunSuffix}
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
                <X size={16} aria-hidden />
              </button>
            </aside>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Left rail, md and up. Sticky makes it a stacking context, so it takes a z-index of its own or the
          switcher's sideways panel would paint under the page's layered surfaces. */}
      <motion.aside
        className="hidden shrink-0 border-r border-[var(--border-2)] bg-[var(--bg-rail)] md:sticky md:top-0 md:z-40 md:flex md:h-screen md:flex-col md:py-4"
        initial={false}
        animate={{ width: collapsed ? RAIL_COLLAPSED_W : RAIL_W, paddingLeft: collapsed ? 8 : 12, paddingRight: collapsed ? 8 : 12 }}
        transition={{ duration: reduced ? 0 : 0.18, ease: [0.2, 0.65, 0.3, 0.9] }}
      >
        {rail(collapsed)}
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
          {locked ? (
            <div className="mx-auto flex min-h-[60vh] max-w-[420px] flex-col justify-center px-6 py-12">
              <Panel title="This API wants a token">
                <div className="flex flex-col gap-4 px-4 py-4">
                  <p className="text-[13px] leading-[1.55] text-[var(--muted)]">
                    The server was started with <code className="code text-[var(--fg)]">ANTIBODY_API_TOKEN</code> set. Paste the same value here; it stays in this browser only.
                  </p>
                  <TokenField onChange={refresh} />
                </div>
              </Panel>
            </div>
          ) : (
            children({ loop, replay, status, statusError, health, agents, agentsError, runs, runsError, down, refresh })
          )}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
