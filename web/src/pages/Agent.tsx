import { useCallback, useEffect, useState } from "react";

import { api, ApiError, type PingResult } from "@/api";
import AgentTile from "@/components/AgentTile";
import ApiDown from "@/components/ApiDown";
import Page from "@/components/Page";
import { PanelEmpty } from "@/components/Panel";
import RunResults from "@/components/RunResults";
import { Select } from "@/components/RunSettingsFields";
import type { ShellData } from "@/components/Shell";
import { usePoll } from "@/hooks/usePoll";
import { agentSubline, exampleState, pingLabel, pingResultLine, readSource, runPickerLabel, runsForAgent, toolMapping, toolsMappedLabel } from "@/lib/derive";
import { AGENTS, linkProps } from "@/lib/routes";
import { NO_KEY_LINE, textButton } from "@/lib/ui";
import { cn } from "@/lib/utils";

/**
 * `/app/agents/:id` (docs/plans/08-rework-round-2.md §7): one agent, whole. Its tile, name and the per-agent
 * actions (ping · start/stop the example agent · delete with a second click) over a run picker — newest run
 * first — and, for the picked run, `RunResults`. Versions are per run (each run starts at v0), which is why
 * the picker sits above the version rail. Nothing here starts a run: that is Current run.
 */

// While the example agent starts, its row changes within seconds; the shell's 10 s list poll is too slow.
const STARTING_MS = 3_000;

const quiet = cn(textButton, "text-[12px]");

export default function AgentPage({ id, shell }: { id: string; shell: ShellData }) {
  const { agents, agentsError, runs, runsError, health, refresh } = shell;
  const agent = agents?.find((a) => a.id === id) ?? null;
  // The built-in row lists exactly the storefront's tools (api/agents.py `_builtin_row`); the mapping is
  // measured against it.
  const storefront = agents?.find((a) => a.id === "builtin")?.tools?.map((t) => t.name) ?? null;
  const noKey = health !== null && !health.has_api_key;

  // Ping made here lives in page state — synthetic rows have nowhere to keep one. `note` is one inline
  // message for HTTP failures (409, 503); a ping error is a result, not a message.
  const [ping, setPing] = useState<PingResult | "pending" | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  // "starting…" from the click until the next poll's `starting`/`running` takes over (a few seconds at most).
  const [justStarted, setJustStarted] = useState(false);
  const isExample = id === "example";
  const exState = agent && isExample ? exampleState(agent) : null;
  const starting = isExample && (exState === "starting" || (exState === "stopped" && justStarted));
  useEffect(() => {
    if (!starting) return;
    const t = setInterval(refresh, STARTING_MS);
    return () => clearInterval(t);
  }, [starting, refresh]);

  const doPing = async () => {
    setPing("pending");
    setNote(null);
    try {
      setPing(await api.agentPing(id));
    } catch (e) {
      setPing(null);
      setNote(e instanceof Error ? e.message : String(e));
    } finally {
      refresh();
    }
  };
  const remove = async () => {
    setConfirming(false);
    try {
      await api.agentDelete(id);
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    } finally {
      refresh();
    }
  };
  const startExample = async () => {
    setNote(null);
    setJustStarted(true);
    setTimeout(() => setJustStarted(false), 2 * STARTING_MS);
    try {
      await api.exampleStart();
    } catch (e) {
      setJustStarted(false);
      setNote(e instanceof Error ? e.message : String(e));
    } finally {
      refresh();
    }
  };
  const stopExample = async () => {
    setNote(null);
    setJustStarted(false);
    try {
      await api.exampleStop();
    } catch (e) {
      // 404 = nothing was running; the subline already says so.
      if (!(e instanceof ApiError && e.status === 404)) setNote(e instanceof Error ? e.message : String(e));
    } finally {
      refresh();
    }
  };
  const inSession = ping && ping !== "pending" ? ping : null;
  const mapping = agent ? (inSession ? inSession.mapping : toolMapping(agent.tools, storefront)) : null;
  const pingBad = (inSession && !inSession.ok) || (!inSession && agent?.last_ping && !agent.last_ping.ok);
  const agentRuns = runs ? runsForAgent(runs, id) : null;
  const [pickedRun, setPickedRun] = useState<string | null>(null);
  const runId = pickedRun && agentRuns?.some((r) => r.id === pickedRun) ? pickedRun : (agentRuns?.[0]?.id ?? null);
  const row = agentRuns?.find((r) => r.id === runId) ?? null;

  // One read per picked run (a finished run's files do not change under the page), tagged with the run it
  // belongs to so switching runs never shows the previous run's results over the new run's header.
  const readFn = useCallback(() => {
    if (!runId) return Promise.resolve(null);
    const source = readSource(runId);
    return Promise.all([api.cycles(source).catch(() => null), api.state(source).catch(() => null)]).then(([cycles, state]) => ({ runId, cycles, state }));
  }, [runId]);
  const { data: read } = usePoll(readFn, 0);
  const current = read && read.runId === runId ? read : null;

  const down = (agents === null && agentsError !== null) || (runs === null && runsError !== null);

  return (
    <Page
      eyebrow={
        <a {...linkProps(AGENTS)} className="rounded transition-colors hover:text-[var(--fg)]">
          Agents /
        </a>
      }
      title={agent?.name ?? (agents ? "Unknown agent" : "…")}
    >
      {down ? (
        <p className="text-[13px]">
          <ApiDown onRetry={refresh} />
        </p>
      ) : agents && !agent ? (
        <PanelEmpty>
          No agent with id <span className="code">{id}</span>. It may have been deleted;{" "}
          <a {...linkProps(AGENTS)} className="text-[var(--muted)] hover:text-[var(--fg)]">
            back to Agents
          </a>
          .
        </PanelEmpty>
      ) : (
        <div className="flex flex-col gap-6">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-center gap-4">
              {agent && <AgentTile agent={agent} size={48} />}
              <div className="min-w-0">
                <p className="text-[15px] font-medium text-[var(--fg)]">{agent?.name ?? "…"}</p>
                <p className="mt-0.5 text-[12px] text-[var(--faint)]">
                  {agent ? agentSubline(agent, starting) : ""}
                  {agent?.url && agent.id !== "builtin" && <span className="code"> · {agent.url}</span>}
                  {agentRuns && ` · ${agentRuns.length} ${agentRuns.length === 1 ? "run" : "runs"}`}
                  {mapping && ` · tools ${toolsMappedLabel(mapping)}`}
                </p>
                {agent && (
                  <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1">
                    {agent.id !== "builtin" && (
                      <>
                        <button type="button" onClick={() => void doPing()} disabled={ping === "pending"} className={quiet}>
                          ping
                        </button>
                        <span className={cn("tabular text-[12px] text-[var(--faint)]", pingBad && "text-[var(--danger)]")}>
                          {ping === "pending" ? "pinging…" : inSession ? pingResultLine(inSession) : pingLabel(agent.last_ping)}
                        </span>
                      </>
                    )}
                    {isExample &&
                      (exState === "running" || exState === "starting" ? (
                        <button type="button" onClick={() => void stopExample()} className={quiet}>
                          stop
                        </button>
                      ) : (
                        <button type="button" onClick={() => void startExample()} disabled={starting || noKey} title={noKey ? `${NO_KEY_LINE}; the example agent calls inference` : undefined} className={quiet}>
                          {starting ? "starting…" : "start"}
                        </button>
                      ))}
                    {!agent.synthetic &&
                      (confirming ? (
                        <span className="inline-flex gap-3">
                          <button type="button" onClick={() => void remove()} className={cn(quiet, "text-[var(--danger)] hover:text-[var(--danger)]")}>
                            confirm delete
                          </button>
                          <button type="button" onClick={() => setConfirming(false)} className={quiet}>
                            cancel
                          </button>
                        </span>
                      ) : (
                        <button type="button" onClick={() => setConfirming(true)} className={quiet}>
                          delete
                        </button>
                      ))}
                    {note && (
                      <span role="alert" className="text-[12px] text-[var(--danger)]">
                        {note}
                      </span>
                    )}
                  </div>
                )}
              </div>
            </div>

            {agentRuns && agentRuns.length > 0 && runId && (
              <div className="flex items-center gap-4 text-[12px]">
                <Select value={runId} options={agentRuns.map((r) => ({ value: r.id, label: runPickerLabel(r) }))} onChange={setPickedRun} name="Run" panelWidth={300} />
                {row?.recording ? (
                  <a {...linkProps({ kind: "run", id: runId, replay: true })} className="rounded text-[var(--muted)] transition-colors hover:text-[var(--fg)]">
                    watch replay
                  </a>
                ) : (
                  <a {...linkProps({ kind: "run", id: runId })} className="rounded text-[var(--muted)] transition-colors hover:text-[var(--fg)]">
                    open run
                  </a>
                )}
              </div>
            )}
          </div>

          {agentRuns === null ? (
            <PanelEmpty>…</PanelEmpty>
          ) : agentRuns.length === 0 ? (
            <PanelEmpty>This agent has never been attacked. Select it and press Heal on Current run.</PanelEmpty>
          ) : !current ? (
            <PanelEmpty>…</PanelEmpty>
          ) : current.cycles === null ? (
            <PanelEmpty>Could not read this run.</PanelEmpty>
          ) : (
            <RunResults runId={current.runId} row={row} cycles={current.cycles} state={current.state} />
          )}
        </div>
      )}
    </Page>
  );
}
