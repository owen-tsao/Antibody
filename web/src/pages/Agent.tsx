import { useCallback, useEffect, useRef, useState } from "react";

import { api, ApiError, type PingResult, type ToolRule } from "@/api";
import AgentTile from "@/components/AgentTile";
import ApiDown from "@/components/ApiDown";
import ImportIncidentDialog from "@/components/ImportIncidentDialog";
import Page from "@/components/Page";
import Panel, { PanelEmpty } from "@/components/Panel";
import RunResults from "@/components/RunResults";
import { Select, Switch } from "@/components/RunSettingsFields";
import type { ShellData } from "@/components/Shell";
import { usePoll } from "@/hooks/usePoll";
import {
  agentSubline,
  exampleState,
  fmtTimeShort,
  gatewayCallLine,
  gatewayDecisionLabel,
  gatewayLine,
  gatewayRows,
  pingLabel,
  pingResultLine,
  readSource,
  ruleLine,
  runPickerLabel,
  runsForAgent,
  suiteLine,
  suiteRows,
  TOOL_CLASS_LABEL,
  toolMapping,
  toolRows,
  toolsLine,
  toolsMappedLabel,
  worldLine,
} from "@/lib/derive";
import { AGENTS, linkProps } from "@/lib/routes";
import { NO_KEY_LINE, textButton, textInput } from "@/lib/ui";
import { cn } from "@/lib/utils";

/**
 * `/app/agents/:id` (docs/plans/08-rework-round-2.md §7): one agent, whole. Its tile, name and the per-agent
 * actions (ping · start/stop the example agent · delete with a second click) over a run picker — newest run
 * first — and, for the picked run, `RunResults`. Versions are per run (each run starts at v0), which is why
 * the picker sits above the version rail. Nothing here starts a run: that is Current run. Nothing here approves
 * a version either: that is the Review page.
 */

// While the example agent starts, its row changes within seconds; the shell's 10 s list poll is too slow.
const STARTING_MS = 3_000;

const quiet = cn(textButton, "text-[12px]");

export default function AgentPage({ id, shell }: { id: string; shell: ShellData }) {
  const { agents, agentsError, runs, runsError, health, refresh } = shell;
  const agent = agents?.find((a) => a.id === id) ?? null;
  // The built-in row lists exactly the sandbox's tools (api/agents.py `_builtin_row`); the mapping is
  // measured against it.
  const sandbox = agents?.find((a) => a.id === "builtin")?.tools?.map((t) => t.name) ?? null;
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
  const mapping = agent ? (inSession ? inSession.mapping : toolMapping(agent.tools, sandbox)) : null;
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
    return Promise.all([api.cycles(source).catch(() => null), api.state(source).catch(() => null), api.approvals(source).catch(() => null)]).then(
      ([cycles, state, approvals]) => ({ runId, cycles, state, approvals }),
    );
  }, [runId]);
  const { data: read, refresh: reread } = usePoll(readFn, 0);
  const current = read && read.runId === runId ? read : null;
  // Deciding a version happens on the Review page, against its diff (plan 10 B1); here the marks are read-only.
  // Measuring (plan 11 §1) is offered on the current run's results; the manifest says whether this API can.
  const { data: manifest } = usePoll(api.manifest, 60_000);
  // The picked run's files change when a loop over them exits (a measurement started here): re-read then.
  const wasRunning = useRef(false);
  useEffect(() => {
    const running = !!shell.loop?.running;
    if (wasRunning.current && !running) reread();
    wasRunning.current = running;
  }, [shell.loop?.running, reread]);

  const down = (agents === null && agentsError !== null) || (runs === null && runsError !== null);

  // The live suite: what the next run against any agent is gated on. Imported incidents land here.
  const { data: suite, refresh: refreshSuite } = usePoll(api.regression, 60_000);
  const [importing, setImporting] = useState(false);
  const [imported, setImported] = useState<string | null>(null);

  // Bring your own tools: the agent's listed tools with a proposed rule each; `chosen` is the person's edit of
  // the proposal (a name present = apply that rule). Not for the built-in agent, whose tools are the sandbox's.
  const toolsFn = useCallback(() => (agent && agent.id !== "builtin" ? api.agentTools(id) : Promise.resolve(null)), [agent, id]);
  const { data: proposal, refresh: refreshProposal } = usePoll(toolsFn, 0);
  const [chosen, setChosen] = useState<Record<string, ToolRule> | null>(null);
  const rules = chosen ?? proposal?.starter_rules ?? {};
  const [applied, setApplied] = useState<string | null>(null);
  const applyRules = async () => {
    setNote(null);
    try {
      const cfg = await api.agentToolsApply(id, rules);
      setApplied(`saved as v${cfg.version}`);
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    }
  };
  const [backendDraft, setBackendDraft] = useState<string | null>(null);
  const saveBackend = async () => {
    if (backendDraft === null) return;
    setNote(null);
    try {
      await api.agentPatch(id, { tools_backend: backendDraft.trim() || null });
      setBackendDraft(null);
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    } finally {
      refresh();
    }
  };
  useEffect(() => {
    // A ping lists the tools; re-read the proposal when the row's list changes.
    if (agent?.tools) refreshProposal();
  }, [agent?.tools, refreshProposal]);

  // The gateway's shadow log for this agent's tools: the file is one per install, so the read is scoped by the agent's
  // `tools_backend` (the rule the Review replay follows); an agent with no backend has no gateway in front of anything.
  const backend = agent?.tools_backend ?? null;
  const gatewayFn = useCallback(() => (backend ? api.gateway(200, backend) : Promise.resolve(null)), [backend]);
  const { data: gatewayLog } = usePoll(gatewayFn, 30_000);

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
                    <button type="button" onClick={() => setImporting(true)} className={quiet}>
                      import incident
                    </button>
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
            <RunResults runId={current.runId} row={row} cycles={current.cycles} state={current.state} approvals={current.approvals} shell={shell} manifest={manifest} onMeasured={refresh} compareOpen />
          )}

          {agent && agent.id !== "builtin" && (
            <Panel title="Tools" aside={<span className="tabular">{toolsLine(proposal)}</span>}>
              <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 border-b border-[var(--border)] px-4 py-3 text-[12.5px]">
                <div className="min-w-0">
                  <p className="text-[13px] text-[var(--fg)]">Real tools</p>
                  <p className="mt-0.5 text-[12px] text-[var(--faint)]">
                    Where <span className="code">POST /tools/&#123;name&#125;</span> should go during an attack. Empty = the {worldLine(agent.domain)} stands in.
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <input
                    className={cn(textInput, "code h-9 w-[260px] rounded-lg px-3 text-[13px]")}
                    value={backendDraft ?? agent.tools_backend ?? ""}
                    onChange={(e) => setBackendDraft(e.target.value)}
                    placeholder="http://127.0.0.1:8791"
                    spellCheck={false}
                    aria-label="Tools backend URL"
                  />
                  {backendDraft !== null && backendDraft.trim() !== (agent.tools_backend ?? "") && (
                    <button type="button" onClick={() => void saveBackend()} className={quiet}>
                      save
                    </button>
                  )}
                </div>
              </div>
              {proposal === null ? (
                <PanelEmpty>…</PanelEmpty>
              ) : !proposal.tools ? (
                <PanelEmpty>This agent has not listed its tools. Ping it: agents that serve GET /tools get a proposed rule per tool.</PanelEmpty>
              ) : (
                <>
                  <ul className="divide-y divide-[var(--border)]">
                    {toolRows(proposal).map((t) => {
                      const on = t.name in rules;
                      return (
                        <li key={t.name} className="flex items-center gap-4 px-4 py-2.5 text-[12.5px]">
                          <span className="code min-w-0 flex-1 truncate text-[var(--fg)]" title={t.description || undefined}>
                            {t.name}
                          </span>
                          <span className="w-[120px] shrink-0 text-[var(--faint)]">{TOOL_CLASS_LABEL[t.cls]}</span>
                          <span className={cn("w-[200px] shrink-0 truncate", on ? "text-[var(--muted)]" : "text-[var(--faint)]")}>{t.rule ? ruleLine(t.rule) : "—"}</span>
                          <span className="w-9 shrink-0 text-right">
                            {t.rule && <Switch checked={on} onChange={(v) => setChosen(v ? { ...rules, [t.name]: t.rule! } : Object.fromEntries(Object.entries(rules).filter(([k]) => k !== t.name)))} name={`Apply rule for ${t.name}`} />}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                  <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 border-t border-[var(--border)] px-4 py-3 text-[12.5px]">
                    <p className="text-[var(--faint)]">Saves the chosen rules as the next config version; the next run starts from it and check verifies it.</p>
                    <span className="inline-flex items-center gap-4">
                      {applied && <span className="text-[var(--faint)]">{applied}</span>}
                      <button type="button" onClick={() => void applyRules()} disabled={Object.keys(rules).length === 0} className={cn(textButton, "text-[12.5px]")}>
                        <span className="u-line">apply {Object.keys(rules).length} {Object.keys(rules).length === 1 ? "rule" : "rules"}</span>
                      </button>
                    </span>
                  </div>
                </>
              )}
            </Panel>
          )}

          {agent && agent.id !== "builtin" && (
            <Panel title="Shadow log" aside={<span className="tabular">{backend ? gatewayLine(gatewayLog) : "no tools backend"}</span>}>
              {!backend ? (
                <PanelEmpty>Point this agent at its real tools above; the gateway in front of them logs here.</PanelEmpty>
              ) : gatewayLog === null ? (
                <PanelEmpty>…</PanelEmpty>
              ) : gatewayLog.events.length === 0 ? (
                <div className="flex flex-col gap-2 px-4 py-6 text-center text-[12px] text-[var(--faint)]">
                  <p>The gateway runs the approved rules in front of this agent's real tools and logs first. Start it beside the agent:</p>
                  <p className="code select-all text-[var(--muted)]">{gatewayLog.command}</p>
                </div>
              ) : gatewayRows(gatewayLog).length === 0 ? (
                <PanelEmpty>Every call so far was allowed.</PanelEmpty>
              ) : (
                <ul className="divide-y divide-[var(--border)]">
                  {gatewayRows(gatewayLog).map((e, i) => (
                    <li key={`${e.at}-${i}`} className="flex items-center gap-4 px-4 py-2.5 text-[12.5px]">
                      <span className="code min-w-0 flex-1 truncate text-[var(--fg)]" title={e.reason ?? undefined}>
                        {gatewayCallLine(e)}
                      </span>
                      <span className="hidden min-w-0 max-w-[200px] truncate text-[var(--faint)] sm:inline">{e.customer || e.session}</span>
                      <span className={cn("w-[84px] shrink-0 text-right", e.decision === "blocked" ? "text-[var(--danger)]" : "text-[var(--muted)]")}>{gatewayDecisionLabel(e)}</span>
                      <span className="tabular w-[64px] shrink-0 text-right text-[var(--faint)]">{fmtTimeShort(e.at)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          )}

          <Panel title="Past attacks" aside={suite ? <span className="tabular">{suiteLine(suite)}</span> : undefined}>
            {suite === null ? (
              <PanelEmpty>…</PanelEmpty>
            ) : suite.length === 0 ? (
              <PanelEmpty>Nothing captured yet. Every attack that gets through is added; you can also import a real conversation.</PanelEmpty>
            ) : (
              <ul className="divide-y divide-[var(--border)]">
                {suiteRows(suite).map((s) => (
                  <li key={s.id} className={cn("flex items-center gap-4 px-4 py-2.5 text-[12.5px]", s.id === imported && "bg-[var(--hover)]")}>
                    <span className="min-w-0 flex-1 truncate text-[var(--fg)]">{s.title}</span>
                    <span className="shrink-0 text-[var(--faint)]">{s.kind}</span>
                    <span className={cn("w-[84px] shrink-0 text-right", s.origin === "imported" ? "text-[var(--muted)]" : "text-[var(--faint)]")}>{s.origin}</span>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>
      )}
      {importing && (
        <ImportIncidentDialog
          onClose={() => setImporting(false)}
          onImported={(s) => {
            setImported(s.id);
            refreshSuite();
          }}
        />
      )}
    </Page>
  );
}
