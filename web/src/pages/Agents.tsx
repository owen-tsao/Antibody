import { Plugs } from "@phosphor-icons/react";
import { useEffect } from "react";

import { api, type Approvals, type State } from "@/api";
import AgentCard from "@/components/AgentCard";
import ApiDown from "@/components/ApiDown";
import Page from "@/components/Page";
import type { ShellData } from "@/components/Shell";
import { usePoll } from "@/hooks/usePoll";
import { agentsSorted, exampleName, exampleState, readSource, runsForAgent, runVerdict, selectable, selectedAgent } from "@/lib/derive";
import { agent as agentRoute, linkProps, onboarding } from "@/lib/routes";
import type { RunSettings } from "@/lib/settings";
import { eyebrow } from "@/lib/ui";
import { cn } from "@/lib/utils";

/**
 * `/app/agents` (docs/plans/08-rework-round-2.md §6; plan 12 §1): the fleet as a grid of pictures — each agent on
 * its own photo card in its own colour, the one that ran most recently first, a dashed Connect card last — with the
 * verdict on each agent's newest run as the card's line. The card's face is a link to the agent's page, where every
 * per-agent action (ping, start/stop, delete) lives; a quiet button in its corner makes the agent the one the next
 * run attacks. Nothing here starts a run.
 */

// The grid reads two small files per agent (the newest run's measurement and decisions) — never the cycles, and
// never for more than this many agents; the rest get the verdict the run list alone supports. The files change
// only when a run ends or someone decides on Review, so a slow beat is plenty.
const READ_CAP = 6;
const READ_MS = 30_000;

type Read = { state: State | null; approvals: Approvals | null };

/** The verdict's inputs for each newest run, keyed by run id; a read that fails leaves its half null rather than failing the batch. */
async function readVerdictInputs(ids: string[]): Promise<Record<string, Read>> {
  const reads = await Promise.all(ids.map((id) => Promise.all([api.state(readSource(id)).catch(() => null), api.approvals(readSource(id)).catch(() => null)])));
  return Object.fromEntries(reads.map(([state, approvals], i) => [ids[i]!, { state, approvals }]));
}

export default function Agents({ shell, settings, onSettingsChange }: { shell: ShellData; settings: RunSettings; onSettingsChange: (next: RunSettings) => void }) {
  const { agents, agentsError, runs, refresh } = shell;
  const selected = selectedAgent(agents, settings.target);
  const sorted = agents ? agentsSorted(agents, runs ?? []) : null;

  // Newest run per agent, then the reads for the first READ_CAP of them, keyed by run id so a finished run rereads.
  // Same shape as Home's read: usePoll reads the latest `fn` through a ref, and the effect asks again when the set
  // of runs changes rather than waiting for the next tick.
  const newest = sorted && runs ? sorted.map((a) => runsForAgent(runs, a.id)[0] ?? null) : null;
  const ids = (newest ?? []).filter((r) => r !== null).slice(0, READ_CAP).map((r) => r.id);
  const key = ids.join(",");
  const { data: reads, refresh: reread } = usePoll(() => readVerdictInputs(ids), READ_MS);
  useEffect(() => {
    reread();
  }, [key, reread]);

  return (
    <Page title="Agents">
      {!sorted ? (
        <p className="text-[13px]">{agentsError ? <ApiDown onRetry={refresh} /> : <span className="text-[var(--faint)]">loading…</span>}</p>
      ) : (
        <div className="grid gap-6 sm:grid-cols-2 xl:grid-cols-3">
          {sorted.map((a, i) => {
            const on = a.id === selected?.id;
            const example = exampleName(a.id) !== null;
            const state = example ? exampleState(a) : null;
            const run = newest?.[i] ?? null;
            const read = run ? reads?.[run.id] : undefined;
            // A run whose reads are in flight shows a dash for a moment; a run past the cap, or whose reads failed,
            // gets the verdict the row alone supports — never a dash for good.
            const pending = run !== null && ids.includes(run.id) && reads === null;
            const headline = runs === null || pending ? "…" : runVerdict(run, null, read?.state?.vulnerability, read?.approvals, state).headline;
            return (
              <AgentCard key={a.id} agent={a} subline={state ? `${state === "starting" ? "starting…" : state} · ${headline}` : headline}>
                <a {...linkProps(agentRoute(a.id))} aria-label={`Open ${a.name}`} className="absolute inset-0 z-10 rounded-[26px] outline-offset-[-6px]" />
                {on ? (
                  <span className={cn(eyebrow, "pointer-events-none absolute bottom-4 left-5 z-30 text-white/70")}>selected</span>
                ) : (
                  selectable(a) && (
                    <button
                      type="button"
                      aria-label={`Attack ${a.name} next`}
                      onClick={() => onSettingsChange({ ...settings, target: a.id })}
                      className={cn(eyebrow, "absolute bottom-4 left-5 z-30 rounded text-white/70 opacity-0 transition-opacity hover:text-white focus-visible:opacity-100 group-hover:opacity-100")}
                    >
                      attack next
                    </button>
                  )
                )}
              </AgentCard>
            );
          })}

          <a
            {...linkProps(onboarding(1))}
            className="flex aspect-video flex-col items-start justify-between rounded-[30px] border-4 border-dashed border-[var(--border-2)] p-6 text-left transition-colors hover:border-[var(--muted)] hover:bg-[var(--card)]"
          >
            <span className="grid h-10 w-10 place-items-center rounded-[11px] border border-dashed border-[var(--border-2)] text-[var(--muted)]">
              <Plugs size={18} aria-hidden />
            </span>
            <span>
              <span className="block text-[14px] font-medium text-[var(--fg)]">Connect an agent</span>
              <span className="mt-1 block text-[12px] leading-[1.5] text-[var(--muted)]">
                {sorted.some((a) => !a.synthetic) ? "Any support agent that answers POST /episode over HTTP." : "None of your own yet. Any support agent that answers POST /episode over HTTP."}
              </span>
            </span>
          </a>
        </div>
      )}
    </Page>
  );
}
