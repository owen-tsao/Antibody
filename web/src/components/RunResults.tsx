import { ArrowSquareOut, CaretRight, Check, X } from "@phosphor-icons/react";
import { motion } from "framer-motion";
import { useMemo, useState } from "react";

import { api, type Approval, type Approvals, type CycleRecord, type Manifest, type RunRow, type State } from "@/api";
import { PanelEmpty } from "@/components/Panel";
import type { ShellData } from "@/components/Shell";
import InteractiveListPreview from "@/components/ui/interactive-list-preview";
import { useMotionPref } from "@/hooks/useMotionPref";
import {
  attacksHeading,
  baselineOnlyLine,
  certifiedLabel,
  fmtAgo,
  gateRows,
  gotThroughLine,
  headlineParts,
  isMeasuring,
  legitCoverageWarning,
  matrixCaption,
  matrixCell,
  matrixMode,
  type MatrixRow,
  matrixRows,
  measureBlocker,
  measureEstimate,
  resultsRows,
  reviewOf,
  runSummary,
  runVerdict,
  versionColumns,
  versionNameIn,
  versionShort,
} from "@/lib/derive";
import { cycleChartSvg } from "@/lib/previewSvg";
import { linkProps, navigate, reviewVersion } from "@/lib/routes";
import { displayHead, eyebrow, pill, primaryButton, surface, textButton } from "@/lib/ui";
import { cn } from "@/lib/utils";

/** A version stop, or `all` — the whole run, every cycle. */
export type Pick = number | "all";

/**
 * One run as a story (plan 12 §4), top to bottom: the verdict — one sentence on what the run found and where that
 * leaves the agent, the run in numbers under it, the one action if there is one — then the cycles as a timeline
 * (every row one sentence: title → got through → fix tried → blocked in 2 of 2 tries → Fix 2), its rail picking
 * which version's attacks it lists; then `Compare versions`, a disclosure holding the matrix — one column per
 * version with the review mark, the gate's numbers, the attack matrix from the run's end measurement or **Measure**
 * when there is none (live run only) — or, with one version, a single line, since a one-column table compares
 * nothing; then whatever the host puts `after` (the run page's About-this-run). The list sits straight on the page's
 * black and its rows align with the blocks above (its inner gutter is cancelled).
 */
export default function RunResults({
  runId,
  row,
  cycles,
  state,
  approvals,
  shell,
  manifest,
  onMeasured,
  after,
}: {
  runId: string;
  row: RunRow | null;
  cycles: CycleRecord[];
  state: State | null;
  /** The run's review decisions; null while loading or for a run that predates them. */
  approvals?: Approvals | null;
  /** The loop, key and status line — what decides whether Measure can start and whether one is running. */
  shell: ShellData;
  /** The API's loop-start defaults; an API that lacks `mode` there cannot measure (it would start a run). */
  manifest: Manifest | null;
  /** After Measure was accepted (202): the host re-polls the loop and, on its exit, the state. */
  onMeasured?: () => void;
  /** Rendered last: the run page's About-this-run. */
  after?: React.ReactNode;
}) {
  const columns = useMemo(() => versionColumns(row, cycles, approvals), [row, cycles, approvals]);
  const versions = useMemo(() => columns.map((c) => c.v), [columns]);
  const last = versions.at(-1) ?? 0;
  const live = runId === "live";
  const [picked, setPicked] = useState<{ runId: string; v: Pick } | null>(null);
  // The selection belongs to one run: switching runs resets — to every cycle for a finished run (its story), to the
  // final version for the live one (what the agent runs now).
  const v: Pick = picked && picked.runId === runId && (picked.v === "all" || versions.includes(picked.v)) ? picked.v : live ? last : "all";
  const rows = useMemo(() => resultsRows(cycles, v, last), [cycles, v, last]);
  // The chart is per cycle and per run, not per version; built once per run, looked up per row.
  const charts = useMemo(() => new Map(cycles.map((c) => [c.cycle, cycleChartSvg(c, cycles)])), [cycles]);
  const vuln = state?.vulnerability ?? null;
  // Cheap enough per render (a few dozen cycles); memoising them trips the compiler's aliasing check on `columns`.
  const gate = gateRows(cycles, columns);
  const families = matrixRows(cycles, vuln);
  const mode = matrixMode(vuln);
  // The long name (`Fix 4`, `Version 4`, `· approved`) rides as the header's title; the column itself stays `v4` so five columns fit.
  const nameOf = (n: number) => versionNameIn(cycles, n, approvals);
  // The guard that ran no task protected nobody: the panel says so under the table, in the signal colour.
  const uncovered = legitCoverageWarning(runSummary(cycles).legitCovered);
  const toCycle = (n: number) => navigate({ kind: "cycle", id: runId, n });
  const verdict = runVerdict(row, cycles, vuln, approvals);
  const parts = headlineParts(verdict.headline);
  const [compare, setCompare] = useState<{ runId: string; open: boolean } | null>(null);
  const open = compare && compare.runId === runId ? compare.open : false;
  const [moreFor, setMoreFor] = useState<{ runId: string; open: boolean } | null>(null);
  const more = moreFor?.runId === runId && moreFor.open;
  const measure = <MeasureAction runId={runId} row={row} cycles={cycles} versions={versions.length} vuln={vuln} shell={shell} manifest={manifest} onMeasured={onMeasured} />;

  if (cycles.length === 0) return <PanelEmpty>No cycles in this run.</PanelEmpty>;

  return (
    <div className="flex flex-col gap-8">
      {/* The verdict on the left, the page's one action on the right: the statement and what to do about it, one row. */}
      <section className="flex flex-wrap items-start justify-between gap-x-8 gap-y-3">
        <div className="flex min-w-0 flex-col gap-1.5">
          {verdict.eyebrow && <span className={eyebrow}>{verdict.eyebrow}</span>}
          <h2 className={displayHead}>
            {parts.lead && <span className={cn(verdict.tone === "warn" && "text-[var(--danger)]", verdict.tone === "good" && "text-[var(--live)]")}>{parts.lead}</span>}
            {parts.rest}
          </h2>
          {verdict.detail && <p className="text-[13px] text-[var(--muted)]">{verdict.detail}</p>}
        </div>
        {verdict.action?.kind === "review" && verdict.action.version !== undefined && (
          <a {...linkProps(reviewVersion(runId, verdict.action.version))} className={cn(primaryButton, "mt-1 shrink-0")}>
            {verdict.action.label}
          </a>
        )}
        {verdict.action?.kind === "measure" && <div className="mt-2 text-[13px]">{measure}</div>}
      </section>

      <section>
        <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
          <h2 className="text-[13px] font-medium text-[var(--fg)]">{attacksHeading(v, cycles)}</h2>
          <VersionRail versions={versions} value={v} onChange={(n) => setPicked({ runId, v: n })} marks={approvals} nameOf={nameOf} />
        </div>
        <div className="-mx-8 mt-2">
          <InteractiveListPreview
            key={`${runId}:${v}`}
            bgColor="transparent"
            items={rows.map((r) => ({ client: r.client, platform: r.ref, services: r.story, preview: charts.get(r.cycle) }))}
            onSelect={(i) => {
              const r = rows[i];
              if (r) toCycle(r.cycle);
            }}
          />
        </div>
      </section>

      <section className={surface}>
        <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-1 px-4 py-3">
          {versions.length > 1 ? (
            <button type="button" aria-expanded={open} onClick={() => setCompare({ runId, open: !open })} className="group inline-flex items-center gap-1.5 rounded text-[13px] font-medium text-[var(--fg)]">
              <CaretRight size={11} weight="bold" aria-hidden className={cn("text-[var(--faint)] transition-transform", open && "rotate-90")} />
              <span>Compare versions</span>
            </button>
          ) : (
            <span className="text-[13px] text-[var(--muted)]">{baselineOnlyLine(cycles, vuln)}</span>
          )}
          <span className="inline-flex items-center gap-4 text-[12px] text-[var(--muted)]">
            {versions.length > 1 && approvals && <span className="tabular">{certifiedLabel(approvals)}</span>}
            {versions.length === 1 && live && mode !== "attacks" && measure}
            {row?.weave_leaderboard_url && (
              <a href={row.weave_leaderboard_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 rounded transition-colors hover:text-[var(--fg)]">
                Open in Weave <ArrowSquareOut size={12} aria-hidden />
              </a>
            )}
          </span>
        </div>
        {versions.length > 1 && open && (
          <div className="border-t border-[var(--border)]">
        <div className="overflow-x-auto">
          <table className="tabular w-full border-collapse text-[12.5px]">
            <caption className="sr-only">Gate numbers and measured attacks per config version</caption>
            <thead>
              <tr className={cn(eyebrow, "border-b border-[var(--border)]")}>
                <th scope="col" className="w-[220px] px-4 py-2.5 text-left font-normal">
                  version
                </th>
                {columns.map((c) => (
                  <th key={c.v} scope="col" title={nameOf(c.v)} className={cn("px-3 py-2.5 text-right font-normal normal-case tracking-normal", c.v === v ? "text-[var(--fg)]" : "text-[var(--muted)]")}>
                    <span className="inline-flex items-center gap-1">
                      {versionShort(c.v)}
                      {c.decision?.status === "approved" && <Check size={10} weight="bold" aria-label="approved" />}
                      {c.decision?.status === "rejected" && <X size={10} weight="bold" aria-label="rejected" />}
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {gate.filter((r) => !r.detail).map((r) => (
                <tr key={r.label} className="border-b border-[var(--border)]">
                  <th scope="row" title={r.title} className="whitespace-nowrap px-4 py-2 text-left font-normal text-[var(--muted)]">
                    {r.label}
                  </th>
                  {r.cells.map((cell, i) => (
                    <td key={columns[i]!.v} title={r.cellTitles?.[i] ?? undefined} className={cn("px-3 py-2 text-right", cell === "—" ? "text-[var(--faint)]" : "text-[var(--fg)]")}>
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
              {/* Review: v0 is the code's own config and is not reviewed; every later version is pending until decided. */}
              {approvals && (
                <tr className="border-b border-[var(--border)]">
                  <th scope="row" className="px-4 py-2 text-left font-normal text-[var(--muted)]">
                    your review
                  </th>
                  {columns.map((c) => (
                    <td key={c.v} className="px-3 py-2 text-right">
                      {c.v === 0 ? (
                        <span className="text-[var(--faint)]">—</span>
                      ) : (
                        <a {...linkProps(reviewVersion(runId, c.v))} title="Review this version" className="group inline-flex rounded">
                          <ReviewMark decision={c.decision} compact />
                        </a>
                      )}
                    </td>
                  ))}
                </tr>
              )}
            </tbody>
            {/* The three rows above decide a version; cost, timing and every attack inform, so they wait behind `more`. */}
            <tbody>
              <tr className={cn(more && "border-b border-[var(--border)]")}>
                <td colSpan={1 + columns.length} className="px-4 py-2">
                  <button type="button" aria-expanded={more} onClick={() => setMoreFor({ runId, open: !more })} className={cn(textButton, "text-[12.5px]")}>
                    {more ? "Less" : `More · cost, timing and every attack`}
                  </button>
                </td>
              </tr>
              {more &&
                gate.filter((r) => r.detail).map((r) => (
                  <tr key={r.label} className="border-b border-[var(--border)]">
                    <th scope="row" title={r.title} className="whitespace-nowrap px-4 py-2 text-left font-normal text-[var(--muted)]">
                      {r.label}
                    </th>
                    {r.cells.map((cell, i) => (
                      <td key={columns[i]!.v} className={cn("px-3 py-2 text-right", cell === "—" ? "text-[var(--faint)]" : "text-[var(--fg)]")}>
                        {cell}
                      </td>
                    ))}
                  </tr>
                ))}
            </tbody>
            {more && (
            <tbody>
              <tr className="border-b border-[var(--border)] bg-[var(--inset)]/40">
                <th scope="rowgroup" colSpan={1 + columns.length} className={cn(eyebrow, "px-4 py-2 text-left font-normal")}>
                  <span className="flex flex-wrap items-center justify-between gap-x-6 gap-y-1">
                    <span>{matrixCaption(mode)}</span>
                    {mode !== "attacks" && measure}
                  </span>
                </th>
              </tr>
              {mode === "attacks" &&
                families.map((f) => (
                  <MatrixFamilyRows key={f.family} family={f.family} rows={f.rows} columns={versions} vuln={vuln} onCycle={toCycle} />
                ))}
              {mode === "counts" && (
                <tr className="border-b border-[var(--border)]">
                  <th scope="row" title="Per-attack results were not recorded for this run; only the counts are." className="px-4 py-2 text-left font-normal text-[var(--muted)]">
                    got through
                  </th>
                  {versions.map((n) => {
                    const line = gotThroughLine(vuln, n);
                    return (
                      <td key={n} className={cn("px-3 py-2 text-right", line === "—" ? "text-[var(--faint)]" : "text-[var(--fg)]")}>
                        {line}
                      </td>
                    );
                  })}
                </tr>
              )}
            </tbody>
            )}
          </table>
        </div>
        {uncovered && (
          <p role="alert" className="border-t border-[var(--border)] px-4 py-2.5 text-[12.5px] text-[var(--danger)]">
            {uncovered}
          </p>
        )}
          </div>
        )}
      </section>

      {after}
    </div>
  );
}

/** One family of the attack matrix: a quiet group row, then one row per attack — the title (tooltip: the scenario id) and a cell per version that opens the cycle behind it. */
function MatrixFamilyRows({ family, rows, columns, vuln, onCycle }: { family: string; rows: MatrixRow[]; columns: number[]; vuln: State["vulnerability"] | null; onCycle: (n: number) => void }) {
  return (
    <>
      <tr>
        <th scope="rowgroup" colSpan={1 + columns.length} className="px-4 pb-1 pt-3 text-left text-[11px] font-normal text-[var(--faint)]">
          {family}
        </th>
      </tr>
      {rows.map((r) => (
        <tr key={r.id} className="border-b border-[var(--border)] last:border-b-0">
          <th scope="row" title={r.id} className="max-w-[200px] truncate px-4 py-1.5 text-left font-normal text-[var(--fg)]">
            {r.title}
          </th>
          {columns.map((n) => {
            const cell = matrixCell(vuln, r.id, n);
            const cycle = r.byVersion[n] ?? r.firstCycle;
            // The matrix is a table of facts, not an alarm: `got through` reads in the foreground, `blocked` steps back,
            // and the signal colour stays with the verdict (plan 12 §9).
            const text = <span className={cn(cell === "got through" ? "font-medium text-[var(--fg)]" : cell === "blocked" ? "text-[var(--muted)]" : "text-[var(--faint)]")}>{cell}</span>;
            return (
              <td key={n} className="px-3 py-1.5 text-right">
                {cycle !== null ? (
                  <button type="button" onClick={() => onCycle(cycle)} title={`open cycle ${cycle}`} aria-label={`${r.title} on ${versionShort(n)}: ${cell} · open cycle ${cycle}`} className="group rounded">
                    <span>{text}</span>
                  </button>
                ) : (
                  text
                )}
              </td>
            );
          })}
        </tr>
      ))}
    </>
  );
}

/**
 * The Measure action with its estimate: `Measure · 72 episodes · about $0.40 · ~6 min`. Off, with the reason as its
 * tooltip, unless this is the current run, the key is set, no loop runs and the API knows the `mode` field; shows
 * `measuring…` while one runs. 409 (the loop got busy first) and other refusals show inline.
 */
function MeasureAction({ runId, row, cycles, versions, vuln, shell, manifest, onMeasured }: { runId: string; row: RunRow | null; cycles: CycleRecord[]; versions: number; vuln: State["vulnerability"] | null; shell: ShellData; manifest: Manifest | null; onMeasured?: () => void }) {
  const { loop, health, status } = shell;
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const measuring = isMeasuring(row, loop, status);
  const blocker = measureBlocker(runId, loop, health, manifest);
  const estimate = measureEstimate(cycles, versions, vuln);
  const start = async () => {
    setBusy(true);
    setNote(null);
    try {
      await api.loopStart({ mode: "vulnerability" });
      onMeasured?.();
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <span className="inline-flex items-center gap-3 normal-case tracking-normal">
      {note && (
        <span role="alert" className="text-[12px] text-[var(--danger)]">
          {note}
        </span>
      )}
      {measuring ? (
        <span className="text-[12px] text-[var(--muted)]">measuring…</span>
      ) : (
        <>
          <span className="tabular text-[12px] text-[var(--faint)]">{estimate.line}</span>
          <button type="button" onClick={() => void start()} disabled={busy || blocker !== null} title={blocker ?? `Re-run every attack against every version, ${estimate.line}`} className={cn(textButton, "text-[12.5px]")}>
            <span>{busy ? "starting…" : "Measure"}</span>
          </button>
        </>
      )}
    </span>
  );
}

/** The review's state as a pill: pending (inset), approved (filled, check), rejected (inset, x, brighter text), with when and the note. `label` replaces the pill's word when the page has more to say (`pending · archived run`). */
export function ReviewMark({ decision, compact = false, label }: { decision: Approval | null; compact?: boolean; label?: string }) {
  const status = decision?.status ?? "pending";
  return (
    <span className="inline-flex items-center gap-2">
      <span className={cn(pill, status === "approved" ? "bg-[var(--fg)] text-[var(--bg)]" : status === "rejected" && "text-[var(--fg)]")}>
        {status === "approved" && <Check size={10} weight="bold" aria-hidden />}
        {status === "rejected" && <X size={10} weight="bold" aria-hidden />}
        {label ?? (status === "pending" ? (compact ? "pending" : "awaiting review") : status)}
      </span>
      {!compact && decision?.at && <span className="text-[var(--faint)]">{fmtAgo(decision.at)}</span>}
      {!compact && decision?.note && <span className="text-[var(--muted)]">— {decision.note}</span>}
    </span>
  );
}

/**
 * The version rail: every version as a stop on one hairline track, then `all`, the chosen one carried by a
 * sliding pill. A radiogroup, so arrow keys move the selection and each stop announces itself. Stops stay `v4`
 * (five fit on one track); the long name is each stop's title and what a screen reader hears.
 */
export function VersionRail({ versions, value, onChange, marks, nameOf, all = true }: { versions: number[]; value: Pick; onChange: (v: Pick) => void; marks?: Approvals | null; nameOf: (v: number) => string; all?: boolean }) {
  const reduced = useMotionPref();
  const stops: Pick[] = all ? [...versions, "all"] : versions;
  const idx = stops.indexOf(value);
  const step = (d: number) => {
    const next = stops[Math.min(stops.length - 1, Math.max(0, idx + d))];
    if (next !== undefined && next !== value) onChange(next);
  };
  return (
    <div
      role="radiogroup"
      aria-label="Config version"
      className="relative flex items-center gap-1 self-start rounded-full border border-[var(--frame)] bg-[var(--card)] p-1"
      onKeyDown={(e) => {
        if (e.key === "ArrowRight" || e.key === "ArrowDown") {
          e.preventDefault();
          step(1);
        } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
          e.preventDefault();
          step(-1);
        } else if (e.key === "Home") {
          e.preventDefault();
          onChange(stops[0]!);
        } else if (e.key === "End") {
          e.preventDefault();
          onChange(stops.at(-1)!);
        }
      }}
    >
      {stops.map((n, i) => {
        const on = n === value;
        const mark = n === "all" ? undefined : reviewOf(marks, n)?.status;
        return (
          <button
            key={n}
            type="button"
            role="radio"
            aria-checked={on}
            title={n === "all" ? undefined : nameOf(n)}
            // `nameOf` already carries ` · approved` on the certified version, so only the other marks are appended.
            aria-label={n === "all" ? "all versions" : mark && mark !== "pending" && !nameOf(n).endsWith(mark) ? `${nameOf(n)}, ${mark}` : nameOf(n)}
            tabIndex={on ? 0 : -1}
            onClick={() => onChange(n)}
            className={cn(
              "tabular relative z-10 inline-flex h-7 min-w-[44px] items-center justify-center gap-1 rounded-full px-3 text-[12.5px] transition-colors",
              on ? "text-[var(--bg)]" : "text-[var(--muted)] hover:text-[var(--fg)]",
              n === "all" && i > 0 && "ml-1 before:absolute before:-left-1.5 before:h-3.5 before:w-px before:bg-[var(--border)]",
            )}
          >
            {on && <motion.span layoutId="version-rail-pill" transition={reduced ? { duration: 0 } : { type: "spring", stiffness: 500, damping: 40 }} className="absolute inset-0 -z-10 rounded-full bg-[var(--fg)]" />}
            {n === "all" ? "all" : versionShort(n)}
            {mark === "approved" && <Check size={10} weight="bold" aria-hidden />}
            {mark === "rejected" && <X size={10} weight="bold" aria-hidden />}
          </button>
        );
      })}
    </div>
  );
}
