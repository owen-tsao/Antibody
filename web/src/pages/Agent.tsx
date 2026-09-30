import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { api, ApiError, type PingResult, type ToolRule } from "@/api";
import AgentCard from "@/components/AgentCard";
import ApiDown from "@/components/ApiDown";
import ImportIncidentDialog from "@/components/ImportIncidentDialog";
import Page from "@/components/Page";
import Panel, { PanelEmpty } from "@/components/Panel";
import { VersionRail } from "@/components/RunResults";
import { Switch } from "@/components/RunSettingsFields";
import type { ShellData } from "@/components/Shell";
import DitherDonutChart from "@/components/ui/dither-donut-chart";
import PartitionBar from "@/components/ui/partition-bar";
import { usePoll } from "@/hooks/usePoll";
import {
  agentStatus,
  exampleName,
  exampleState,
  findingsLine,
  findingStatusLabel,
  fmtDate,
  fmtTimeShort,
  gatewayCallLine,
  gatewayDecisionLabel,
  gatewayLine,
  gatewayRows,
  pingLabel,
  pingResultLine,
  readSource,
  ruleLine,
  rulesInForce,
  rulesLine,
  runAgentLabel,
  runFindings,
  type RunRead,
  runsForAgent,
  suiteByFamily,
  TOOL_CLASS_LABEL,
  toolRows,
  versionName,
  versionNameIn,
  versionsOf,
  worldLine,
} from "@/lib/derive";
import { AGENTS, linkProps, LIVE_RUN, navigate, reviewVersion, RUNS } from "@/lib/routes";
import { type RunSettings, toStartBody } from "@/lib/settings";
import { eyebrow, NO_KEY_LINE, primaryButton, secondaryButton, textButton, textInput } from "@/lib/ui";
import { cn } from "@/lib/utils";

/**
 * `/app/agents/:id` (docs/plans/14-agent-page.md): the agent as the thing you protect, not its last run again. The
 * card, then four cells — what is in force, what the gateway is doing, when it was last and is next tested — then
 * what every run found, live traffic, the rules in force beside the suite by family, past attacks, and one line
 * for the runs. Heal is the page's one button. Nothing here approves a version: that is Review.
 */

// While the example agent starts, its row changes within seconds; the shell's 10 s list poll is too slow.
const STARTING_MS = 3_000;

const quiet = cn(textButton, "text-[12px]");

/** Five greys for the donut, brightest first; the palette keeps colour for signals. */
const DONUT_GREYS = ["#fafafa", "#c4c4cc", "#a1a1aa", "#7c7c86", "#5f5f68"];

export default function AgentPage({ id, shell, settings, onSettingsChange }: { id: string; shell: ShellData; settings: RunSettings; onSettingsChange: (next: RunSettings) => void }) {
  const { agents, agentsError, runs, runsError, health, loop, refresh } = shell;
  const agent = agents?.find((a) => a.id === id) ?? null;
  const noKey = health !== null && !health.has_api_key;
  const running = loop?.running ?? false;

  const [ping, setPing] = useState<PingResult | "pending" | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [justStarted, setJustStarted] = useState(false);
  const example = exampleName(id);
  const isExample = example !== null;
  const exState = agent && isExample ? exampleState(agent) : null;
  const starting = isExample && (exState === "starting" || (exState === "stopped" && justStarted));
  useEffect(() => {
    if (!starting) return;
    const t = setInterval(refresh, STARTING_MS);
    return () => clearInterval(t);
  }, [starting, refresh]);

  // One shape for the chores: `then` runs only on success, so a failed save keeps the draft; `quiet404` is for
  // stopping the example agent, where 404 means nothing was running and the button already says so.
  const call = async (fn: () => Promise<unknown>, opts: { then?: () => void; onError?: () => void; quiet404?: boolean } = {}) => {
    setNote(null);
    try {
      await fn();
      opts.then?.();
    } catch (e) {
      opts.onError?.();
      if (!(opts.quiet404 && e instanceof ApiError && e.status === 404)) setNote(e instanceof Error ? e.message : String(e));
    } finally {
      refresh();
    }
  };
  const doPing = async () => {
    setPing("pending");
    await call(async () => setPing(await api.agentPing(id)), { onError: () => setPing(null) });
  };
  const startExample = () => {
    setJustStarted(true);
    setTimeout(() => setJustStarted(false), 2 * STARTING_MS);
    return call(() => api.exampleStart(example!), { onError: () => setJustStarted(false) });
  };
  const inSession = ping && ping !== "pending" ? ping : null;
  const pingBad = (inSession && !inSession.ok) || (!inSession && agent?.last_ping && !agent.last_ping.ok);

  // Heal from here: the same start as Current run's button, for this agent, with the saved defaults. The target is
  // saved first, as every other start does, so Home and the rail follow the agent that was just attacked.
  const [healing, setHealing] = useState(false);
  const heal = async () => {
    setHealing(true);
    const next = { ...settings, target: id };
    onSettingsChange(next);
    try {
      await api.loopStart(toStartBody(next));
      navigate(LIVE_RUN);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) navigate(LIVE_RUN);
      else setNote(e instanceof Error ? e.message : String(e));
    } finally {
      setHealing(false);
      refresh();
    }
  };

  const agentRuns = useMemo(() => (runs ? runsForAgent(runs, id) : null), [runs, id]);
  const newest = agentRuns?.[0] ?? null;

  // One read of state + decisions per run of this agent (a finished run's files do not change under the page);
  // keyed by run id so the strip and the findings never mix one run's numbers into another's row.
  const runIds = agentRuns?.map((r) => r.id).join(",") ?? "";
  const readsFn = useCallback(() => {
    if (!runIds) return Promise.resolve({} as Record<string, RunRead>);
    return Promise.all(
      runIds.split(",").map((runId) => {
        const source = readSource(runId);
        return Promise.all([api.state(source).catch(() => null), api.approvals(source).catch(() => null)]).then(([state, approvals]) => [runId, { state, approvals }] as const);
      }),
    ).then((pairs) => Object.fromEntries(pairs) as Record<string, RunRead>);
  }, [runIds]);
  const { data: reads, refresh: reread } = usePoll(readsFn, 0);
  // The newest run's cycles name its versions and group its suite by family for the donut.
  const cyclesFn = useCallback(() => (newest ? api.cycles(readSource(newest.id)).catch(() => null) : Promise.resolve(null)), [newest]);
  const { data: newestCycles } = usePoll(cyclesFn, 0);
  // A loop that just exited (Heal from here, a measurement) changed the live run's files: read again — on the
  // transition only, since the one-shot read already covers mount.
  const wasRunning = useRef(false);
  useEffect(() => {
    if (wasRunning.current && !running) reread();
    wasRunning.current = running;
  }, [running, reread]);

  const live = runs?.find((r) => r.id === "live") ?? null;
  const liveIsOurs = live?.agent?.id === id;
  const liveAgentLabel = live ? runAgentLabel(live) : null;
  const liveRead = liveIsOurs ? reads?.["live"] : undefined;
  const certified = liveRead?.approvals?.certified ?? 0;
  const configFn = useCallback(() => (liveIsOurs && liveRead !== undefined ? api.config(certified, "live").catch(() => null) : Promise.resolve(null)), [liveIsOurs, liveRead, certified]);
  const { data: inForce } = usePoll(configFn, 0);

  const { data: schedules } = usePoll(api.schedules, 60_000);
  // Import adds to the regression suite, which every future run measures; the confirmation is a word in the chores line.
  const [importing, setImporting] = useState(false);
  const [imported, setImported] = useState<string | null>(null);

  // Bring your own tools: proposed starter rules for a connected agent; `chosen` is the person's edit of the proposal.
  const toolsFn = useCallback(() => (agent && agent.id !== "builtin" ? api.agentTools(id) : Promise.resolve(null)), [agent, id]);
  const { data: proposal, refresh: refreshProposal } = usePoll(toolsFn, 0);
  const [chosen, setChosen] = useState<Record<string, ToolRule> | null>(null);
  const rules = chosen ?? proposal?.starter_rules ?? {};
  const [applied, setApplied] = useState<string | null>(null);
  const applyRules = () => call(async () => setApplied(`saved as v${(await api.agentToolsApply(id, rules)).version}`));
  const [backendDraft, setBackendDraft] = useState<string | null>(null);
  const saveBackend = () => (backendDraft === null ? Promise.resolve() : call(() => api.agentPatch(id, { tools_backend: backendDraft.trim() || null }), { then: () => setBackendDraft(null) }));
  useEffect(() => {
    if (agent?.tools) refreshProposal();
  }, [agent?.tools, refreshProposal]);

  const backend = agent?.tools_backend ?? null;
  const gatewayFn = useCallback(() => (backend ? api.gateway(200, backend) : Promise.resolve(null)), [backend]);
  const { data: gatewayLog } = usePoll(gatewayFn, 30_000);

  const down = (agents === null && agentsError !== null) || (runs === null && runsError !== null);
  const status = agent && agentRuns && runs ? agentStatus(agent, agentRuns, runs, reads ?? {}, liveIsOurs ? (newestCycles ?? null) : null, gatewayLog, schedules) : null;
  const findings = agentRuns && reads ? runFindings(agentRuns, reads) : null;
  const ruleRows = rulesInForce(liveIsOurs ? inForce : null, agent?.tools ?? null);
  const pendingVersion = liveRead ? (versionsOf(live, []).filter((v) => v > 0 && !(liveRead.approvals?.decisions ?? []).some((d) => d.version === v && d.status !== "pending")).sort((a, b) => b - a)[0] ?? null) : null;

  // The donut compares the version in force with the pending fix on the newest run's suite; one stop when there is no fix.
  const newestVuln = newest ? reads?.[newest.id]?.state?.vulnerability : null;
  const donutStops = useMemo(() => {
    const vs = [certified];
    if (liveIsOurs && pendingVersion !== null && pendingVersion !== certified) vs.push(pendingVersion);
    return vs;
  }, [certified, liveIsOurs, pendingVersion]);
  // A version a cycle's patch made is a Fix; one applied from this page's starter rules is a Version. Until the
  // cycles load the certified number is all there is, so the name falls back to Fix. Only the stops are ever named.
  const stopNames = Object.fromEntries(donutStops.map((v) => [v, liveIsOurs && newestCycles ? versionNameIn(newestCycles, v, liveRead?.approvals) : versionName(v, true, certified)]));
  const nameOfVersion = (v: number) => stopNames[v] ?? versionName(v, true, certified);
  const [donutPick, setDonutPick] = useState<number | null>(null);
  const donutV = donutPick !== null && donutStops.includes(donutPick) ? donutPick : donutStops[donutStops.length - 1]!;
  const families = useMemo(() => (newestCycles && liveIsOurs ? suiteByFamily(newestCycles, newestVuln, donutV) : []), [newestCycles, liveIsOurs, newestVuln, donutV]);
  const segments = useMemo(() => families.map((f, i) => ({ name: f.family, value: f.attacks, filled: f.attacks ? f.blocked / f.attacks : 0, color: DONUT_GREYS[i % DONUT_GREYS.length]! })), [families]);
  const [hoverFamily, setHoverFamily] = useState<number | null>(null);

  const action = (
    <>
      <button type="button" onClick={() => setImporting(true)} className={secondaryButton}>
        Import incident
      </button>
      {running ? (
        <a {...linkProps(LIVE_RUN)} className={cn(textButton, "text-[13px]")}>
          Running{shell.status?.cycle ? ` · cycle ${shell.status.cycle}` : ""} · open Current run →
        </a>
      ) : (
        <button type="button" onClick={() => void heal()} disabled={!agent || healing || noKey || (isExample && exState !== "running")} title={noKey ? NO_KEY_LINE : isExample && exState !== "running" ? "Start the agent first" : undefined} className={primaryButton}>
          {healing ? "Starting…" : "Heal"}
        </button>
      )}
    </>
  );

  return (
    <Page
      className="flex flex-col xl:h-[calc(100dvh-3.5rem)] xl:flex-none"
      eyebrow={
        <a {...linkProps(AGENTS)} className="rounded transition-colors hover:text-[var(--fg)]">
          Agents /
        </a>
      }
      title={agent?.name ?? (agents ? "Unknown agent" : "…")}
      action={agent ? action : undefined}
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
        <div className="flex min-h-0 flex-1 flex-col gap-5">
          {/* The card carries the answer to "am I protected?" in the display face the title used to; the header already
              names the agent. A scrim over the whole photo keeps the values legible wherever the flare lands. */}
          {agent && (
            <AgentCard agent={agent} ratio="free" title="none" className="h-[200px] shrink-0">
              {/* The scrim itself lets the pointer through to the card; a value with a `line` takes it back so its tooltip can show. */}
              <dl className="pointer-events-none absolute inset-0 z-30 grid grid-cols-2 content-center gap-x-6 gap-y-6 rounded-[26px] bg-gradient-to-t from-black/85 via-black/55 to-black/25 px-8 py-6 text-center text-white sm:grid-cols-4">
                {(status ?? [{ label: "running on", value: "…" }, { label: "gateway", value: "…" }, { label: "last tested", value: "…" }, { label: "next test", value: "…" }]).map((c) => (
                  <div key={c.label} className="min-w-0">
                    <dt className="text-[11px] uppercase tracking-[0.1em] text-white/55">{c.label}</dt>
                    <dd className="display mt-3 overflow-hidden text-ellipsis whitespace-nowrap leading-[1.15] [font-size:clamp(26px,3.4cqw,42px)] [&[title]]:pointer-events-auto" title={"line" in c ? c.line : undefined}>
                      {c.value}
                    </dd>
                  </div>
                ))}
              </dl>
            </AgentCard>
          )}

          {/* The per-agent chores, quiet under the card: they are maintenance, not the page's point. The built-in agent has none. */}
          {agent && (agent.id !== "builtin" || imported || note) && (
            <div className="flex flex-wrap items-center gap-x-5 gap-y-1 px-1 text-[12px]">
              {agent.id !== "builtin" && (
                <>
                  <button type="button" onClick={() => void doPing()} disabled={ping === "pending"} className={quiet}>
                    ping
                  </button>
                  <span className={cn("tabular text-[var(--faint)]", pingBad && "text-[var(--danger)]")}>{ping === "pending" ? "pinging…" : inSession ? pingResultLine(inSession) : pingLabel(agent.last_ping)}</span>
                </>
              )}
              {isExample &&
                (exState === "running" || exState === "starting" ? (
                  <button type="button" onClick={() => void call(() => api.exampleStop(example!), { then: () => setJustStarted(false), quiet404: true })} className={quiet}>
                    stop
                  </button>
                ) : (
                  <button type="button" onClick={() => void startExample()} disabled={starting || noKey} title={noKey ? `${NO_KEY_LINE}; this agent calls inference` : undefined} className={quiet}>
                    {starting ? "starting…" : "start"}
                  </button>
                ))}
              {imported && <span className="truncate text-[var(--faint)]">{imported}</span>}
              {!agent.synthetic &&
                (confirming ? (
                  <span className="inline-flex gap-3">
                    <button type="button" onClick={() => void call(() => api.agentDelete(id), { then: () => setConfirming(false), onError: () => setConfirming(false) })} className={cn(quiet, "text-[var(--danger)] hover:text-[var(--danger)]")}>
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
              {agent.url && agent.id !== "builtin" && <span className="code text-[var(--faint)]">{agent.url}</span>}
              {note && (
                <span role="alert" className="text-[var(--danger)]">
                  {note}
                </span>
              )}
            </div>
          )}






          {/* Two columns that take the rest of the screen and scroll inside: what is in force (the rules, the suite they
              are measured on, and for a connected agent the gateway's log) beside what every run found. */}
          <div className="grid min-h-0 flex-1 gap-5 xl:grid-cols-2 xl:grid-rows-[minmax(0,1fr)]">
          <Panel
            className="min-h-[280px] xl:min-h-0"
            bodyClassName="flex min-h-0 flex-col overflow-y-auto"
            title={`Rules in force · ${liveIsOurs ? nameOfVersion(certified) : "nothing"}`}
            aside={
              <>
                <span className="tabular">{rulesLine(ruleRows)}</span>
                {liveIsOurs && pendingVersion !== null && pendingVersion !== certified && (
                  <a {...linkProps(reviewVersion("live", pendingVersion))} className="rounded transition-colors hover:text-[var(--fg)]">
                    what {nameOfVersion(pendingVersion)} adds →
                  </a>
                )}
              </>
            }
          >
            {/* The grid takes the body's height so the rules' dividers run to the panel's foot, not to the donut's. */}
            <div className={cn("grid flex-1", families.length > 0 && "md:grid-cols-[minmax(0,1fr)_250px]")}>
              {/* One row per tool, the rule the version in force carries for it. */}
              {ruleRows.length === 0 ? (
                <PanelEmpty>{liveIsOurs ? "This agent has not listed its tools. Ping it." : liveAgentLabel ? `Nothing is in force: the current run attacked ${liveAgentLabel}. Heal to start one for this agent.` : agentRuns && agentRuns.length > 0 ? "Nothing is in force: no current run. Heal to start one for this agent." : "Nothing in force yet. Heal to find the first weakness."}</PanelEmpty>
              ) : (
                <ul className="grid auto-rows-fr divide-y divide-[var(--border)]">
                  {ruleRows.map((r) => (
                    <li key={r.tool} className="flex min-h-10 items-center gap-4 px-4 py-2.5 text-[13px]">
                      <span className="code min-w-0 flex-1 truncate text-[var(--fg)]">{r.tool}</span>
                      <span className={cn("min-w-0 max-w-[260px] truncate text-right", r.rule ? "text-[var(--muted)]" : "text-[var(--faint)]")}>{r.rule ? ruleLine(r.rule) : "—"}</span>
                    </li>
                  ))}
                </ul>
              )}
              {/* Beside the list: the suite by family, dense where the picked version blocks it. No donut for a single family. */}
              {families.length > 0 && (
                <div className="flex flex-col gap-3 border-t border-[var(--border)] px-4 py-3 md:border-l md:border-t-0">
                  <div className="flex items-center justify-between gap-3">
                    <span className={eyebrow}>blocked by family</span>
                    {donutStops.length > 1 && <VersionRail versions={donutStops} value={donutV} onChange={(v) => setDonutPick(typeof v === "number" ? v : null)} marks={liveRead?.approvals} nameOf={nameOfVersion} all={false} />}
                  </div>
                  <div className="flex flex-col items-center gap-3">
                    {families.length > 1 && (
                      <div className="h-[144px] w-[144px] shrink-0">
                        <DitherDonutChart segments={segments} hover={hoverFamily} />
                      </div>
                    )}
                    <ul className="flex w-full min-w-0 flex-col gap-0.5">
                      {families.map((f, i) => (
                        <li key={f.family} onMouseEnter={() => setHoverFamily(i)} onMouseLeave={() => setHoverFamily(null)} className={cn("flex items-center justify-between gap-3 rounded-md px-2 py-0.5 text-[12px] transition-colors", hoverFamily === i && "bg-[var(--hover)]")}>
                          <span className="flex min-w-0 items-center gap-2">
                            <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: DONUT_GREYS[i % DONUT_GREYS.length] }} aria-hidden />
                            <span className="truncate text-[var(--fg)]">{f.family}</span>
                          </span>
                          <span className="tabular shrink-0 text-[var(--muted)]">
                            {f.blocked} of {f.attacks}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
              )}
            </div>

            {/* Proposed starter rules for a connected agent: what the next version could add, applied in one click. */}
            {agent && agent.id !== "builtin" && proposal && proposal.tools && toolRows(proposal).some((t) => t.rule) && (
              <div className="border-t border-[var(--border)]">
                <div className="flex items-center justify-between gap-3 px-4 pb-1 pt-3">
                  <span className={eyebrow}>proposed</span>
                  <span className="inline-flex items-center gap-4 text-[12.5px]">
                    {applied && <span className="text-[var(--faint)]">{applied}</span>}
                    <button type="button" onClick={() => void applyRules()} disabled={Object.keys(rules).length === 0} className={cn(textButton, "text-[12.5px]")}>
                      apply {Object.keys(rules).length} {Object.keys(rules).length === 1 ? "rule" : "rules"} as the next version
                    </button>
                  </span>
                </div>
                <ul className="divide-y divide-[var(--border)]">
                  {toolRows(proposal)
                    .filter((t) => t.rule)
                    .map((t) => {
                      const on = t.name in rules;
                      return (
                        <li key={t.name} className="flex items-center gap-4 px-4 py-2.5 text-[12.5px]">
                          <span className="code min-w-0 flex-1 truncate text-[var(--fg)]" title={t.description || undefined}>
                            {t.name}
                          </span>
                          <span className="hidden w-[120px] shrink-0 text-[var(--faint)] sm:inline">{TOOL_CLASS_LABEL[t.cls]}</span>
                          <span className={cn("w-[200px] shrink-0 truncate", on ? "text-[var(--muted)]" : "text-[var(--faint)]")}>{ruleLine(t.rule!)}</span>
                          <span className="w-9 shrink-0 text-right">
                            <Switch checked={on} onChange={(v) => setChosen(v ? { ...rules, [t.name]: t.rule! } : Object.fromEntries(Object.entries(rules).filter(([k]) => k !== t.name)))} name={`Apply rule for ${t.name}`} />
                          </span>
                        </li>
                      );
                    })}
                </ul>
              </div>
            )}
            {agent && agent.id !== "builtin" && (
            <div className="border-t border-[var(--border)]">
              <div className="flex items-center justify-between gap-3 px-4 pb-1 pt-3">
                <span className={eyebrow}>live traffic</span>
                <span className="tabular text-[12px] text-[var(--faint)]">{backend ? gatewayLine(gatewayLog) : "no real tools connected"}</span>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 border-b border-[var(--border)] px-4 py-3 text-[12.5px]">
                <div className="min-w-0">
                  <p className="text-[13px] text-[var(--fg)]">Real tools</p>
                  <p className="mt-0.5 text-[12px] text-[var(--faint)]">
                    Where <span className="code">POST /tools/&#123;name&#125;</span> goes during an attack, and what the gateway sits in front of. Empty = the {worldLine(agent.domain)} stands in.
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <input className={cn(textInput, "code h-9 w-[260px] rounded-lg px-3 text-[13px]")} value={backendDraft ?? agent.tools_backend ?? ""} onChange={(e) => setBackendDraft(e.target.value)} placeholder="http://127.0.0.1:8791" spellCheck={false} aria-label="Tools backend URL" />
                  {backendDraft !== null && backendDraft.trim() !== (agent.tools_backend ?? "") && (
                    <button type="button" onClick={() => void saveBackend()} className={quiet}>
                      save
                    </button>
                  )}
                </div>
              </div>
              {!backend ? (
                <PanelEmpty>No gateway in front of this agent yet. Point it at its real tools above; the gateway that fronts them logs here.</PanelEmpty>
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
            </div>
          )}
          </Panel>
          <Panel
            title="What every run found"
            className="min-h-[280px] xl:min-h-0"
            bodyClassName="min-h-0 overflow-y-auto"
            aside={
              agentRuns && findings ? (
                <>
                  <span className="tabular">{findingsLine(agentRuns, findings)}</span>
                  {agentRuns.length > 0 && (
                    <a {...linkProps(RUNS)} className="rounded transition-colors hover:text-[var(--fg)]">
                      all runs →
                    </a>
                  )}
                </>
              ) : undefined
            }
          >
            {agentRuns === null || findings === null ? (
              <PanelEmpty>…</PanelEmpty>
            ) : agentRuns.length === 0 ? (
              <PanelEmpty>This agent has never been attacked. Press Heal.</PanelEmpty>
            ) : findings.length === 0 ? (
              <PanelEmpty>
                Tested {agentRuns.length === 1 ? "once" : `${agentRuns.length} times`}, but no run measured its attacks against every version. Heal again to get a fix you can approve.
              </PanelEmpty>
            ) : (
              <ul className="divide-y divide-[var(--border)]">
                {findings.map((f) => {
                  // The bar is the run's whole suite: what the shown fix blocks — or, with no fix, what the baseline
                  // already blocked — then what still gets through.
                  const blocks = f.fix ? f.fix.wouldBlock : f.suite - f.gotThrough;
                  return (
                    <li key={f.runId} className="flex flex-col gap-2 px-4 py-3">
                      <div className="flex items-center gap-4 text-[13px]">
                        <a {...linkProps({ kind: "run", id: f.runId })} className="group flex min-w-0 flex-1 items-baseline gap-4 rounded">
                          <span className="tabular w-[124px] shrink-0 text-[var(--muted)] transition-colors group-hover:text-[var(--fg)]">{f.at ? fmtDate(f.at) : f.live ? "current" : "—"}</span>
                          <span className="tabular font-medium text-[var(--fg)]">
                            {f.gotThrough} of {f.suite} got through
                          </span>
                          {f.fix && (
                            <span className="truncate text-[var(--muted)]">
                              {f.fix.name} {f.fix.approved ? "blocks" : "would block"} {f.fix.wouldBlock}
                            </span>
                          )}
                        </a>
                        {f.status === "pending" && f.fix ? (
                          <a {...linkProps(reviewVersion(f.runId, f.fix.version))} className="group shrink-0 rounded text-[12.5px] text-[var(--fg)]">
                            <span className="u-line">pending →</span>
                          </a>
                        ) : (
                          <span className={cn("shrink-0 text-[12.5px]", f.status === "approved" ? "text-[var(--fg)]" : "text-[var(--faint)]")}>{findingStatusLabel(f)}</span>
                        )}
                      </div>
                      <PartitionBar segments={[{ num: blocks, label: !f.fix || f.fix.approved ? "blocked" : "would block" }, { num: f.suite - blocks, tone: "faint", label: "still gets through" }]} className="max-w-[420px]" />
                    </li>
                  );
                })}
              </ul>
            )}
          </Panel>
          </div>

        </div>
      )}
      {importing && (
        <ImportIncidentDialog
          onClose={() => setImporting(false)}
          onImported={(s, created) => setImported(created ? `${s.title} added to the suite` : `${s.title} was already in the suite`)}
        />
      )}
    </Page>
  );
}
