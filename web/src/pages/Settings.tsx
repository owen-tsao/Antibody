import { api } from "@/api";
import type { Health } from "@/api";
import RunSettingsFields from "@/components/RunSettingsFields";
import { usePoll } from "@/hooks/usePoll";
import { seedCount } from "@/lib/derive";
import { DEFAULT_SETTINGS, estimateLabel, isDefaultSettings, type RunSettings } from "@/lib/settings";
import { textButton } from "@/lib/ui";
import { cn } from "@/lib/utils";

/**
 * `/app/settings` (docs/plans/00-overview.md Block 4.5), grouped sections: the run defaults every start
 * dialog opens with (the same `RunSettingsFields`, persisted in localStorage by the parent), the model behind
 * each role as this API resolved it (read-only; they come from the API's environment), and what this
 * install can do. Nothing here calls a write route.
 */

const STATIC_MS = 60_000;

const section = "text-[10.5px] font-medium uppercase tracking-[0.08em] text-[var(--faint)]";
const kv = "flex items-baseline justify-between gap-6 py-3 text-[13px]";

export default function Settings({
  settings,
  onSettingsChange,
  health,
}: {
  settings: RunSettings;
  onSettingsChange: (next: RunSettings) => void;
  health: Health | null;
}) {
  const { data: manifest } = usePoll(api.manifest, STATIC_MS);
  const seeds = seedCount(manifest);
  const models = manifest?.models;
  const weave = typeof health?.weave === "string" ? health.weave : null;

  return (
    <main className="px-6 pb-16 pt-8 md:px-10 md:pt-7">
      <div className="mx-auto w-full max-w-[640px]">
        <h1 className="display text-[48px] leading-[1]">Settings</h1>

        <section className="mt-10">
          <div className="flex items-baseline justify-between">
            <h2 className={section}>Run defaults</h2>
            {!isDefaultSettings(settings) && (
              <button type="button" onClick={() => onSettingsChange({ ...DEFAULT_SETTINGS, target: settings.target })} className={cn(textButton, "text-[12px]")}>
                <span className="u-line">reset to defaults</span>
              </button>
            )}
          </div>
          <div className="mt-2">
            <RunSettingsFields settings={settings} onChange={onSettingsChange} seedCount={seeds} />
          </div>
          <p className="tabular mt-3 text-[12px] text-[var(--faint)]">{estimateLabel(settings, seeds)} · what the start dialog opens with</p>
        </section>

        <section className="mt-12">
          <h2 className={section}>Models</h2>
          <dl className="mt-2 divide-y divide-[var(--border)] border-y border-[var(--border)]">
            {(
              [
                ["Target", models?.target],
                ["Chaos", models?.chaos],
                ["Repair", models?.repair],
                ["Judge", models?.judge],
                ["Inference", models?.inference_url],
              ] as const
            ).map(([label, value]) => (
              <div key={label} className={kv}>
                <dt>{label}</dt>
                <dd className="code truncate text-[12px] text-[var(--muted)]" title={value ?? undefined}>
                  {value ?? (manifest ? "—" : "…")}
                </dd>
              </div>
            ))}
          </dl>
          <p className="mt-3 text-[12px] text-[var(--faint)]">Set with ANTIBODY_*_MODEL in the API's environment; read once at start.</p>
        </section>

        <section className="mt-12">
          <h2 className={section}>Environment</h2>
          <dl className="mt-2 divide-y divide-[var(--border)] border-y border-[var(--border)]">
            <div className={kv}>
              <dt>WANDB_API_KEY</dt>
              <dd className="flex items-center gap-2 text-[var(--muted)]">
                {health && (
                  <span aria-hidden className={cn("h-1.5 w-1.5 rounded-full", health.has_api_key ? "bg-[var(--live)]" : "bg-[var(--danger)]")} />
                )}
                {health ? (health.has_api_key ? "set" : "not set · replays still play") : "…"}
              </dd>
            </div>
            <div className={kv}>
              <dt>Weave tracing</dt>
              <dd className="text-[var(--muted)]">{weave ? weave.replace("_", " ") : "…"}</dd>
            </div>
            {health?.version && (
              <div className={kv}>
                <dt>API</dt>
                <dd className="code text-[12px] text-[var(--muted)]">{health.version}</dd>
              </div>
            )}
          </dl>
        </section>
      </div>
    </main>
  );
}
