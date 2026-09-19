import { motion, useReducedMotion } from "framer-motion";
import { useEffect, useId, useRef, useState } from "react";

import { api, ApiError, type Agent, type Health, type LoopState, type Manifest } from "@/api";
import RunSettingsFields from "@/components/RunSettingsFields";
import { useModal } from "@/hooks/useModal";
import { exampleState, seedCount } from "@/lib/derive";
import { LIVE_RUN, navigate } from "@/lib/routes";
import { DEFAULT_SETTINGS, estimateLabel, isDefaultSettings, toStartBody, type RunSettings } from "@/lib/settings";
import { NO_KEY_LINE, primaryButton, textButton } from "@/lib/ui";
import { cn } from "@/lib/utils";

/**
 * The start dialog (docs/plans/00-overview.md Block 4.2), opened by Heal on Home and Start a run on Runs:
 * pick the agent to attack, shape the run (`RunSettingsFields`, shared with the wizard's First run step),
 * read the estimate, press Heal. Submit is `POST /api/loop/start`; 409 means a loop already runs, and
 * watching it is the right outcome, so both land on `/app/runs/live`. Anything else shows inline.
 *
 * The parent owns the settings (it persists them); this only edits them. Mounted while open, so the agent
 * list and the manifest are fetched per opening — cheap, and the list is what makes the picker honest.
 * `useModal` moves focus in, wraps Tab, closes on Esc, locks the page's scroll and returns focus after.
 */

interface Props {
  settings: RunSettings;
  onChange: (next: RunSettings) => void;
  onClose: () => void;
  /** `has_api_key === false` disables Heal with the reason in its tooltip. */
  health: Health | null;
  /** A loop already alive: Heal just goes to it instead of asking for another. */
  loop: LoopState | null;
  /** Re-poll the shell's routes after a start, so "Current run" lights up without waiting for the next tick. */
  refresh: () => void;
}

export default function StartDialog({ settings, onChange, onClose, health, loop, refresh }: Props) {
  const reduced = useReducedMotion();
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);
  useModal(panel, onClose);

  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [agents, setAgents] = useState<Agent[] | null>(null);
  useEffect(() => {
    let alive = true;
    api
      .manifest()
      .then((m) => alive && setManifest(m))
      .catch(() => alive && setManifest(null));
    api
      .agents()
      .then((a) => alive && setAgents(a))
      .catch(() => alive && setAgents(null));
    return () => {
      alive = false;
    };
  }, []);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const seeds = seedCount(manifest);
  const noKey = health !== null && !health.has_api_key;
  const running = loop?.running ?? false;
  // null means the API's own default, which is the built-in agent; the picker shows it as such and writes
  // the id explicitly on the first choice so the start body always names its agent.
  const selected = settings.target ?? "builtin";

  const heal = async () => {
    if (running) {
      navigate(LIVE_RUN);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.loopStart(toStartBody({ ...settings, target: selected }));
      navigate(LIVE_RUN);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) navigate(LIVE_RUN);
      else setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      refresh();
    }
  };

  const pop = reduced
    ? { initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0 }, transition: { duration: 0 } }
    : {
        initial: { opacity: 0, scale: 0.98, y: 4 },
        animate: { opacity: 1, scale: 1, y: 0 },
        exit: { opacity: 0, scale: 0.98, y: 4 },
        transition: { duration: 0.16, ease: [0.2, 0.65, 0.3, 0.9] as const },
      };

  return (
    <div className="fixed inset-0 z-30 flex items-center justify-center p-4">
      <motion.div
        className="absolute inset-0 bg-[var(--scrim)]"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: reduced ? 0 : 0.12 }}
        onClick={onClose}
        aria-hidden
      />
      <motion.div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        {...pop}
        className="relative flex w-[min(440px,100%)] flex-col rounded-xl border border-[var(--border-2)] bg-[var(--card)] px-6 py-6 text-left text-[var(--fg)] outline-none"
      >
        <header className="flex items-baseline justify-between">
          <h2 id={titleId} className="text-[13px] font-medium">
            Start a run
          </h2>
          <button type="button" onClick={onClose} className={textButton}>
            <span className="u-line">close</span>
          </button>
        </header>

        <p className="mb-2 mt-5 text-[10.5px] font-medium uppercase tracking-[0.08em] text-[var(--faint)]">Agent</p>
        <div role="radiogroup" aria-label="Agent to attack" className="divide-y divide-[var(--border)] border-y border-[var(--border)]">
          {agents === null ? (
            <p className="py-3 text-[12px] text-[var(--faint)]">loading…</p>
          ) : (
            agents.map((a) => {
              // The example agent only answers while its process is up; offering it stopped would start a
              // run whose every episode fails to connect.
              const stopped = a.id === "example" && exampleState(a) !== "running";
              const on = a.id === selected;
              return (
                <button
                  key={a.id}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  disabled={stopped}
                  title={stopped ? "start the example agent from the Agents page first" : undefined}
                  onClick={() => onChange({ ...settings, target: a.id })}
                  className={cn(
                    "flex w-full items-baseline justify-between gap-4 py-2.5 text-left text-[13px] transition-colors disabled:cursor-default",
                    on ? "text-[var(--fg)]" : "text-[var(--muted)] hover:text-[var(--fg)]",
                    stopped && "text-[var(--faint)] hover:text-[var(--faint)]",
                  )}
                >
                  <span className="flex items-baseline gap-2">
                    <span aria-hidden className={cn("inline-block h-1.5 w-1.5 rounded-full", on ? "bg-[var(--fg)]" : "bg-[var(--border-2)]")} />
                    {a.name}
                  </span>
                  <span className="shrink-0 text-[12px] text-[var(--faint)]">
                    {a.id === "builtin" ? "demo agent" : stopped ? "stopped" : a.id === "example" ? "running" : "HTTP"}
                  </span>
                </button>
              );
            })
          )}
        </div>

        <p className="mb-2 mt-5 text-[10.5px] font-medium uppercase tracking-[0.08em] text-[var(--faint)]">Run</p>
        <RunSettingsFields settings={settings} onChange={onChange} seedCount={seeds} />

        <div className="tabular mt-3 flex items-baseline justify-between text-[12px] text-[var(--faint)]">
          <span>{estimateLabel(settings, seeds)}</span>
          {!isDefaultSettings(settings) && (
            <button type="button" onClick={() => onChange({ ...DEFAULT_SETTINGS, target: settings.target })} className={cn(textButton, "text-[12px] text-[var(--faint)]")}>
              <span className="u-line">reset</span>
            </button>
          )}
        </div>

        {error && (
          <p role="alert" className="mt-4 text-[12px] text-[var(--danger)]">
            could not start: {error}
          </p>
        )}

        <div className="mt-6 flex justify-end">
          <button
            type="button"
            onClick={() => void heal()}
            disabled={busy || (noKey && !running)}
            title={noKey && !running ? NO_KEY_LINE : undefined}
            aria-busy={busy || undefined}
            className={primaryButton}
          >
            {running ? "Watch the current run" : busy ? "Starting…" : "Heal"}
          </button>
        </div>
      </motion.div>
    </div>
  );
}
