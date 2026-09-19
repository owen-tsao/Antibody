import { CHAOS_CYCLES, REPAIR_ATTEMPTS, SEEDS, UNTIL_QUIET, type RunSettings } from "@/lib/settings";
import { textButton } from "@/lib/ui";
import { cn } from "@/lib/utils";

/**
 * The run-settings rows — Seeds · Chaos cycles · Repair attempts · Second pass · Until quiet — as one block
 * of hairline rows, shared by the start dialog, the Settings page's run defaults and the onboarding wizard's
 * First run step. The parent owns the values; this only edits them. Every field is a flag `chaos.loop run`
 * already has (lib/settings.ts). `world` left the fields: the API default `auto` resolves to the mock
 * storefront without Zendesk credentials, which is the only world the sandbox runs in.
 */

export default function RunSettingsFields({
  settings,
  onChange,
  seedCount,
}: {
  settings: RunSettings;
  onChange: (next: RunSettings) => void;
  /** How many seed scenarios exist (from the manifest); null while unknown, which falls back to the API's cap. */
  seedCount: number | null;
}) {
  // The seeds stepper walks 0 … S−1 then "all" (= S, so no duplicate stop). S is the manifest's count,
  // or the API's cap while the manifest is unknown.
  const seedTop = Math.max(1, seedCount ?? SEEDS.max);
  const set = (patch: Partial<RunSettings>) => onChange({ ...settings, ...patch });

  const seedsDown = () => set({ seeds: settings.seeds === null ? seedTop - 1 : settings.seeds - 1 });
  const seedsUp = () => set({ seeds: settings.seeds !== null && settings.seeds + 1 >= seedTop ? null : (settings.seeds ?? 0) + 1 });

  // The API rejects a streak longer than the cap, so lowering the cap drags the streak down with it.
  const setChaos = (chaosCycles: number) =>
    set({ chaosCycles, untilQuiet: settings.untilQuiet === null ? null : chaosCycles === 0 ? null : Math.min(settings.untilQuiet, chaosCycles) });
  const quietMax = Math.min(UNTIL_QUIET.max, settings.chaosCycles);
  const untilQuiet = settings.untilQuiet;

  return (
    <div className="divide-y divide-[var(--border)] border-y border-[var(--border)]">
      <Row label="Seeds">
        <Stepper
          value={settings.seeds === null ? "all" : settings.seeds}
          onDown={seedsDown}
          onUp={seedsUp}
          downDisabled={settings.seeds === SEEDS.min}
          upDisabled={settings.seeds === null}
          name="seeds"
        />
      </Row>
      <Row label="Chaos cycles">
        <Stepper
          value={settings.chaosCycles}
          onDown={() => setChaos(settings.chaosCycles - 1)}
          onUp={() => setChaos(settings.chaosCycles + 1)}
          downDisabled={settings.chaosCycles <= CHAOS_CYCLES.min}
          upDisabled={settings.chaosCycles >= CHAOS_CYCLES.max}
          name="chaos cycles"
        />
      </Row>
      <Row label="Repair attempts">
        <Stepper
          value={settings.repairAttempts}
          onDown={() => set({ repairAttempts: settings.repairAttempts - 1 })}
          onUp={() => set({ repairAttempts: settings.repairAttempts + 1 })}
          downDisabled={settings.repairAttempts <= REPAIR_ATTEMPTS.min}
          upDisabled={settings.repairAttempts >= REPAIR_ATTEMPTS.max}
          name="repair attempts"
        />
      </Row>
      <Row label="Second pass">
        <button
          type="button"
          role="switch"
          aria-checked={settings.secondPass}
          onClick={() => set({ secondPass: !settings.secondPass })}
          className={cn(textButton, "tabular w-10 text-right", settings.secondPass && "text-[var(--fg)]")}
        >
          <span className="u-line">{settings.secondPass ? "on" : "off"}</span>
        </button>
      </Row>
      <Row label="Until quiet" hint="stop early once this many chaos attacks in a row are blocked">
        {untilQuiet === null ? (
          <button
            type="button"
            role="switch"
            aria-checked={false}
            disabled={settings.chaosCycles === 0}
            title={settings.chaosCycles === 0 ? "needs at least one chaos cycle" : undefined}
            onClick={() => set({ untilQuiet: Math.min(2, quietMax) })}
            className={cn(textButton, "tabular w-10 text-right")}
          >
            <span className="u-line">off</span>
          </button>
        ) : (
          <div className="flex items-baseline gap-3">
            <Stepper
              value={untilQuiet}
              onDown={() => set({ untilQuiet: untilQuiet - 1 })}
              onUp={() => set({ untilQuiet: untilQuiet + 1 })}
              downDisabled={untilQuiet <= UNTIL_QUIET.min}
              upDisabled={untilQuiet >= quietMax}
              name="blocked attacks in a row"
            />
            <button type="button" onClick={() => set({ untilQuiet: null })} className={cn(textButton, "text-[12px]")}>
              <span className="u-line">off</span>
            </button>
          </div>
        )}
      </Row>
    </div>
  );
}

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-6 py-3">
      <span className="text-[13px]" title={hint}>
        {label}
      </span>
      {children}
    </div>
  );
}

function Stepper({
  value,
  onDown,
  onUp,
  downDisabled,
  upDisabled,
  name,
}: {
  value: number | string;
  onDown: () => void;
  onUp: () => void;
  downDisabled: boolean;
  upDisabled: boolean;
  /** For the buttons' accessible names ("fewer seeds", "more seeds"). */
  name: string;
}) {
  return (
    <div className="flex items-baseline gap-3">
      <button type="button" onClick={onDown} disabled={downDisabled} aria-label={`fewer ${name}`} className={textButton}>
        <span className="u-line">−</span>
      </button>
      <span className="tabular w-7 text-center text-[13px]" aria-live="polite">
        {value}
      </span>
      <button type="button" onClick={onUp} disabled={upDisabled} aria-label={`more ${name}`} className={textButton}>
        <span className="u-line">+</span>
      </button>
    </div>
  );
}
