import { motion } from "framer-motion";
import { CaretDown, Check, Copy, Plugs } from "@phosphor-icons/react";
import { useCallback, useEffect, useRef, useState } from "react";

import { api, ApiError, type Agent, type PingResult } from "@/api";
import AgentTile from "@/components/AgentTile";
import RunSettingsFields, { Row, Select } from "@/components/RunSettingsFields";
import WizardRail from "@/components/WizardRail";
import { usePoll } from "@/hooks/usePoll";
import { useMotionPref } from "@/hooks/useMotionPref";
import {
  domainFallback,
  domainHint,
  domainOptions,
  pingResultLine,
  refusedUntilCleared,
  ruleLine,
  sameUrl,
  seedCount,
  SMOKE_CYCLES,
  smokeBody,
  smokeCycles,
  smokeDone,
  smokeEmptyLine,
  smokeFinding,
  smokeLine,
  TOOL_CLASS_LABEL,
  toolRows,
  toolsLine,
  worldLine,
} from "@/lib/derive";
import { AGENTS, HOME, href, LIVE_RUN, linkProps, navigate, onboarding, type OnboardingStep, replace, skipOnboarding } from "@/lib/routes";
import { estimateLabel, toStartBody, type RunSettings } from "@/lib/settings";
import { eyebrow, fieldLabel, NO_KEY_LINE, outlineButton, primaryButton, textButton, textInput } from "@/lib/ui";
import { cn } from "@/lib/utils";

/**
 * `/app/onboarding/:step` (docs/plans/00-overview.md Block 3.4, plan 10 A5): the connect-and-heal path with no
 * terminal, full-screen like the landing page. Choose → Connect → Tools → Smoke test → First run, the step rail
 * on top, "Skip for now" top-right. Wizard state lives here for the session: the component stays mounted across
 * steps (the route only changes `step`), and a refresh starts over at step 1 — a step that needs state it no
 * longer has sends the person back there.
 *
 * Ping on the Connect step is `POST /api/agents/ping {url}`: nothing is stored until Save, so a typo or a
 * dead address never leaves an agent row behind. Save then stores the row (`POST /api/agents`; a 409 means
 * that URL is already connected under some name, and that row is used). The example agent is started here
 * too, its log's last line shown while its venv syncs.
 *
 * Tools points a stored agent at its real tools (`PATCH /api/agents/{id}` `tools_backend`) and offers the starter
 * rules the API proposes per tool (`GET …/tools`, `POST …/tools/apply`). Smoke test runs three invented attacks
 * and names the first that landed, so the person sees what Antibody finds before they commit to a full run.
 */

const STEPS = [
  { id: "choose", label: "Choose" },
  { id: "connect", label: "Connect" },
  { id: "tools", label: "Tools" },
  { id: "smoke", label: "Smoke test" },
  { id: "run", label: "First run" },
] as const;

const REPO = "https://github.com/owen-tsao/Antibody/blob/main";
const EXAMPLE_README = `${REPO}/examples/agents/openai_agents_support/README.md`;

/** What an agent must speak, in 20 lines. Mirrors examples/agents/openai_agents_support/README.md. */
const CONTRACT = `# Antibody deploys your support agent into a sandbox world (a domain pack)
# and talks to it over HTTP. Your agent needs one route, and may offer a second.

POST /episode
  in:  { "session_id": "…", "message": "<the customer's opening turn>",
         "customer_id": "cust_…", "customer_email": "…@…",
         "tools_url": "http://127.0.0.1:8765" }
  out: 200 { "reply": "<your agent's final message>" }        # within 120 s

# Every tool call goes to the sandbox, not your integrations:
POST {tools_url}/tools/{name}          # body: the arguments as JSON
  header X-Antibody-Session: <session_id>
  → the tool result; {"error": "…"} when a policy blocked the call
     (show it to the model as ordinary tool output)

# Optional — lets Antibody say which of your tools the sandbox serves:
GET /tools
  → [ { "name": "lookup_order", "description": "…" }, … ]

# Sandbox tools, retail pack: lookup_order, issue_refund, send_email
# (read_ticket / set_ticket_status appear only when a run is on a ticket world;
#  the airline pack serves its own; GET /api/domains lists every pack)`;

// Polling while the example agent boots: the row's `running` flips when 8790 answers; the log shows progress.
const EXAMPLE_POLL_MS = 3_000;
const EXAMPLE_TIMEOUT_MS = 180_000;
// Whether a key is set is static for the API's lifetime; the manifest is too.
const STATIC_MS = 60_000;
// While the smoke test runs, the loop state and the live cycles are polled at this cadence.
const SMOKE_POLL_MS = 2_000;

// The wizard's one action per step, full width and taller than the app's buttons: it is the only control on the screen.
const wizardPrimary = cn(primaryButton, "h-12 w-full justify-center rounded-xl text-[14px]");

/** The live cycles, or null while the run has none yet (404 before the first cycle lands). */
const liveCycles = () => api.cycles("live").catch(() => null);

type Choice = "builtin" | "example" | "own";

interface Chosen {
  id: string;
  name: string;
  url: string | null;
  /** The row's domain pack; null = the API's default. */
  domain: string | null;
}

/** Rail tiles the chosen path never visits (zero-based): Demo goes straight to First run, Example skips Connect. */
function skippedSteps(chosen: Chosen | null): number[] {
  if (chosen?.id === "builtin") return [1, 2, 3];
  if (chosen?.id === "example") return [1];
  return [];
}

/** The built-in rows cannot be pointed at other tools (`PATCH /api/agents/{id}` is 404 for them); a stored agent can. */
function isStored(chosen: Chosen | null): boolean {
  return chosen !== null && chosen.id !== "builtin" && chosen.id !== "example";
}

export default function Onboarding({
  step,
  settings,
  onSettingsChange,
}: {
  step: OnboardingStep;
  settings: RunSettings;
  onSettingsChange: (next: RunSettings) => void;
}) {
  const reduced = useMotionPref();
  const { data: health } = usePoll(api.health, STATIC_MS);
  const { data: manifest } = usePoll(api.manifest, STATIC_MS);
  const { data: domains } = usePoll(api.domains, STATIC_MS);
  const [furthest, setFurthest] = useState<OnboardingStep>(step);
  const [choice, setChoice] = useState<Choice | null>(step === 2 ? "own" : null);
  const [chosen, setChosen] = useState<Chosen | null>(null);
  // Derived during render, not in an effect: `furthest` follows the step reached, except when the step
  // reached is one the session cannot show (below), which resets it.
  const needsAgent = step >= 3 && chosen === null;
  if (needsAgent && furthest !== 1) setFurthest(1);
  else if (!needsAgent && step > furthest) setFurthest(step);

  // Step 1: the example agent's boot.
  const [exampleNote, setExampleNote] = useState<string | null>(null);
  const [exampleBusy, setExampleBusy] = useState(false);
  const [logLine, setLogLine] = useState<string | null>(null);

  // Step 2: the form. `ping` remembers which URL the result was for, so Save needs a fresh ping after an edit.
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  // The pack the agent speaks (`POST /api/agents` `domain`); null = the API's default. Stored on the row, so every later run of it knows.
  const [domain, setDomain] = useState<string | null>(null);
  const [pinging, setPinging] = useState(false);
  const [ping, setPing] = useState<{ result: PingResult; url: string } | null>(null);
  const [connectNote, setConnectNote] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Step 3: the tools URL and the API's proposal for the chosen agent (re-read after the URL is saved).
  const [toolsUrl, setToolsUrl] = useState("");
  const [toolsSaving, setToolsSaving] = useState(false);
  const [toolsNote, setToolsNote] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const [clearing, setClearing] = useState(false);
  const chosenId = chosen?.id ?? null;
  const proposalFn = useCallback(() => (chosenId && chosenId !== "builtin" ? api.agentTools(chosenId) : Promise.resolve(null)), [chosenId]);
  const { data: proposal, error: proposalError, reset: rereadProposal } = usePoll(proposalFn, 0);

  // Step 4: the smoke test — the loop the wizard started, told from any other by its `started_at`.
  const [smoke, setSmoke] = useState<{ startedAt: string } | null>(null);
  const [smokeBusy, setSmokeBusy] = useState(false);
  const [smokeNote, setSmokeNote] = useState<string | null>(null);
  const smokePoll = step === 4 && smoke !== null ? SMOKE_POLL_MS : 0;
  const { data: loop } = usePoll(api.loop, smokePoll);
  const { data: cycles } = usePoll(liveCycles, smokePoll);
  const smokeRows = smokeCycles(cycles, smoke?.startedAt ?? null);
  const smokeOver = smokeDone(loop, smoke?.startedAt ?? null);

  // Step 5.
  const [healing, setHealing] = useState(false);
  const [healNote, setHealNote] = useState<string | null>(null);

  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // A step that needs an agent this session has not chosen (a refresh, a typed address) restarts.
  useEffect(() => {
    if (needsAgent) replace(onboarding(1));
  }, [needsAgent]);

  const go = (to: OnboardingStep) => navigate(onboarding(to));

  const chooseDemo = () => {
    setChosen({ id: "builtin", name: "Demo agent (built in)", url: null, domain: null });
    go(5);
  };

  const chooseExample = async () => {
    setExampleBusy(true);
    setExampleNote(null);
    setLogLine(null);
    try {
      const rows = await api.agents();
      const row = rows.find((a) => a.id === "example");
      if (!row) throw new Error("the example agent is not available on this API");
      // Already `starting` (from the Agents page a moment ago): the port is taken by its own boot, and
      // asking again would 409. Just wait for it.
      if (!row.running && !row.starting) await api.exampleStart();
      if (!row.running) {
        const t0 = Date.now();
        for (;;) {
          await new Promise((r) => setTimeout(r, EXAMPLE_POLL_MS));
          if (!alive.current) return;
          const [again, log] = await Promise.all([api.agents(), api.exampleLog(5).catch(() => null)]);
          const last = log?.lines.filter((l) => l.trim()).at(-1);
          if (last) setLogLine(last);
          if (again.find((a) => a.id === "example")?.running) break;
          if (Date.now() - t0 > EXAMPLE_TIMEOUT_MS) throw new Error("the example agent did not come up within three minutes; see runs/example_agent.log");
        }
      }
      const r = await api.agentPing("example");
      if (!alive.current) return;
      if (!r.ok) throw new Error(`the example agent is up but did not answer the ping: ${r.error}`);
      setChosen({ id: "example", name: row.name, url: row.url, domain: row.domain ?? null });
      go(3);
    } catch (e) {
      // A 409 means 8790 is taken by something that is not the example agent; the API's message says so.
      if (alive.current) setExampleNote(e instanceof Error ? e.message : String(e));
    } finally {
      if (alive.current) setExampleBusy(false);
    }
  };

  const continueFrom1 = () => {
    if (choice === "builtin") void chooseDemo();
    else if (choice === "example") void chooseExample();
    else if (choice === "own") go(2);
  };

  const doPing = async () => {
    const want = url.trim();
    setPinging(true);
    setPing(null);
    setConnectNote(null);
    try {
      const result = await api.agentPingUrl(want);
      if (!alive.current) return;
      setPing({ result, url: want });
    } catch (e) {
      // A 400 is the API refusing the URL itself (not http(s), too long); its message says which.
      if (alive.current) setConnectNote(e instanceof Error ? e.message : String(e));
    } finally {
      if (alive.current) setPinging(false);
    }
  };

  const canSave = !!ping && ping.result.ok && ping.url === url.trim() && !!name.trim() && !saving;
  const save = async () => {
    if (!ping || !ping.result.ok) return;
    const want = { name: name.trim(), url: ping.url, domain };
    setSaving(true);
    setConnectNote(null);
    try {
      let row: Pick<Agent, "id" | "name" | "url" | "domain">;
      try {
        row = await api.agentCreate(want);
      } catch (e) {
        if (!(e instanceof ApiError && e.status === 409)) throw e;
        // Already connected, under some name: use that row rather than refusing. The backend compares
        // canonical targets (scheme, host, port, path); this compares the text typed, so when the two
        // disagree (`localhost` vs `127.0.0.1`) the row is not found and the API's own 409 message shows.
        const existing = (await api.agents()).find((a) => !a.synthetic && a.url !== null && sameUrl(a.url, want.url));
        if (!existing) throw e;
        row = existing;
      }
      if (!alive.current) return;
      // The URL ping above stored nothing; pinging the row records its tool list, which the Tools step proposes rules from.
      await api.agentPing(row.id).catch(() => null);
      if (!alive.current) return;
      setChosen({ id: row.id, name: row.name, url: row.url, domain: row.domain ?? null });
      go(3);
    } catch (e) {
      if (alive.current) setConnectNote(e instanceof Error ? e.message : String(e));
    } finally {
      if (alive.current) setSaving(false);
    }
  };

  const noKey = health !== null && !health.has_api_key;
  const seeds = seedCount(manifest);

  const saveToolsUrl = async () => {
    if (!chosen) return;
    const want = toolsUrl.trim() || null;
    setToolsSaving(true);
    setToolsNote(null);
    try {
      await api.agentPatch(chosen.id, { tools_backend: want });
      if (!alive.current) return;
      rereadProposal();
    } catch (e) {
      // 400 = not an http(s) URL; 409 = a loop is running and the child already has its value.
      if (alive.current) setToolsNote(e instanceof Error ? e.message : String(e));
    } finally {
      if (alive.current) setToolsSaving(false);
    }
  };

  const starterRules = proposal?.starter_rules ?? {};
  const ruleCount = Object.keys(starterRules).length;
  const applyStarterRules = async () => {
    if (!chosen || ruleCount === 0) return;
    setApplying(true);
    setToolsNote(null);
    try {
      await api.agentToolsApply(chosen.id, starterRules);
      if (!alive.current) return;
      go(4);
    } catch (e) {
      // 409 = a loop is running, or the live run belongs to another agent; the API's message says which.
      if (alive.current) setToolsNote(e instanceof Error ? e.message : String(e));
    } finally {
      if (alive.current) setApplying(false);
    }
  };

  // The refusal a Clear resolves: `runs/` holds another agent's run. Archive it (the Current run page's own
  // "clear" — POST /api/runs/archive, files move to history/), then apply again.
  const clearAndApply = async () => {
    setClearing(true);
    setToolsNote(null);
    try {
      await api.runsArchive();
      if (!alive.current) return;
      await applyStarterRules();
    } catch (e) {
      // 409 = a loop started meanwhile; the API's message says so.
      if (alive.current) setToolsNote(e instanceof Error ? e.message : String(e));
    } finally {
      if (alive.current) setClearing(false);
    }
  };

  // The pack the wizard's runs happen in: the drawer's pick, else the agent's own, else the API's default.
  const runDomain = settings.domain ?? chosen?.domain ?? manifest?.domain ?? null;

  const startSmoke = async () => {
    if (!chosen) return;
    setSmokeBusy(true);
    setSmokeNote(null);
    // The choice outlives the wizard, as Heal's does below.
    onSettingsChange({ ...settings, target: chosen.id });
    try {
      const started = await api.loopStart(smokeBody(chosen.id, settings.world, settings.domain));
      if (!alive.current) return;
      setSmoke({ startedAt: started.started_at });
    } catch (e) {
      if (!alive.current) return;
      // 409 = a loop is already running; the smoke test cannot share the live run with it.
      setSmokeNote(e instanceof ApiError && e.status === 409 ? "a run is already in progress — watch it on Current run, or come back when it finishes" : e instanceof Error ? e.message : String(e));
    } finally {
      if (alive.current) setSmokeBusy(false);
    }
  };
  const finding = smokeOver ? smokeFinding(smokeRows) : null;

  const heal = async () => {
    if (!chosen) return;
    setHealing(true);
    setHealNote(null);
    // The choice outlives the wizard: the settings drawer and Heal on /app/runs start against it too.
    const next = { ...settings, target: chosen.id };
    onSettingsChange(next);
    try {
      await api.loopStart(toStartBody(next));
      navigate(LIVE_RUN);
    } catch (e) {
      // 409 = a loop is already running; watching it is the right outcome.
      if (e instanceof ApiError && e.status === 409) navigate(LIVE_RUN);
      else if (alive.current) setHealNote(e instanceof Error ? e.message : String(e));
    } finally {
      if (alive.current) setHealing(false);
    }
  };

  const fade = {
    initial: { opacity: 0, y: reduced ? 0 : 6 },
    animate: { opacity: 1, y: 0 },
    transition: { duration: reduced ? 0 : 0.18, ease: [0.2, 0.65, 0.3, 0.9] as const },
  };

  const stepLine = `Step ${step} of ${STEPS.length} · ${STEPS[step - 1].label}`;

  // The redirect above is on its way; painting an empty step 3 or 4 first would flash.
  if (needsAgent) return null;

  return (
    <div className="flex min-h-screen flex-col px-6 py-4 text-[var(--fg)]">
      <header className="grid grid-cols-[1fr_auto_1fr] items-center">
        <a {...linkProps(HOME)} className="display w-fit rounded text-[20px] leading-none" aria-label="Antibody — home">
          A
        </a>
        <WizardRail
          steps={[...STEPS]}
          index={step - 1}
          furthest={furthest - 1}
          skipped={skippedSteps(chosen)}
          onGoTo={(i) => go((i + 1) as OnboardingStep)}
        />
        <a
          href={href(AGENTS)}
          onClick={(e) => {
            skipOnboarding();
            linkProps(AGENTS).onClick(e);
          }}
          className="justify-self-end rounded text-[12px] text-[var(--muted)] transition-colors hover:text-[var(--fg)]"
        >
          Skip for now
        </a>
      </header>

      <motion.main key={step} {...fade} className="mx-auto flex w-full max-w-[640px] flex-1 flex-col justify-center py-12">
        <p className={cn(eyebrow, "text-center")}>{stepLine}</p>

        {step === 1 && (
          <>
            <Title sub="Antibody deploys it into a sandbox world and attacks it there. Pick one to start with.">Which support agent should Antibody attack?</Title>
            <div className="mt-10 grid gap-3 sm:grid-cols-3">
              <ChoiceCard tile={{ id: "builtin", name: "Demo agent" }} title="Demo agent" body="Built in. See a full heal in minutes with nothing to set up." selected={choice === "builtin"} onSelect={() => setChoice("builtin")} disabled={exampleBusy} />
              <ChoiceCard
                tile={{ id: "example", name: "Example agent" }}
                title="Example agent"
                body="An OpenAI Agents SDK agent we start for you on this machine."
                selected={choice === "example"}
                onSelect={() => setChoice("example")}
                disabled={exampleBusy || noKey}
                reason={noKey ? `${NO_KEY_LINE}; the example agent calls inference` : undefined}
              />
              <ChoiceCard tile="connect" title="Your own" body="Any agent that answers POST /episode over HTTP." selected={choice === "own"} onSelect={() => setChoice("own")} disabled={exampleBusy} />
            </div>
            {(exampleBusy || exampleNote) && (
              <p role={exampleNote ? "alert" : undefined} className={cn("mt-4 text-[12px]", exampleNote ? "text-[var(--danger)]" : "text-[var(--muted)]")}>
                {exampleNote ?? (
                  <>
                    starting the example agent…{logLine && <span className="code ml-2 text-[var(--faint)]">{logLine}</span>}
                  </>
                )}
              </p>
            )}
            <Footer>
              <button type="button" onClick={continueFrom1} disabled={!choice || exampleBusy} className={wizardPrimary}>
                {exampleBusy ? "Starting…" : "Continue"}
              </button>
            </Footer>
          </>
        )}

        {step === 2 && (
          <>
            <Title sub="Give Antibody the address your agent answers on. Ping it first; Save once it replies.">Connect your support agent</Title>
            <div className="mt-10 grid gap-5">
              <label className="grid gap-2">
                <span className={fieldLabel}>Name</span>
                <input className={textInput} value={name} onChange={(e) => setName(e.target.value)} placeholder="Northwind support" autoComplete="off" />
              </label>
              <div className="grid gap-2">
                <label htmlFor="connect-url" className={fieldLabel}>
                  URL
                </label>
                <div className="flex gap-2">
                  <input id="connect-url" className={cn(textInput, "code")} value={url} onChange={(e) => setUrl(e.target.value)} placeholder="http://127.0.0.1:8790" autoComplete="off" spellCheck={false} />
                  <button type="button" onClick={() => void doPing()} disabled={pinging || !url.trim()} className={cn(outlineButton, "w-[92px] shrink-0")}>
                    {pinging ? "Pinging…" : "Ping"}
                  </button>
                </div>
              </div>
              <div className="rounded-xl border border-[var(--border)]">
                <Row label="Domain" hint={domainHint(domains, domain ?? manifest?.domain ?? null) ?? "The world your agent speaks: which tools the sandbox serves it, which attacks it faces."}>
                  <Select value={domain ?? ""} onChange={(v) => setDomain(v || null)} options={domainOptions(domains, domain, domainFallback(null, manifest?.domain).label)} name="Domain" panelWidth={220} />
                </Row>
              </div>
            </div>
            {(ping || connectNote) && (
              <p
                role={ping?.result.ok ? undefined : "alert"}
                className={cn(
                  "mt-4 flex items-center gap-2.5 rounded-xl border px-4 py-3 text-[13px]",
                  ping?.result.ok && !connectNote ? "border-[var(--border)] bg-[var(--card)] text-[var(--muted)]" : "border-[rgba(248,113,113,0.25)] bg-[rgba(248,113,113,0.06)] text-[var(--danger)]",
                )}
              >
                <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", ping?.result.ok && !connectNote ? "bg-[var(--live)]" : "bg-[var(--danger)]")} aria-hidden />
                {connectNote ?? (ping && pingResultLine(ping.result))}
              </p>
            )}
            <Contract />
            <Footer onBack={() => go(1)}>
              <button
                type="button"
                onClick={() => void save()}
                disabled={!canSave}
                title={canSave ? undefined : !name.trim() ? "name the agent first" : "ping the agent first"}
                className={wizardPrimary}
              >
                {saving ? "Saving…" : "Save and continue"}
              </button>
            </Footer>
          </>
        )}

        {step === 3 && chosen && (
          <>
            <Title sub="Antibody puts locks on the drawers your agent opens — refunds, emails, record changes — and never touches your code. Point it at the tools your agent really calls and it proposes a starter rule for each one that acts.">
              Where do your agent's tools live?
            </Title>
            {isStored(chosen) && (
              <div className="mt-10 grid gap-2">
                <label htmlFor="tools-url" className={fieldLabel}>
                  Tools URL
                </label>
                <div className="flex gap-2">
                  <input id="tools-url" className={cn(textInput, "code")} value={toolsUrl} onChange={(e) => setToolsUrl(e.target.value)} placeholder="http://127.0.0.1:9000" autoComplete="off" spellCheck={false} />
                  <button type="button" onClick={() => void saveToolsUrl()} disabled={toolsSaving} className={cn(outlineButton, "w-[92px] shrink-0")}>
                    {toolsSaving ? "Saving…" : "Save"}
                  </button>
                </div>
                <p className="text-[12px] leading-[1.5] text-[var(--faint)]">
                  Where Antibody posts tool calls during attacks (<span className="code">POST {"<url>"}/tools/{"<name>"}</span>). Leave it empty to keep using the {worldLine(runDomain)}'s tools.
                </p>
              </div>
            )}
            <div className="mt-6 overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--card)] text-[13px]">
              <p className="flex items-center justify-between gap-4 border-b border-[var(--border)] px-4 py-3">
                <span className={fieldLabel}>Tools</span>
                <span className="text-[12px] text-[var(--faint)]">{proposalError ? "could not list tools" : toolsLine(proposal)}</span>
              </p>
              {proposalError ? (
                <p className="px-4 py-6 text-center text-[12px] text-[var(--faint)]">Could not read this agent's tools: {proposalError}</p>
              ) : !proposal ? (
                <p className="px-4 py-6 text-center text-[12px] text-[var(--faint)]">…</p>
              ) : !proposal.tools ? (
                <p className="px-4 py-6 text-center text-[12px] leading-[1.6] text-[var(--faint)]">
                  Your agent does not list its tools (no GET /tools), so there is nothing to propose rules for yet.
                  <br />
                  Antibody will attack it against the {worldLine(runDomain)}'s tools; add rules later from the agent's page.
                </p>
              ) : (
                <ul className="divide-y divide-[var(--border)]">
                  {toolRows(proposal).map((t) => (
                    <li key={t.name} className="flex items-center gap-4 px-4 py-2.5 text-[12.5px]">
                      <span className="code min-w-0 flex-1 truncate text-[var(--fg)]" title={t.description || undefined}>
                        {t.name}
                      </span>
                      <span className="w-[120px] shrink-0 text-[var(--faint)]">{TOOL_CLASS_LABEL[t.cls]}</span>
                      <span className={cn("w-[180px] shrink-0 truncate", t.rule ? "text-[var(--muted)]" : "text-[var(--faint)]")}>{t.rule ? ruleLine(t.rule) : "no rule needed"}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            {ruleCount > 0 && (
              <p className="mt-3 text-center text-[12px] leading-[1.6] text-[var(--faint)]">
                A starter rule is a lock on one drawer: a tool that moves money or sends a message runs only when the customer asked for it and after a verified lookup. Saved as a config version for you to review; nothing ships until you approve it.
              </p>
            )}
            {toolsNote && (
              <p role="alert" className="mt-3 text-[12px] text-[var(--danger)]">
                {toolsNote}
              </p>
            )}
            {refusedUntilCleared(toolsNote) && (
              <p className="mt-2 text-[12px] leading-[1.6] text-[var(--faint)]">
                Clearing moves that run's files from <span className="code">runs/</span> to <span className="code">history/</span> — nothing is deleted, and it stays open under Runs.{" "}
                <button type="button" onClick={() => void clearAndApply()} disabled={clearing || applying} className={cn(textButton, "text-[12px]")}>
                  {clearing ? "clearing…" : "Clear it and apply the rules"}
                </button>
              </p>
            )}
            <Footer onBack={() => go(choice === "own" ? 2 : 1)}>
              {ruleCount > 0 ? (
                <>
                  <button type="button" onClick={() => void applyStarterRules()} disabled={applying || clearing} className={wizardPrimary}>
                    {applying ? "Applying…" : `Apply ${ruleCount} starter ${ruleCount === 1 ? "rule" : "rules"} and continue`}
                  </button>
                  <button type="button" onClick={() => go(4)} className={cn(textButton, "self-center text-[12.5px]")}>
                    Continue without rules
                  </button>
                </>
              ) : (
                <button type="button" onClick={() => go(4)} className={wizardPrimary}>
                  Continue
                </button>
              )}
            </Footer>
          </>
        )}

        {step === 4 && chosen && (
          <>
            <Title sub={`Three invented attacks against your agent in the ${worldLine(runDomain)}, before you commit to a full run. Antibody watches what your agent does; it never changes your code.`}>
              Run {SMOKE_CYCLES} quick attacks
            </Title>
            <div className="mt-10 overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--card)] text-[13px]">
              <p className="flex items-center justify-between gap-4 border-b border-[var(--border)] px-4 py-3">
                <span className={fieldLabel}>Agent</span>
                <span className="flex min-w-0 items-baseline gap-2">
                  <span className="truncate text-[var(--fg)]">{chosen.name}</span>
                  {chosen.url && <span className="code truncate text-[12px] text-[var(--faint)]">{chosen.url}</span>}
                </span>
              </p>
              {!smoke ? (
                <p className="px-4 py-6 text-center text-[12px] text-[var(--faint)]">Each attack is a customer conversation the Chaos agent invents to get your agent to do something it should not.</p>
              ) : (
                <ul className="divide-y divide-[var(--border)]">
                  {Array.from({ length: SMOKE_CYCLES }, (_, i) => {
                    const c = smokeRows[i];
                    return (
                      <li key={i} className="flex items-center gap-4 px-4 py-3 text-[12.5px]">
                        <span className="tabular w-[64px] shrink-0 text-[var(--faint)]">attack {i + 1}</span>
                        <span className={cn("min-w-0 flex-1 truncate", c ? "text-[var(--fg)]" : "text-[var(--faint)]")}>{c ? c.scenario.title : smokeOver ? "not run" : i === smokeRows.length ? "running…" : "waiting"}</span>
                        <span className={cn("shrink-0", c?.attack_succeeded ? "text-[var(--danger)]" : "text-[var(--muted)]")}>{c ? smokeLine(c) : ""}</span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
            {smokeOver && (
              <p className="mt-4 text-center text-[13px] text-[var(--fg)]">
                {finding ? (
                  <>
                    Attack {finding.cycle} got through: {finding.title}.{" "}
                    <a {...linkProps({ kind: "cycle", id: "live", n: finding.cycle })} className="group text-[var(--muted)] transition-colors hover:text-[var(--fg)]">
                      <span>see the conversation</span>
                    </a>
                  </>
                ) : smokeRows.length === 0 ? (
                  smokeEmptyLine(loop?.exit_code ?? null)
                ) : (
                  "All three blocked — your agent is holding."
                )}
              </p>
            )}
            {smokeNote && (
              <p role="alert" className="mt-3 text-[12px] text-[var(--danger)]">
                could not start: {smokeNote}
              </p>
            )}
            <Footer onBack={() => go(3)}>
              {!smoke ? (
                <>
                  <button type="button" onClick={() => void startSmoke()} disabled={smokeBusy || noKey} title={noKey ? NO_KEY_LINE : undefined} className={wizardPrimary}>
                    {smokeBusy ? "Starting…" : `Run ${SMOKE_CYCLES} quick attacks`}
                  </button>
                  <button type="button" onClick={() => go(5)} className={cn(textButton, "self-center text-[12.5px]")}>
                    Skip the smoke test
                  </button>
                </>
              ) : (
                <button type="button" onClick={() => go(5)} disabled={!smokeOver} title={smokeOver ? undefined : "the attacks are still running"} className={wizardPrimary}>
                  {smokeOver ? "Done" : `Running… ${smokeRows.length}/${SMOKE_CYCLES}`}
                </button>
              )}
            </Footer>
          </>
        )}

        {step === 5 && chosen && (
          <>
            <Title sub={`Every attack runs in the ${worldLine(runDomain)}; a fix is only kept if it blocks the attack and breaks nothing that worked.`}>Your first run</Title>
            <div className="mt-10 overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--card)]">
              <p className="flex items-center justify-between gap-4 border-b border-[var(--border)] px-4 py-3.5 text-[13px]">
                <span className={fieldLabel}>Agent</span>
                <span className="flex min-w-0 items-baseline gap-2">
                  <span className="truncate text-[var(--fg)]">{chosen.name}</span>
                  {chosen.url && <span className="code truncate text-[12px] text-[var(--faint)]">{chosen.url}</span>}
                </span>
              </p>
              <RunSettingsFields settings={settings} onChange={onSettingsChange} seedCount={seeds} domain={{ domains, fallback: domainFallback(chosen, manifest?.domain) }} framed={false} />
            </div>
            <p className="tabular mt-3 text-center text-[12px] text-[var(--faint)]">{estimateLabel(settings, seeds)}</p>
            {healNote && (
              <p role="alert" className="mt-3 text-[12px] text-[var(--danger)]">
                could not start: {healNote}
              </p>
            )}
            <Footer onBack={() => go(skippedSteps(chosen).includes(3) ? 1 : 4)}>
              <button
                type="button"
                onClick={() => void heal()}
                disabled={healing || noKey}
                title={noKey ? NO_KEY_LINE : undefined}
                className={wizardPrimary}
              >
                {healing ? "Starting…" : "Heal"}
              </button>
            </Footer>
          </>
        )}
      </motion.main>
    </div>
  );
}

function Title({ children, sub }: { children: React.ReactNode; sub: string }) {
  return (
    <>
      <h1 className="mt-3 text-center text-[24px] font-semibold leading-[1.2] tracking-[-0.02em] text-[var(--fg)]">{children}</h1>
      <p className="mx-auto mt-3 max-w-[52ch] text-center text-[13px] leading-[1.6] text-[var(--muted)]">{sub}</p>
    </>
  );
}

function Footer({ onBack, children }: { onBack?: () => void; children: React.ReactNode }) {
  return (
    <div className="mt-10 flex flex-col gap-4">
      {children}
      {onBack && (
        <button type="button" onClick={onBack} className={cn(textButton, "self-center text-[12.5px]")}>
          ← Back
        </button>
      )}
    </div>
  );
}

/** The contract your agent must speak, collapsed by default, with a copy button and the example's README. */
function Contract() {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(CONTRACT);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard blocked (http origin, permissions): the text is on screen to select.
    }
  };
  return (
    <details className="group/details mt-6 overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--card)] text-[13px] open:border-[var(--border-2)]">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-4 py-3.5 text-[var(--fg)] transition-colors hover:bg-[var(--hover)]">
        <span className="flex flex-col gap-0.5">
          <span className="font-medium">What your agent needs to answer</span>
          <span className="text-[12px] text-[var(--faint)]">One route in, tool calls out — 20 lines.</span>
        </span>
        <CaretDown size={14} className="shrink-0 text-[var(--faint)] transition-transform group-open/details:rotate-180" aria-hidden />
      </summary>
      <div className="border-t border-[var(--border)]">
        <div className="flex items-center justify-between bg-[var(--inset)] px-4 py-2 text-[12px] text-[var(--faint)]">
          <a href={EXAMPLE_README} target="_blank" rel="noreferrer" className="group rounded transition-colors hover:text-[var(--fg)]">
            the example agent's README ↗
          </a>
          <button type="button" onClick={() => void copy()} className="group inline-flex items-center gap-1.5 rounded transition-colors hover:text-[var(--fg)]">
            {copied ? <Check size={12} aria-hidden /> : <Copy size={12} aria-hidden />}
            {copied ? "copied" : "copy"}
          </button>
        </div>
        <pre className="code overflow-x-auto px-4 py-4 text-[11.5px] leading-[1.65] text-[var(--muted)]">{CONTRACT}</pre>
      </div>
    </details>
  );
}

/** The choice-card pattern from the Clad onboarding: icon, title, one-line body, a check when selected. */
function ChoiceCard({
  tile,
  title,
  body,
  selected,
  onSelect,
  disabled,
  reason,
}: {
  /** The agent this card stands for, or `connect` for the bring-your-own card. */
  tile: Pick<Agent, "id" | "name"> | "connect";
  title: string;
  body: string;
  selected: boolean;
  onSelect: () => void;
  disabled?: boolean;
  /** Hover text saying why the card is disabled. */
  reason?: string;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      disabled={disabled}
      title={reason}
      className={cn(
        "relative flex flex-col items-stretch rounded-xl border bg-[var(--card)] p-5 text-left transition-colors focus-visible:outline-white disabled:cursor-default",
        selected ? "border-[var(--border-2)] bg-[var(--hover)]" : "border-[var(--border)] hover:border-[var(--border-2)]",
        disabled && !selected && "opacity-50 hover:border-[var(--border)]",
      )}
    >
      <span className="flex items-start justify-between">
        {tile === "connect" ? (
          <span className="grid h-7 w-7 place-items-center rounded-[8px] border border-dashed border-[var(--border-2)] text-[var(--muted)]">
            <Plugs size={15} aria-hidden />
          </span>
        ) : (
          <AgentTile agent={tile} size={28} />
        )}
        <span
          aria-hidden
          className={cn(
            "grid h-4 w-4 place-items-center rounded-full border transition-colors",
            selected ? "border-[var(--fg)] bg-[var(--fg)] text-[var(--bg)]" : "border-[var(--border-2)]",
          )}
        >
          {selected && <Check size={10} weight="bold" aria-hidden />}
        </span>
      </span>
      <span className="mt-4 block text-[13px] font-medium">{title}</span>
      <span className="mt-1 block text-[12px] leading-[1.5] text-[var(--muted)]">{body}</span>
    </button>
  );
}
