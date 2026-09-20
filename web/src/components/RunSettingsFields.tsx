import { CaretDown } from "@phosphor-icons/react";
import type { ReactNode } from "react";

import Dropdown from "@/components/Dropdown";

import { CHAOS_CYCLES, REPAIR_ATTEMPTS, SEEDS, UNTIL_QUIET, type RunSettings } from "@/lib/settings";
import { cn } from "@/lib/utils";

/**
 * The run-settings rows — Seeds · Chaos cycles · Repair attempts · Second pass · Until quiet · Vulnerability —
 * shared by the Settings page's run defaults and the onboarding wizard's First run step.
 * The parent owns the values; this only edits them. Every field is a flag `chaos.loop run` already has
 * (lib/settings.ts). Numbers are a `Select` (the app's `Dropdown`) over the allowed values; booleans a switch. `world` left
 * the fields: the API default `auto` resolves to the mock storefront without Zendesk credentials.
 */

export default function RunSettingsFields({
  settings,
  onChange,
  seedCount,
  framed = true,
}: {
  settings: RunSettings;
  onChange: (next: RunSettings) => void;
  /** How many seed scenarios exist (from the manifest); null while unknown, which falls back to the API's cap. */
  seedCount: number | null;
  /** Draw the hairline frame around the rows (off when a panel already frames them). */
  framed?: boolean;
}) {
  // Seeds offers 0 … S−1 then "all" (= S, so no duplicate stop). S is the manifest's count, or the API's cap
  // while the manifest is unknown.
  const seedTop = Math.max(1, seedCount ?? SEEDS.max);
  const set = (patch: Partial<RunSettings>) => onChange({ ...settings, ...patch });

  // The API rejects a streak longer than the cap, so lowering the cap drags the streak down with it.
  const setChaos = (chaosCycles: number) =>
    set({ chaosCycles, untilQuiet: settings.untilQuiet === null ? null : chaosCycles === 0 ? null : Math.min(settings.untilQuiet, chaosCycles) });
  const quietMax = Math.min(UNTIL_QUIET.max, settings.chaosCycles);

  return (
    <div className={cn("divide-y divide-[var(--border)]", framed && "rounded-xl border border-[var(--border)]")}>
      <Row label="Seeds" hint="Scripted attacks the run starts with; the chaos agent invents the rest.">
        <Select
          value={settings.seeds === null ? "all" : String(settings.seeds)}
          onChange={(v) => set({ seeds: v === "all" ? null : Number(v) })}
          options={[...range(SEEDS.min, seedTop - 1).map((n) => ({ value: String(n), label: String(n) })), { value: "all", label: `all (${seedTop})` }]}
          name="Seeds"
        />
      </Row>
      <Row label="Chaos cycles" hint="Attacks the chaos agent invents after the seeds.">
        <Select value={String(settings.chaosCycles)} onChange={(v) => setChaos(Number(v))} options={numbers(CHAOS_CYCLES.min, CHAOS_CYCLES.max)} name="Chaos cycles" />
      </Row>
      <Row label="Repair attempts" hint="How many patches the repair agent may try per landed attack before giving up.">
        <Select value={String(settings.repairAttempts)} onChange={(v) => set({ repairAttempts: Number(v) })} options={numbers(REPAIR_ATTEMPTS.min, REPAIR_ATTEMPTS.max)} name="Repair attempts" />
      </Row>
      <Row label="Second pass" hint="Re-run every attack that landed against the final config.">
        <Switch checked={settings.secondPass} onChange={(on) => set({ secondPass: on })} name="Second pass" />
      </Row>
      <Row label="Until quiet" hint="Stop early once this many chaos attacks in a row are blocked.">
        <div className="flex items-center gap-3">
          {settings.untilQuiet !== null && (
            <Select value={String(settings.untilQuiet)} onChange={(v) => set({ untilQuiet: Number(v) })} options={numbers(UNTIL_QUIET.min, Math.max(UNTIL_QUIET.min, quietMax))} name="Blocked attacks in a row" />
          )}
          <Switch
            checked={settings.untilQuiet !== null}
            disabled={settings.chaosCycles === 0}
            title={settings.chaosCycles === 0 ? "needs at least one chaos cycle" : undefined}
            onChange={(on) => set({ untilQuiet: on ? Math.min(2, quietMax) : null })}
            name="Until quiet"
          />
        </div>
      </Row>
      <Row label="Vulnerability measurement" hint="After the run, measure which known attacks still land on v0 and on the final config.">
        <Switch checked={settings.vulnerability} onChange={(on) => set({ vulnerability: on })} name="Vulnerability measurement" />
      </Row>
    </div>
  );
}

function range(from: number, to: number): number[] {
  return Array.from({ length: Math.max(0, to - from + 1) }, (_, i) => from + i);
}

function numbers(from: number, to: number): { value: string; label: string }[] {
  return range(from, to).map((n) => ({ value: String(n), label: String(n) }));
}

/** A setting row: label and one-line description left, the control right, hairline between rows (the parent's `divide-y`). */
export function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-6 px-4 py-3">
      <div className="min-w-0">
        <div className="text-[13px] text-[var(--fg)]">{label}</div>
        {hint && <div className="mt-0.5 text-[12px] leading-[1.5] text-[var(--faint)]">{hint}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

/** A `Dropdown` in the shape of a compact right-aligned select: the value with a caret, the list beneath. */
export function Select({
  value,
  onChange,
  options,
  name,
  className,
  panelWidth = 160,
}: {
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
  name: string;
  className?: string;
  panelWidth?: number;
}) {
  return (
    <Dropdown
      value={value}
      options={options}
      onChange={onChange}
      label={name}
      align="end"
      panelWidth={panelWidth}
      className={cn("inline-block", className)}
      trigger={({ open, selected }) => (
        <span
          className={cn(
            "tabular inline-flex h-8 min-w-[72px] max-w-[320px] items-center justify-end gap-2 rounded-lg border bg-[var(--bg)] pl-3 pr-2.5 text-[12.5px] text-[var(--fg)] transition-colors",
            open ? "border-[var(--border-2)]" : "border-[var(--border)] hover:border-[var(--border-2)]",
          )}
        >
          <span className="sr-only">{name}: </span>
          <span className="truncate">{selected?.label ?? value}</span>
          <CaretDown size={12} className={cn("shrink-0 text-[var(--faint)] transition-transform", open && "rotate-180")} aria-hidden />
        </span>
      )}
    />
  );
}

/** An on/off switch: a 32×18 track, the knob slides; the state is also announced (`role="switch"`). */
export function Switch({ checked, onChange, name, disabled, title }: { checked: boolean; onChange: (on: boolean) => void; name: string; disabled?: boolean; title?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={name}
      disabled={disabled}
      title={title}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative inline-flex h-[18px] w-8 shrink-0 items-center rounded-full border transition-colors focus-visible:outline-white disabled:cursor-default disabled:opacity-40",
        checked ? "border-[var(--fg)] bg-[var(--fg)]" : "border-[var(--border-2)] bg-transparent",
      )}
    >
      <span className={cn("absolute h-3 w-3 rounded-full transition-[left,background-color] duration-150", checked ? "left-[15px] bg-[var(--bg)]" : "left-[2px] bg-[var(--muted)]")} />
    </button>
  );
}
