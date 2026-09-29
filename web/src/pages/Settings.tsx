import { useCallback } from "react";

import { api } from "@/api";
import AgentSwitcher from "@/components/AgentSwitcher";
import ApiDown from "@/components/ApiDown";
import Panel from "@/components/Panel";
import Page from "@/components/Page";
import RunSettingsFields, { Row, Select } from "@/components/RunSettingsFields";
import type { ShellData } from "@/components/Shell";
import TokenField from "@/components/TokenField";
import { usePoll } from "@/hooks/usePoll";
import { domainFallback, seedCount, selectedAgent } from "@/lib/derive";
import { DEFAULT_PREFS, isDefaultPrefs, MOTION_PREFS, REPLAY_SPEEDS, usePrefs, type MotionPref, type ReplaySpeed } from "@/lib/prefs";
import { linkProps, SETTINGS_SECTIONS, settings as settingsRoute, type SettingsSection } from "@/lib/routes";
import { DEFAULT_SETTINGS, estimateLabel, isDefaultSettings, type RunSettings } from "@/lib/settings";
import { textButton } from "@/lib/ui";
import { cn } from "@/lib/utils";

/**
 * `/app/settings/:section` (docs/plans/07-app-rework.md §10): a left sub-nav and one section at a time, each a
 * panel of setting rows. **Run defaults** are the flags every start opens with (`RunSettingsFields`, shared
 * with the wizard's First run step) plus the default agent. **Display** is how the app behaves on this
 * machine (`lib/prefs.ts`; none of it is a loop flag). **Models** and **Environment** are read-only: they
 * come from the API's process. Nothing here calls a write route.
 */

const STATIC_MS = 60_000;

const SECTION_LABEL: Record<SettingsSection, string> = {
  "run-defaults": "Run defaults",
  display: "Display",
  models: "Models",
  environment: "Environment",
  access: "Access",
};

const MOTION_LABEL: Record<MotionPref, string> = { system: "follow the system", reduced: "reduced", full: "full" };

export default function Settings({ section, settings, onSettingsChange, shell }: { section: SettingsSection; settings: RunSettings; onSettingsChange: (next: RunSettings) => void; shell: ShellData }) {
  const { health, agents } = shell;
  const { data: manifest, error: manifestError, refresh: refreshManifest } = usePoll(api.manifest, STATIC_MS);
  const { data: domains } = usePoll(api.domains, STATIC_MS);
  const gatewayFn = useCallback(() => (section === "environment" ? api.gateway(1) : Promise.resolve(null)), [section]);
  const { data: gatewayLog } = usePoll(gatewayFn, 0);
  const { prefs, setPrefs } = usePrefs();
  const seeds = seedCount(manifest);
  const models = manifest?.models;
  const weave = typeof health?.weave === "string" ? health.weave : null;
  const target = selectedAgent(agents, settings.target);

  const reset =
    section === "run-defaults" && !isDefaultSettings(settings) ? (
      <button type="button" onClick={() => onSettingsChange({ ...DEFAULT_SETTINGS, target: settings.target })} className={cn(textButton, "text-[12px]")}>
        reset to defaults
      </button>
    ) : section === "display" && !isDefaultPrefs(prefs) ? (
      <button type="button" onClick={() => setPrefs({ ...DEFAULT_PREFS })} className={cn(textButton, "text-[12px]")}>
        reset to defaults
      </button>
    ) : undefined;

  return (
    <Page title="Settings" action={reset}>
      <div className="grid gap-8 md:grid-cols-[180px_minmax(0,1fr)]">
        <nav aria-label="Settings sections" className="flex flex-col gap-0.5 md:sticky md:top-20 md:self-start">
          {SETTINGS_SECTIONS.map((s) => (
            <a
              key={s}
              {...linkProps(settingsRoute(s))}
              aria-current={s === section ? "page" : undefined}
              className={cn("rounded-md px-2.5 py-1.5 text-[13px] transition-colors", s === section ? "bg-[var(--hover)] text-[var(--fg)]" : "text-[var(--muted)] hover:bg-[var(--hover)] hover:text-[var(--fg)]")}
            >
              {SECTION_LABEL[s]}
            </a>
          ))}
        </nav>

        <div className="flex max-w-[720px] flex-col gap-4">
          {section === "run-defaults" && (
            <>
              <Panel title="Default agent">
                <Row label="Agent to attack" hint="What Heal runs against unless a start picks another.">
                  <AgentSwitcher agents={agents} selected={target} onSelect={(id) => onSettingsChange({ ...settings, target: id })} size="rail" />
                </Row>
              </Panel>
              <Panel title="Run defaults" aside={<span className="tabular">{estimateLabel(settings, seeds)}</span>}>
                <RunSettingsFields settings={settings} onChange={onSettingsChange} seedCount={seeds} domain={{ domains, fallback: domainFallback(target, manifest?.domain) }} framed={false} />
              </Panel>
            </>
          )}

          {section === "display" && (
            <Panel title="Display">
              <div className="divide-y divide-[var(--border)]">
                <Row label="Replay speed" hint="How fast “watch it back” plays a recording. Controls on the run page can change it mid-tape.">
                  <Select value={String(prefs.replaySpeed)} onChange={(v) => setPrefs({ ...prefs, replaySpeed: Number(v) as ReplaySpeed })} options={REPLAY_SPEEDS.map((n) => ({ value: String(n), label: `${n}×` }))} name="Replay speed" />
                </Row>
                <Row label="Poll cadence" hint="How often pages ask the API for changes. Slow triples every interval; the live run page still updates, just later.">
                  <Select value={prefs.pollCadence} onChange={(v) => setPrefs({ ...prefs, pollCadence: v === "slow" ? "slow" : "normal" })} options={[{ value: "normal", label: "normal" }, { value: "slow", label: "slow" }]} name="Poll cadence" />
                </Row>
                <Row label="Motion" hint="Transitions, the metal rims, the orbs. “Follow the system” reads the OS reduce-motion setting.">
                  <Select value={prefs.motion} onChange={(v) => setPrefs({ ...prefs, motion: v as MotionPref })} options={MOTION_PREFS.map((m) => ({ value: m, label: MOTION_LABEL[m] }))} name="Motion" />
                </Row>
              </div>
            </Panel>
          )}

          {section === "models" && (
            <>
              <Panel title="Models" aside={!manifest && manifestError ? <ApiDown onRetry={refreshManifest} /> : undefined}>
                <dl className="divide-y divide-[var(--border)]">
                  {(
                    [
                      ["Target", "The agent under attack, when it is the built-in one.", models?.target],
                      ["Chaos", "Invents attacks after the seeds.", models?.chaos],
                      ["Repair", "Proposes a fix when an attack gets through.", models?.repair],
                      ["Judge", "Decides whether an episode failed.", models?.judge],
                      ["Inference", "Where every model call goes.", models?.inference_url],
                    ] as const
                  ).map(([label, hint, value]) => (
                    <div key={label} className="flex items-center justify-between gap-6 px-4 py-3">
                      <div className="min-w-0">
                        <dt className="text-[13px] text-[var(--fg)]">{label}</dt>
                        <dd className="mt-0.5 text-[12px] text-[var(--faint)]">{hint}</dd>
                      </div>
                      <dd className="code max-w-[55%] truncate text-right text-[12px] text-[var(--muted)]" title={value ?? undefined}>
                        {value ?? (manifest ? "—" : "…")}
                      </dd>
                    </div>
                  ))}
                </dl>
              </Panel>
              <p className="px-1 text-[12px] text-[var(--faint)]">Set with ANTIBODY_*_MODEL in the API's environment; read once at start.</p>
            </>
          )}

          {section === "environment" && (
            <Panel title="Environment">
              <dl className="divide-y divide-[var(--border)]">
                <div className="flex items-center justify-between gap-6 px-4 py-3">
                  <div>
                    <dt className="code text-[13px] text-[var(--fg)]">WANDB_API_KEY</dt>
                    <dd className="mt-0.5 text-[12px] text-[var(--faint)]">Needed to run live; replays play without it.</dd>
                  </div>
                  <dd className={cn("text-[13px]", health ? (health.has_api_key ? "text-[var(--muted)]" : "text-[var(--danger)]") : "text-[var(--faint)]")}>{health ? (health.has_api_key ? "set" : "missing") : "…"}</dd>
                </div>
                <div className="flex items-center justify-between gap-6 px-4 py-3">
                  <div>
                    <dt className="text-[13px] text-[var(--fg)]">Weave tracing</dt>
                    <dd className="mt-0.5 text-[12px] text-[var(--faint)]">Every episode, verdict and gate as a trace.</dd>
                  </div>
                  <dd className="text-[13px] text-[var(--muted)]">{weave ? weave.replace("_", " ") : "…"}</dd>
                </div>
                {health?.version && (
                  <div className="flex items-center justify-between gap-6 px-4 py-3">
                    <dt className="text-[13px] text-[var(--fg)]">API</dt>
                    <dd className="code text-[12px] text-[var(--muted)]">{health.version}</dd>
                  </div>
                )}
                <div className="flex flex-col gap-1.5 px-4 py-3">
                  <dt className="text-[13px] text-[var(--fg)]">Enforcement gateway</dt>
                  <dd className="text-[12px] text-[var(--faint)]">Runs the approved version's tool rules in front of an agent's real tools; logs first, blocks with --enforce. Start it beside the agent:</dd>
                  <dd className="code select-all text-[12px] text-[var(--muted)]">{gatewayLog?.command ?? "python -m chaos.gateway --backend <tools url> --version approved"}</dd>
                </div>
              </dl>
            </Panel>
          )}

          {section === "access" && (
            <>
              <Panel title="API token" aside={<span>{health ? (health.auth_required ? "required by this API" : "not required") : "…"}</span>}>
                <div className="px-4 py-4">
                  <TokenField onChange={shell.refresh} />
                </div>
              </Panel>
              <p className="px-1 text-[12px] text-[var(--faint)]">
                Set <span className="code">ANTIBODY_API_TOKEN</span> in the API's environment and every request but the health check must carry it. Unset, the API is open on this machine as before.
              </p>
            </>
          )}
        </div>
      </div>
    </Page>
  );
}
