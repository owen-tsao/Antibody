import { useRef, useState } from "react";

import { api, type Agent, type Schedule, type ScheduleBody, type ScheduleSettings, type ScheduleTrigger } from "@/api";
import RunSettingsFields, { Row, Select } from "@/components/RunSettingsFields";
import { useModal } from "@/hooks/useModal";
import { scheduleLine } from "@/lib/derive";
import { DEFAULT_SETTINGS, type RunSettings, toStartBody } from "@/lib/settings";
import { eyebrow, primaryButton, textButton, textInput } from "@/lib/ui";
import { cn } from "@/lib/utils";

/** The interval choices; minutes, the API's unit (15 min … 7 days). */
const INTERVALS: { value: number; label: string }[] = [
  { value: 60, label: "every hour" },
  { value: 360, label: "every 6 h" },
  { value: 720, label: "every 12 h" },
  { value: 1440, label: "every day" },
  { value: 10080, label: "every week" },
];

/** A schedule's settings as the run-settings fields edit them (target and resume are not the schedule's to set). */
function toRunSettings(s: Schedule["settings"]): RunSettings {
  return {
    ...DEFAULT_SETTINGS,
    seeds: s.seeds,
    chaosCycles: s.chaos_cycles,
    repairAttempts: s.repair_attempts,
    secondPass: s.second_pass,
    untilQuiet: s.until_quiet,
    world: s.world,
    vulnerability: s.vulnerability,
  };
}

/**
 * Create or edit a schedule (docs/plans/09-roadmap-v1.md §6): a name, the agent, when it fires, and the same run
 * settings the Heal drawer has. `on_change` is offered only for connected agents — the built-in one never changes.
 * A dialog: opened from the Schedules page's action and from every node on its orbit. For an existing schedule the
 * footer also carries run now / pause / delete (`onRun` / `onToggle` / `onDelete`), so the node is the one place to
 * do anything to it; delete asks twice.
 */
export default function ScheduleDialog({
  agents,
  existing,
  seedCount,
  defaults,
  onClose,
  onSaved,
  onRun,
  onToggle,
  onDelete,
}: {
  agents: Agent[];
  existing: Schedule | null;
  seedCount: number | null;
  /** The person's run defaults (Settings → Run defaults) seed a new schedule. */
  defaults: RunSettings;
  onClose: () => void;
  onSaved: (s: Schedule) => void;
  onRun?: () => Promise<unknown>;
  onToggle?: (enabled: boolean) => Promise<unknown>;
  onDelete?: () => Promise<unknown>;
}) {
  const panel = useRef<HTMLDivElement>(null);
  useModal(panel, onClose);
  const [name, setName] = useState(existing?.name ?? "");
  const [agent, setAgent] = useState(existing?.agent ?? defaults.target ?? agents[0]?.id ?? "builtin");
  const [trigger, setTrigger] = useState<ScheduleTrigger>(existing?.trigger ?? { kind: "interval", every_minutes: 1440 });
  const [settings, setSettings] = useState<RunSettings>(existing ? toRunSettings(existing.settings) : defaults);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const chosen = agents.find((a) => a.id === agent);
  const canWatch = !!chosen?.url;
  const when = trigger.kind === "on_change" ? "on_change" : String(trigger.every_minutes);

  const submit = async () => {
    setBusy(true);
    setError(null);
    // `domain` is stripped too: a schedule runs in its agent's own pack (api/schedules.py `ScheduleSettings`).
    const { target: _t, resume: _r, domain: _d, ...rest } = toStartBody(settings);
    const body: ScheduleBody = { name: name.trim(), agent, trigger, settings: rest as ScheduleSettings, enabled: existing?.enabled ?? true };
    try {
      onSaved(existing ? await api.scheduleUpdate(existing.id, body) : await api.scheduleCreate(body));
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  // The footer actions act on the stored schedule, not the draft; the page refreshes and this dialog stays open
  // (delete closes it) so the person sees the result line change.
  const run = async (fn: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      if (done) setNote(done);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-6">
      <div className="absolute inset-0 bg-[var(--scrim)]" onClick={onClose} aria-hidden />
      <div ref={panel} role="dialog" aria-modal="true" aria-labelledby="schedule-title" tabIndex={-1} className="relative flex max-h-full w-full max-w-[560px] flex-col rounded-2xl border border-[var(--frame)] bg-[var(--card)] outline-none">
        <header className="flex shrink-0 flex-col gap-3 border-b border-[var(--border)] px-5 pb-4 pt-4">
          <div className={cn(eyebrow, "flex items-center justify-between")}>
            <h2 id="schedule-title">{existing ? "Schedule" : "New schedule"}</h2>
            {existing && <span className="tabular normal-case tracking-normal">{scheduleLine(existing)}</span>}
          </div>
          <input
            className={cn(textInput, "h-12 rounded-xl text-[17px] font-medium tracking-[-0.01em] placeholder:font-normal")}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Name it — nightly sweep, release check…"
            maxLength={80}
            aria-label="Name"
            autoFocus
          />
        </header>
        <div className="flex min-h-0 flex-col gap-4 overflow-y-auto px-5 py-4">
          <div className="divide-y divide-[var(--border)] rounded-xl border border-[var(--border)]">
            <Row label="Agent" hint="Which agent this attacks.">
              <Select
                value={agent}
                onChange={(v) => {
                  setAgent(v);
                  if (!agents.find((a) => a.id === v)?.url && trigger.kind === "on_change") setTrigger({ kind: "interval", every_minutes: 1440 });
                }}
                options={agents.map((a) => ({ value: a.id, label: a.name }))}
                name="Agent"
                panelWidth={240}
              />
            </Row>
            <Row label="When" hint={canWatch ? "On a clock, or whenever the agent's tools or version change." : "On a clock. The built-in agent never changes, so it cannot be watched."}>
              <Select
                value={when}
                onChange={(v) => setTrigger(v === "on_change" ? { kind: "on_change" } : { kind: "interval", every_minutes: Number(v) })}
                options={[...INTERVALS.map((i) => ({ value: String(i.value), label: i.label })), ...(canWatch ? [{ value: "on_change", label: "when the agent changes" }] : [])]}
                name="When"
                panelWidth={220}
              />
            </Row>
          </div>
          <RunSettingsFields settings={settings} onChange={setSettings} seedCount={seedCount} />
          {(error || note) && (
            <p role={error ? "alert" : undefined} className={cn("text-[12px]", error ? "text-[var(--danger)]" : "text-[var(--muted)]")}>
              {error ?? note}
            </p>
          )}
        </div>
        <footer className="flex shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-[var(--border)] px-5 py-3">
          <span className="flex items-center gap-4 text-[13px]">
            {existing && onRun && (
              <button type="button" onClick={() => void run(onRun, "started — see Current run")} disabled={busy || !existing.agent_name} className={textButton}>
                Run now
              </button>
            )}
            {existing && onToggle && (
              <button type="button" onClick={() => void run(() => onToggle(!existing.enabled), existing.enabled ? "paused" : "resumed")} disabled={busy} className={textButton}>
                {existing.enabled ? "Pause" : "Resume"}
              </button>
            )}
            {existing && onDelete && (
              <button
                type="button"
                onClick={() => {
                  if (!confirmDelete) {
                    setConfirmDelete(true);
                    return;
                  }
                  void run(onDelete).then(onClose);
                }}
                onBlur={() => setConfirmDelete(false)}
                disabled={busy}
                className={cn(textButton, confirmDelete && "text-[var(--danger)] hover:text-[var(--danger)]")}
              >
                {confirmDelete ? "Delete for good?" : "Delete"}
              </button>
            )}
          </span>
          <span className="flex items-center gap-4">
            <button type="button" onClick={onClose} className={textButton}>
              Cancel
            </button>
            <button type="button" onClick={() => void submit()} disabled={busy || !name.trim() || agents.length === 0} className={primaryButton}>
              {busy ? "Working…" : existing ? "Save" : "Create"}
            </button>
          </span>
        </footer>
      </div>
    </div>
  );
}
