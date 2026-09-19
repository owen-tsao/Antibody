import { AnimatePresence } from "framer-motion";
import { useEffect, useState } from "react";

import { api, type CycleRecord, type Health, type LoopState, type State } from "@/api";
import ApiDown from "@/components/ApiDown";
import StartDialog from "@/components/StartDialog";
import { MetalFrame } from "@/components/ui/liquid-metal-border";
import { usePoll } from "@/hooks/usePoll";
import { agentCardStats, fmtDate, isFirstRun, lastRunFor, LEGIT_SIZE, needsAttention, runAgentLabel, runSource, runStatusLabel, versionSpan } from "@/lib/derive";
import { cycleChartSvg } from "@/lib/previewSvg";
import { linkProps, onboarding, onboardingSkipped, replace, RUNS } from "@/lib/routes";
import type { RunSettings } from "@/lib/settings";
import { NO_KEY_LINE, primaryButton, textButton } from "@/lib/ui";
import { cn } from "@/lib/utils";

/**
 * `/app/home` (docs/plans/00-overview.md Block 4.1): data with one primary action, never a hero. Heal
 * top-right opens the start dialog; below it one card per agent (its last run's version, how many known
 * attacks that version blocks, when, and the run's gate chart), then what needs a look in the current run
 * and the five most recent runs.
 *
 * It also owns the first-run rule (Block 3.4): nothing connected, no history beyond the demo tape, nothing
 * running → the wizard, via `replaceState` so Back does not bounce through here. Renders nothing until the
 * rule can be decided, so the page never flashes before redirecting — except when a load has failed
 * outright, which says so.
 *
 * Per-run reads (`/api/state`, `/api/cycles` with `?source=`) are one `useEffect` fetch over the distinct
 * last-run ids, re-run whenever the runs list changes — at most one pair of requests per agent, no polls.
 */

const POLL_MS = 15_000;
const RECENT = 5;

const section = "text-[10.5px] font-medium uppercase tracking-[0.08em] text-[var(--faint)]";
const row = "group flex items-baseline justify-between gap-4 py-2.5 text-[13px] text-[var(--muted)] transition-colors hover:text-[var(--fg)]";

interface Read {
  state: State | null;
  cycles: CycleRecord[] | null;
}

export default function Home({
  loop,
  health,
  refresh,
  settings,
  onSettingsChange,
}: {
  loop: LoopState | null;
  health: Health | null;
  refresh: () => void;
  settings: RunSettings;
  onSettingsChange: (next: RunSettings) => void;
}) {
  const { data: agents, error: agentsError, refresh: refreshAgents } = usePoll(api.agents, POLL_MS);
  const { data: runs, error: runsError, refresh: refreshRuns } = usePoll(api.runs, POLL_MS);
  const firstRun = isFirstRun(agents, runs, loop);
  const redirect = firstRun === true && !onboardingSkipped();
  // A poll that has never answered and has failed: the rule cannot be decided, and waiting quietly would
  // be a blank page for as long as the API is down. (A hiccup after first contact keeps the last value.)
  const down = (agents === null && agentsError !== null) || (runs === null && runsError !== null);

  useEffect(() => {
    if (redirect) replace(onboarding(1));
  }, [redirect]);

  const [reads, setReads] = useState<Record<string, Read>>({});
  useEffect(() => {
    if (!runs || !agents) return;
    const ids = new Set<string>();
    for (const a of agents) {
      const last = lastRunFor(a.id, runs);
      if (last) ids.add(last.id);
    }
    // Needs attention reads the current run whoever it belongs to (an orphaned target has no card).
    if (runs.some((r) => r.id === "live")) ids.add("live");
    let alive = true;
    Promise.all(
      [...ids].map(async (id) => {
        const src = runSource(id);
        const [state, cycles] = await Promise.all([api.state(src).catch(() => null), api.cycles(src).catch(() => null)]);
        return [id, { state, cycles }] as const;
      }),
    ).then((entries) => alive && setReads(Object.fromEntries(entries)));
    return () => {
      alive = false;
    };
  }, [runs, agents]);

  const [dialog, setDialog] = useState(false);

  if (down) {
    return (
      <Page>
        <h1 className="display text-[48px] leading-[1]">Home</h1>
        <p className="mt-4 text-[13px]">
          <ApiDown
            onRetry={() => {
              refreshAgents();
              refreshRuns();
            }}
          />
        </p>
      </Page>
    );
  }
  if (firstRun === null || redirect || !agents || !runs) return null;

  const noKey = health !== null && !health.has_api_key;
  // An idle API answers `live` reads with the golden tape; findings from a tape are not findings.
  const live = reads.live;
  const attention = live?.state?.source === "live" && live.cycles ? needsAttention(live.cycles) : [];
  const recent = runs.slice(0, RECENT);

  return (
    <Page>
      <header className="flex items-end justify-between gap-6">
        <h1 className="display text-[48px] leading-[1]">Home</h1>
        {/* The brand's one accent inside the tool: a chrome rim on the page's single filled button. */}
        <MetalFrame radius={8} thickness={1.5} className="h-9 shrink-0">
          <button
            type="button"
            onClick={() => setDialog(true)}
            aria-haspopup="dialog"
            aria-expanded={dialog}
            title={noKey ? NO_KEY_LINE : undefined}
            className={cn(primaryButton, "h-[33px] rounded-[6.5px]")}
          >
            Heal
          </button>
        </MetalFrame>
      </header>

      {runs.length === 0 ? (
        <div className="flex min-h-[40vh] items-center justify-center">
          <button type="button" onClick={() => setDialog(true)} className={cn(textButton, "text-[14px]")}>
            <span className="u-line">Start your first heal</span>
          </button>
        </div>
      ) : (
        <>
          <div className="mt-10 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {agents.map((a) => {
              const last = lastRunFor(a.id, runs);
              const read = last ? reads[last.id] : undefined;
              const stats = agentCardStats(last, read?.state ?? null);
              const cycles = read?.cycles ?? null;
              const lastCycle = cycles?.at(-1);
              const body = (
                <>
                  <span className="flex items-baseline justify-between gap-3">
                    <span className="truncate text-[13px] font-medium text-[var(--fg)]">{a.name}</span>
                    {stats.version && <span className="tabular text-[13px] text-[var(--muted)]">{stats.version}</span>}
                  </span>
                  <span className="mt-1 block text-[12px] text-[var(--muted)]">{stats.line}</span>
                  {stats.lastRunAt && <span className="tabular mt-0.5 block text-[12px] text-[var(--faint)]">last run {fmtDate(stats.lastRunAt)}</span>}
                  {lastCycle && cycles && (
                    <span
                      aria-hidden
                      className="mt-3 block overflow-hidden [&_svg]:h-auto [&_svg]:w-full"
                      dangerouslySetInnerHTML={{ __html: cycleChartSvg(lastCycle, cycles, LEGIT_SIZE) }}
                    />
                  )}
                </>
              );
              const card = "block rounded-xl border border-[var(--border)] bg-[var(--card)] p-4 transition-colors";
              return last ? (
                <a key={a.id} {...linkProps({ kind: "run", id: last.id })} className={cn(card, "hover:border-[var(--border-2)]")}>
                  {body}
                </a>
              ) : (
                <div key={a.id} className={card}>
                  {body}
                </div>
              );
            })}
          </div>

          <div className={cn("mt-12 grid gap-10", attention.length > 0 && "md:grid-cols-2")}>
            {attention.length > 0 && (
              <section>
                <h2 className={section}>Needs attention</h2>
                <ul className="mt-2 divide-y divide-[var(--border)] border-y border-[var(--border)]">
                  {attention.map((r) => (
                    <li key={r.cycle}>
                      <a {...linkProps({ kind: "cycle", id: "live", n: r.cycle })} className={row}>
                        <span className="truncate">
                          <span className="tabular text-[var(--faint)]">cycle {r.cycle}</span>
                          <span className="px-1.5 text-[var(--faint)]">·</span>
                          <span className="u-line">{r.title}</span>
                        </span>
                        <span className={cn("shrink-0 text-[12px]", r.why === "rejected" ? "text-[var(--danger)]" : "text-[var(--faint)]")}>
                          {r.why === "rejected" ? "patch rejected" : "landed · no patch"}
                        </span>
                      </a>
                    </li>
                  ))}
                </ul>
              </section>
            )}
            <section>
              <div className="flex items-baseline justify-between">
                <h2 className={section}>Recent runs</h2>
                {runs.length > RECENT && (
                  <a {...linkProps(RUNS)} className={cn(textButton, "text-[12px]")}>
                    <span className="u-line">all runs →</span>
                  </a>
                )}
              </div>
              <ul className="mt-2 divide-y divide-[var(--border)] border-y border-[var(--border)]">
                {recent.map((r) => (
                  <li key={r.id}>
                    <a {...linkProps({ kind: "run", id: r.id })} className={row}>
                      <span className="truncate">
                        <span className="tabular u-line">{r.started_at ? fmtDate(r.started_at) : r.id}</span>
                        <span className="px-1.5 text-[var(--faint)]">·</span>
                        {runAgentLabel(r)}
                      </span>
                      <span className="tabular flex shrink-0 gap-3 text-[12px] text-[var(--faint)]">
                        <span>{versionSpan(r)}</span>
                        <span>{runStatusLabel(r, loop?.running ?? false)}</span>
                      </span>
                    </a>
                  </li>
                ))}
              </ul>
            </section>
          </div>
        </>
      )}

      <AnimatePresence>
        {dialog && <StartDialog settings={settings} onChange={onSettingsChange} onClose={() => setDialog(false)} health={health} loop={loop} refresh={refresh} />}
      </AnimatePresence>
    </Page>
  );
}

function Page({ children }: { children: React.ReactNode }) {
  return (
    <main className="px-6 pb-16 pt-8 md:px-10 md:pt-7">
      <div className="mx-auto w-full max-w-[1040px]">{children}</div>
    </main>
  );
}
