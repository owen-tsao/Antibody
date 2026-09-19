import { motion, useReducedMotion } from "framer-motion";
import { Check, Copy, Globe, Server, Sparkles } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { api, ApiError, type PingResult, type ToolMapping } from "@/api";
import RunSettingsFields from "@/components/RunSettingsFields";
import WizardRail from "@/components/WizardRail";
import { usePoll } from "@/hooks/usePoll";
import { mappingLine, mappingRows, pingResultLine, sameUrl, seedCount } from "@/lib/derive";
import { HOME, href, LIVE_RUN, linkProps, navigate, onboarding, type OnboardingStep, replace, skipOnboarding } from "@/lib/routes";
import { estimateLabel, toStartBody, type RunSettings } from "@/lib/settings";
import { NO_KEY_LINE, primaryButton, textButton } from "@/lib/ui";
import { cn } from "@/lib/utils";

/**
 * `/app/onboarding/:step` (docs/plans/00-overview.md Block 3.4): the connect-and-heal path with no terminal,
 * full-screen like the landing page. Choose → Connect → Tools → First run, the step rail on top, "Skip for
 * now" top-right. Wizard state lives here for the session: the component stays mounted across steps (the
 * route only changes `step`), and a refresh starts over at step 1 — a step that needs state it no longer
 * has sends the person back there.
 *
 * Ping on the Connect step is `POST /api/agents/ping {url}`: nothing is stored until Save, so a typo or a
 * dead address never leaves an agent row behind. Save then stores the row (`POST /api/agents`; a 409 means
 * that URL is already connected under some name, and that row is used). The example agent is started here
 * too, its log's last line shown while its venv syncs.
 */

const STEPS = [
  { id: "choose", label: "Choose" },
  { id: "connect", label: "Connect" },
  { id: "tools", label: "Tools" },
  { id: "run", label: "First run" },
] as const;

const REPO = "https://github.com/owen-tsao/Antibody/blob/main";
const EXAMPLE_README = `${REPO}/examples/agents/openai_agents_support/README.md`;

/** What an agent must speak, in 20 lines. Mirrors examples/agents/openai_agents_support/README.md. */
const CONTRACT = `# Antibody deploys your support agent into a sandbox storefront and
# talks to it over HTTP. Your agent needs one route, and may offer a second.

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

# Storefront tools: lookup_order, issue_refund, send_email, read_ticket, set_ticket_status`;

// Polling while the example agent boots: the row's `running` flips when 8790 answers; the log shows progress.
const EXAMPLE_POLL_MS = 3_000;
const EXAMPLE_TIMEOUT_MS = 180_000;
// Whether a key is set is static for the API's lifetime; the manifest is too.
const STATIC_MS = 60_000;

type Choice = "builtin" | "example" | "own";

interface Chosen {
  id: string;
  name: string;
  url: string | null;
  mapping: ToolMapping | null;
}

const input =
  "h-9 w-full rounded-lg border border-[var(--border)] bg-[var(--inset)] px-3 text-[13px] text-[var(--fg)] outline-none transition-colors placeholder:text-[var(--faint)] focus:border-[var(--border-2)]";

/** Rail tiles the chosen path never visits (zero-based): Demo goes straight to First run, Example skips Connect. */
function skippedSteps(chosen: Chosen | null): number[] {
  if (chosen?.id === "builtin") return [1, 2];
  if (chosen?.id === "example") return [1];
  return [];
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
  const reduced = useReducedMotion();
  const { data: health } = usePoll(api.health, STATIC_MS);
  const { data: manifest } = usePoll(api.manifest, STATIC_MS);
  const [furthest, setFurthest] = useState<OnboardingStep>(step);
  const [choice, setChoice] = useState<Choice | null>(step === 2 ? "own" : null);
  const [chosen, setChosen] = useState<Chosen | null>(null);
  // Derived during render, not in an effect: `furthest` follows the step reached, except when the step
  // reached is one the session cannot show (below), which resets it.
  const needsAgent = (step === 3 || step === 4) && chosen === null;
  if (needsAgent && furthest !== 1) setFurthest(1);
  else if (!needsAgent && step > furthest) setFurthest(step);

  // Step 1: the example agent's boot.
  const [exampleNote, setExampleNote] = useState<string | null>(null);
  const [exampleBusy, setExampleBusy] = useState(false);
  const [logLine, setLogLine] = useState<string | null>(null);

  // Step 2: the form. `ping` remembers which URL the result was for, so Save needs a fresh ping after an edit.
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [pinging, setPinging] = useState(false);
  const [ping, setPing] = useState<{ result: PingResult; url: string } | null>(null);
  const [connectNote, setConnectNote] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Step 4.
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

  const chooseDemo = async () => {
    // The built-in agent's ping is instant and lists the storefront's own tools.
    const r = await api.agentPing("builtin").catch(() => null);
    setChosen({ id: "builtin", name: "Demo agent (built in)", url: null, mapping: r?.mapping ?? null });
    go(4);
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
      setChosen({ id: "example", name: row.name, url: row.url, mapping: r.mapping });
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
    const want = { name: name.trim(), url: ping.url };
    setSaving(true);
    setConnectNote(null);
    try {
      let row: { id: string; name: string; url: string | null };
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
      setChosen({ id: row.id, name: row.name, url: row.url, mapping: ping.result.mapping });
      go(3);
    } catch (e) {
      if (alive.current) setConnectNote(e instanceof Error ? e.message : String(e));
    } finally {
      if (alive.current) setSaving(false);
    }
  };

  const noKey = health !== null && !health.has_api_key;
  const seeds = seedCount(manifest);
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

  const eyebrow = `Step ${step} of ${STEPS.length} · ${STEPS[step - 1].label}`;

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
          href={href(HOME)}
          onClick={(e) => {
            skipOnboarding();
            linkProps(HOME).onClick(e);
          }}
          className="group justify-self-end rounded text-[12px] text-[var(--muted)] transition-colors hover:text-[var(--fg)]"
        >
          <span className="u-line">Skip for now</span>
        </a>
      </header>

      <motion.main key={step} {...fade} className="mx-auto flex w-full max-w-[640px] flex-1 flex-col justify-center py-12">
        <p className="text-center text-[10.5px] font-medium uppercase tracking-[0.08em] text-[var(--faint)]">{eyebrow}</p>

        {step === 1 && (
          <>
            <Title sub="Antibody deploys it into a sandbox storefront and attacks it there. Pick one to start with.">Which support agent should Antibody attack?</Title>
            <div className="mt-10 grid gap-3 sm:grid-cols-3">
              <ChoiceCard icon={Sparkles} title="Demo agent" body="Built in. See a full heal in minutes with nothing to set up." selected={choice === "builtin"} onSelect={() => setChoice("builtin")} disabled={exampleBusy} />
              <ChoiceCard
                icon={Server}
                title="Example agent"
                body="An OpenAI Agents SDK agent we start for you on this machine."
                selected={choice === "example"}
                onSelect={() => setChoice("example")}
                disabled={exampleBusy || noKey}
                reason={noKey ? `${NO_KEY_LINE}; the example agent calls inference` : undefined}
              />
              <ChoiceCard icon={Globe} title="Your own" body="Any agent that answers POST /episode over HTTP." selected={choice === "own"} onSelect={() => setChoice("own")} disabled={exampleBusy} />
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
              <button type="button" onClick={continueFrom1} disabled={!choice || exampleBusy} className={primaryButton}>
                {exampleBusy ? "Starting…" : "Continue"}
              </button>
            </Footer>
          </>
        )}

        {step === 2 && (
          <>
            <Title sub="Give Antibody the address your agent answers on. Ping it first; Save once it replies.">Connect your support agent</Title>
            <div className="mt-10 grid gap-3">
              <label className="grid gap-1.5 text-[12px] text-[var(--muted)]">
                Name
                <input className={input} value={name} onChange={(e) => setName(e.target.value)} placeholder="Northwind support" autoComplete="off" />
              </label>
              <label className="grid gap-1.5 text-[12px] text-[var(--muted)]">
                URL
                <input className={cn(input, "code")} value={url} onChange={(e) => setUrl(e.target.value)} placeholder="http://127.0.0.1:8790" autoComplete="off" spellCheck={false} />
              </label>
            </div>
            <div className="mt-4 flex items-baseline gap-4">
              <button type="button" onClick={() => void doPing()} disabled={pinging || !url.trim()} className={textButton}>
                <span className="u-line">{pinging ? "pinging…" : "Ping"}</span>
              </button>
              {ping && (
                <span role={ping.result.ok ? undefined : "alert"} className={cn("text-[13px]", ping.result.ok ? "text-[var(--muted)]" : "text-[var(--danger)]")}>
                  {pingResultLine(ping.result)}
                </span>
              )}
              {connectNote && (
                <span role="alert" className="text-[13px] text-[var(--danger)]">
                  {connectNote}
                </span>
              )}
            </div>
            <Contract />
            <Footer onBack={() => go(1)}>
              <button
                type="button"
                onClick={() => void save()}
                disabled={!canSave}
                title={canSave ? undefined : !name.trim() ? "name the agent first" : "ping the agent first"}
                className={primaryButton}
              >
                {saving ? "Saving…" : "Save"}
              </button>
            </Footer>
          </>
        )}

        {step === 3 && chosen && (
          <>
            <Title sub={mappingLine(chosen.mapping)}>Which of its tools the sandbox serves</Title>
            {chosen.mapping && chosen.mapping.known.length + chosen.mapping.unknown.length > 0 && (
              <ul className="mt-10 divide-y divide-[var(--border)] border-y border-[var(--border)] text-[13px]">
                {mappingRows(chosen.mapping).map(({ name: n, served }) => (
                  <li key={n} className="flex items-baseline justify-between py-2.5">
                    <span className="code">{n}</span>
                    <span className={served ? "text-[var(--muted)]" : "text-[var(--faint)]"}>{served ? "sandbox storefront" : "unavailable during attacks"}</span>
                  </li>
                ))}
              </ul>
            )}
            <Footer onBack={() => go(choice === "own" ? 2 : 1)}>
              <button type="button" onClick={() => go(4)} className={primaryButton}>
                Continue
              </button>
            </Footer>
          </>
        )}

        {step === 4 && chosen && (
          <>
            <Title sub="Every attack runs in the sandbox storefront; a patch only ships if it fixes the failure and breaks nothing that worked.">Your first run</Title>
            <p className="mt-10 flex items-baseline justify-between border-b border-[var(--border)] pb-3 text-[13px]">
              <span className="text-[var(--faint)]">Agent</span>
              <span>
                {chosen.name}
                {chosen.url && <span className="code ml-2 text-[12px] text-[var(--faint)]">{chosen.url}</span>}
              </span>
            </p>
            <RunSettingsFields settings={settings} onChange={onSettingsChange} seedCount={seeds} />
            <p className="tabular mt-3 text-[12px] text-[var(--faint)]">{estimateLabel(settings, seeds)}</p>
            {healNote && (
              <p role="alert" className="mt-3 text-[12px] text-[var(--danger)]">
                could not start: {healNote}
              </p>
            )}
            <Footer onBack={() => go(skippedSteps(chosen).includes(2) ? 1 : 3)}>
              <button
                type="button"
                onClick={() => void heal()}
                disabled={healing || noKey}
                title={noKey ? NO_KEY_LINE : undefined}
                className={primaryButton}
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
      <h1 className="display mt-3 text-center text-[48px] leading-[1]">{children}</h1>
      <p className="mx-auto mt-4 max-w-[52ch] text-center text-[13px] leading-[1.6] text-[var(--muted)]">{sub}</p>
    </>
  );
}

function Footer({ onBack, children }: { onBack?: () => void; children: React.ReactNode }) {
  return (
    <div className="mt-10 flex items-center justify-between">
      {onBack ? (
        <button type="button" onClick={onBack} className={textButton}>
          <span className="u-line">← Back</span>
        </button>
      ) : (
        <span />
      )}
      {children}
    </div>
  );
}

/** The choice-card pattern from the Clad onboarding: icon, title, one-line body, a check when selected. */
function ChoiceCard({
  icon: Icon,
  title,
  body,
  selected,
  onSelect,
  disabled,
  reason,
}: {
  icon: typeof Globe;
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
        "relative flex flex-col items-stretch rounded-xl border bg-[var(--card)] p-4 text-left transition-colors disabled:cursor-default",
        selected ? "border-[var(--fg)]" : "border-[var(--border)] hover:border-[var(--border-2)]",
        disabled && !selected && "opacity-50 hover:border-[var(--border)]",
      )}
    >
      <span className="flex items-start justify-between">
        <span className="grid h-7 w-7 place-items-center rounded-md border border-[var(--border)] text-[var(--muted)]">
          <Icon className="h-[15px] w-[15px]" strokeWidth={1.75} aria-hidden />
        </span>
        <span
          aria-hidden
          className={cn(
            "grid h-4 w-4 place-items-center rounded-full border transition-colors",
            selected ? "border-[var(--fg)] bg-[var(--fg)] text-[var(--bg)]" : "border-[var(--border-2)]",
          )}
        >
          {selected && <Check className="h-2.5 w-2.5" strokeWidth={3} />}
        </span>
      </span>
      <span className="mt-4 block text-[13px] font-medium">{title}</span>
      <span className="mt-1 block text-[12px] leading-[1.5] text-[var(--muted)]">{body}</span>
    </button>
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
    <details className="group/details mt-8 text-[13px]">
      <summary className="cursor-pointer list-none text-[var(--muted)] transition-colors hover:text-[var(--fg)]">
        <span className="u-line">What your agent needs to answer</span>
        <span className="ml-2 text-[var(--faint)]">20 lines</span>
      </summary>
      <div className="mt-3 rounded-lg border border-[var(--border)] bg-[var(--card)]">
        <div className="flex items-center justify-between border-b border-[var(--border)] px-3 py-2 text-[12px] text-[var(--faint)]">
          <a href={EXAMPLE_README} target="_blank" rel="noreferrer" className="group rounded transition-colors hover:text-[var(--muted)]">
            <span className="u-line">the example agent's README ↗</span>
          </a>
          <button type="button" onClick={() => void copy()} className="group inline-flex items-center gap-1.5 rounded transition-colors hover:text-[var(--muted)]">
            <Copy className="h-3 w-3" strokeWidth={1.75} aria-hidden />
            <span className="u-line">{copied ? "copied" : "copy"}</span>
          </button>
        </div>
        <pre className="code overflow-x-auto px-3 py-3 text-[11.5px] leading-[1.6] text-[var(--muted)]">{CONTRACT}</pre>
      </div>
    </details>
  );
}
