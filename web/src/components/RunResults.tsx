import { motion } from "framer-motion";
import { useMemo, useState } from "react";

import type { CycleRecord, RunRow, State } from "@/api";
import Panel, { PanelEmpty } from "@/components/Panel";
import InteractiveListPreview from "@/components/ui/interactive-list-preview";
import { useMotionPref } from "@/hooks/useMotionPref";
import { resultsRows, versionLine, versionsOf } from "@/lib/derive";
import { cycleChartSvg } from "@/lib/previewSvg";
import { navigate } from "@/lib/routes";
import { cn } from "@/lib/utils";

/**
 * One finished run's results (docs/plans/08-rework-round-2.md §7): a small Versions panel — the rail v0 → vN
 * with the final version selected and one stats line for the picked one — over the hover list of the cycles
 * that attacked that version, each row's chart appearing beside the cursor, a click opening the cycle page.
 * Shown on the agent page (per run) and on a history run's own page; the live run has its own faces. The list
 * sits straight on the page's black (no slab of its own) and its rows align with the panel above: the list's
 * inner gutter is cancelled, so its white bar runs past the content edge the way it did on the old Runs page.
 */
export default function RunResults({ runId, row, cycles, state }: { runId: string; row: RunRow | null; cycles: CycleRecord[]; state: State | null }) {
  const versions = useMemo(() => versionsOf(row, cycles), [row, cycles]);
  const last = versions.at(-1) ?? 0;
  const [picked, setPicked] = useState<{ runId: string; v: number } | null>(null);
  // The selection belongs to one run: switching runs resets to that run's final version.
  const v = picked && picked.runId === runId && versions.includes(picked.v) ? picked.v : last;
  const rows = useMemo(() => resultsRows(cycles, v, last), [cycles, v, last]);
  // The chart is per cycle and per run, not per version; built once per run, looked up per row.
  const charts = useMemo(() => new Map(cycles.map((c) => [c.cycle, cycleChartSvg(c, cycles)])), [cycles]);

  if (cycles.length === 0) return <PanelEmpty>No cycles in this run.</PanelEmpty>;

  return (
    <div className="flex flex-col gap-6">
      <Panel title="Versions">
        <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 px-4 py-3">
          <VersionRail versions={versions} value={v} onChange={(n) => setPicked({ runId, v: n })} />
          <p className="tabular text-[12.5px] text-[var(--muted)]">
            <span className="text-[var(--fg)]">v{v}</span>
            {v === last && <span className="text-[var(--faint)]"> · final</span>}
            {` · ${versionLine(cycles, v, state?.vulnerability)}`}
          </p>
        </div>
      </Panel>

      <div className="-mx-8">
        <InteractiveListPreview
          key={`${runId}:${v}`}
          bgColor="transparent"
          items={rows.map((r) => ({ client: r.client, status: r.status, services: r.services, preview: charts.get(r.cycle) }))}
          onSelect={(i) => {
            const r = rows[i];
            if (r) navigate({ kind: "cycle", id: runId, n: r.cycle });
          }}
        />
      </div>
    </div>
  );
}

/**
 * The version rail: every version as a stop on one hairline track, the chosen one carried by a sliding pill.
 * A radiogroup, so arrow keys move the selection and each stop announces itself.
 */
function VersionRail({ versions, value, onChange }: { versions: number[]; value: number; onChange: (v: number) => void }) {
  const reduced = useMotionPref();
  const idx = versions.indexOf(value);
  const step = (d: number) => {
    const next = versions[Math.min(versions.length - 1, Math.max(0, idx + d))];
    if (next !== undefined && next !== value) onChange(next);
  };
  return (
    <div
      role="radiogroup"
      aria-label="Config version"
      className="relative flex items-center gap-1 self-start rounded-full border border-[var(--frame)] bg-[var(--bg)] p-1"
      onKeyDown={(e) => {
        if (e.key === "ArrowRight" || e.key === "ArrowDown") {
          e.preventDefault();
          step(1);
        } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
          e.preventDefault();
          step(-1);
        } else if (e.key === "Home") {
          e.preventDefault();
          onChange(versions[0]!);
        } else if (e.key === "End") {
          e.preventDefault();
          onChange(versions.at(-1)!);
        }
      }}
    >
      {versions.map((n) => {
        const on = n === value;
        return (
          <button
            key={n}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            onClick={() => onChange(n)}
            className={cn("tabular relative z-10 h-7 min-w-[44px] rounded-full px-3 text-[12.5px] transition-colors", on ? "text-[var(--bg)]" : "text-[var(--muted)] hover:text-[var(--fg)]")}
          >
            {on && <motion.span layoutId="version-rail-pill" transition={reduced ? { duration: 0 } : { type: "spring", stiffness: 500, damping: 40 }} className="absolute inset-0 -z-10 rounded-full bg-[var(--fg)]" />}
            v{n}
          </button>
        );
      })}
    </div>
  );
}
