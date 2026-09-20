import { Plugs } from "@phosphor-icons/react";

import AgentCard from "@/components/AgentCard";
import ApiDown from "@/components/ApiDown";
import Page from "@/components/Page";
import type { ShellData } from "@/components/Shell";
import { agentsSorted, agentSubline, exampleState, selectable, selectedAgent } from "@/lib/derive";
import { agent as agentRoute, linkProps, onboarding } from "@/lib/routes";
import type { RunSettings } from "@/lib/settings";

/**
 * `/app/agents` (docs/plans/08-rework-round-2.md §6): the fleet as a grid of pictures — each agent on its own
 * photo card in its own colour, the one that ran most recently first, a dashed Connect card last. The card's face
 * is a link to the agent's page, where every per-agent action (ping, start/stop, delete) lives; a quiet button
 * in its corner makes the agent the one the next run attacks. Nothing here starts a run.
 */
export default function Agents({ shell, settings, onSettingsChange }: { shell: ShellData; settings: RunSettings; onSettingsChange: (next: RunSettings) => void }) {
  const { agents, agentsError, runs, refresh } = shell;
  const selected = selectedAgent(agents, settings.target);
  const sorted = agents ? agentsSorted(agents, runs ?? []) : null;

  return (
    <Page title="Agents">
      {!sorted ? (
        <p className="text-[13px]">{agentsError ? <ApiDown onRetry={refresh} /> : <span className="text-[var(--faint)]">loading…</span>}</p>
      ) : (
        <div className="grid gap-6 sm:grid-cols-2 xl:grid-cols-3">
          {sorted.map((a) => {
            const on = a.id === selected?.id;
            const starting = a.id === "example" && exampleState(a) === "starting";
            return (
              <AgentCard key={a.id} agent={a} subline={agentSubline(a, starting)} name={a.name}>
                <a {...linkProps(agentRoute(a.id))} aria-label={`Open ${a.name}`} className="absolute inset-0 z-10 rounded-[26px] outline-offset-[-6px]" />
                {on ? (
                  <span className="pointer-events-none absolute bottom-4 left-5 z-30 text-[11px] uppercase tracking-[0.08em] text-white/70">selected</span>
                ) : (
                  selectable(a) && (
                    <button
                      type="button"
                      aria-label={`Attack ${a.name} next`}
                      onClick={() => onSettingsChange({ ...settings, target: a.id })}
                      className="absolute bottom-4 left-5 z-30 rounded text-[11px] uppercase tracking-[0.08em] text-white/70 opacity-0 transition-opacity hover:text-white focus-visible:opacity-100 group-hover:opacity-100"
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
