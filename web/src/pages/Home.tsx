import { useEffect } from "react";

import { api } from "@/api";
import AgentCard, { CARD_FRAME } from "@/components/AgentCard";
import AgentSwitcher from "@/components/AgentSwitcher";
import ApiDown from "@/components/ApiDown";
import Page from "@/components/Page";
import Panel, { PanelEmpty, PanelRow } from "@/components/Panel";
import type { ShellData } from "@/components/Shell";
import { usePoll } from "@/hooks/usePoll";
import { fmtDate, homeStats, needsAttention, readSource, runLine, runsForAgent, selectedAgent, versionSpan } from "@/lib/derive";
import { agent as agentRoute, linkProps } from "@/lib/routes";
import type { RunSettings } from "@/lib/settings";
import { eyebrow, pill, surface } from "@/lib/ui";
import { cn } from "@/lib/utils";

/**
 * `/app/home` (docs/plans/08-rework-round-2.md §5): one agent, right now. The agent's picture — its name is
 * the switcher — with the last run's numbers under it, and beside it what still needs a look and what ran
 * recently. Nothing here starts a run: that is Current run. Agents is the fleet; Agent detail is history.
 */

// The last run's files change only when a run ends; the shell's polls carry everything live.
const READ_MS = 10_000;

export default function Home({ shell, settings, onSettingsChange }: { shell: ShellData; settings: RunSettings; onSettingsChange: (next: RunSettings) => void }) {
  const { agents, agentsError, runs, runsError, loop, refresh } = shell;
  const agent = selectedAgent(agents, settings.target);
  const agentRuns = agent && runs ? runsForAgent(runs, agent.id) : null;
  const lastRun = agentRuns?.[0] ?? null;
  const source = lastRun ? readSource(lastRun.id) : null;

  // The last run's cycles and state, tagged with the source they came from so a just-finished run never shows
  // the previous run's numbers while its own load. usePoll keeps the last answer; the tag says whose it is.
  // Not memoised: usePoll reads the latest `fn` through a ref and this one polls, so identity is irrelevant.
  const readFn = () => {
    if (!source) return Promise.resolve(null);
    const s = source;
    return Promise.all([api.cycles(s).catch(() => null), api.state(s).catch(() => null)]).then(([cycles, state]) => ({ source: s, cycles, state }));
  };
  const { data: read, refresh: reread } = usePoll(readFn, READ_MS);
  // usePoll picks up the new `fn` on its next tick; switching agents should not wait 10 s for the numbers.
  useEffect(() => {
    reread();
  }, [source, reread]);
  const current = read && read.source === source ? read : null;

  const down = (agents === null && agentsError !== null) || (runs === null && runsError !== null);
  const stats = homeStats(lastRun, lastRun ? (current ? current.cycles : undefined) : null, lastRun ? (current ? current.state : undefined) : null);
  const attention = current?.cycles ? needsAttention(current.cycles) : null;

  return (
    // At xl the page is exactly one viewport tall, so the row below has a height to fill: the card's is fixed by the
    // viewport (not by the side column's content — eleven attention rows once stretched the card to twice the screen
    // and pushed the title off centre), and the panels scroll inside. Below xl the side column drops under the hero
    // and the page scrolls: with the 240 px rail open, two columns at 1024 left the hero 300 px wide.
    <Page title="Home" className="flex max-w-none flex-col xl:h-[calc(100dvh-3.5rem)] xl:flex-none">
      {down ? (
        <p className="text-[13px]">
          <ApiDown onRetry={refresh} />
        </p>
      ) : (
        <div className="grid min-h-0 flex-1 gap-5 xl:grid-cols-[minmax(0,1fr)_400px] xl:grid-rows-[minmax(0,1fr)]">
          <div className="flex min-h-0 flex-col gap-5">
            {agent ? (
              <AgentCard agent={agent} ratio="free" className="min-h-[320px] flex-1 xl:min-h-0" name={<AgentSwitcher agents={agents} selected={agent} onSelect={(id) => onSettingsChange({ ...settings, target: id })} size="hero" />} />
            ) : (
              <div className={cn(CARD_FRAME, "min-h-[320px] flex-1 xl:min-h-0")} aria-hidden />
            )}
            <dl className={cn(surface, "grid shrink-0 px-6 py-5", stats.length === 1 ? "grid-cols-1" : "grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-4")}>
              {stats.map((s) => (
                <div key={s.label} className="min-w-0 text-center">
                  <dt className={eyebrow}>{s.label}</dt>
                  <dd className="tabular mt-1.5 truncate text-[15px] text-[var(--fg)]">{s.value}</dd>
                </div>
              ))}
            </dl>
          </div>

          <div className="flex min-h-0 flex-col gap-5">
            <Panel title="Needs attention" aside={attention && attention.length > 0 ? `${attention.length}` : undefined} className="min-h-[200px] flex-1" bodyClassName="min-h-0 overflow-y-auto">
              {!lastRun ? (
                <PanelEmpty>Nothing yet — run Heal on Current run to find out.</PanelEmpty>
              ) : attention === null ? (
                <PanelEmpty>{current && current.cycles === null ? "Could not read the last run." : "…"}</PanelEmpty>
              ) : attention.length === 0 ? (
                <PanelEmpty>Nothing outstanding — every attack that got through was fixed.</PanelEmpty>
              ) : (
                <div className="divide-y divide-[var(--border)]">
                  {attention.map((row) => {
                    const route = { kind: "cycle" as const, id: lastRun.id, n: row.cycle };
                    return <PanelRow key={row.cycle} {...linkProps(route)} title={row.title} line={`#${row.cycle} · ${row.why === "rejected" ? "fix rejected" : "no fix tried"}`} />;
                  })}
                </div>
              )}
            </Panel>

            <Panel
              title="Recent runs"
              aside={
                agent && agentRuns && agentRuns.length > 3 ? (
                  <a {...linkProps(agentRoute(agent.id))} className="rounded transition-colors hover:text-[var(--fg)]">
                    all runs →
                  </a>
                ) : undefined
              }
              className="min-h-[200px] flex-1"
              bodyClassName="min-h-0 overflow-y-auto"
            >
              {agentRuns === null ? (
                <PanelEmpty>…</PanelEmpty>
              ) : agentRuns.length === 0 ? (
                <PanelEmpty>No runs yet for this agent.</PanelEmpty>
              ) : (
                <div className="divide-y divide-[var(--border)]">
                  {agentRuns.slice(0, 3).map((r) => {
                    const route = { kind: "run" as const, id: r.id };
                    return <PanelRow key={r.id} {...linkProps(route)} title={r.started_at ? fmtDate(r.started_at) : r.id} line={runLine(r, !!loop?.running)} trailing={<span className={pill}>{versionSpan(r)}</span>} />;
                  })}
                </div>
              )}
            </Panel>
          </div>
        </div>
      )}
    </Page>
  );
}
