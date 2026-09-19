import { AnimatePresence } from "framer-motion";
import { useState } from "react";

import { api, type Health, type LoopState } from "@/api";
import ApiDown from "@/components/ApiDown";
import StartDialog from "@/components/StartDialog";
import { usePoll } from "@/hooks/usePoll";
import { emptyStateFor, fmtDate, fmtDuration, runAgentLabel, runStatusLabel, versionSpan } from "@/lib/derive";
import { linkProps, navigate } from "@/lib/routes";
import type { RunSettings } from "@/lib/settings";
import { NO_KEY_LINE, primaryButton, textButton } from "@/lib/ui";
import { cn } from "@/lib/utils";

/**
 * `/app/runs` (docs/plans/00-overview.md Block 4.3): every run as a hairline table, newest first — the
 * current run first, labelled by whether its loop is alive; the demo tape labelled as such. A row opens the
 * run. One primary action, Start a run, opens the start dialog.
 */

const RUNS_MS = 5_000;

const cell = "py-3 pr-4 align-baseline";

export default function Runs({
  loop,
  health,
  refresh,
  settings,
  onSettingsChange,
}: {
  loop: LoopState | null;
  health: Health | null;
  refresh: () => void;
  settings: RunSettings;
  onSettingsChange: (next: RunSettings) => void;
}) {
  const { data: runs, error, refresh: refreshRuns } = usePoll(api.runs, RUNS_MS);
  const [dialog, setDialog] = useState(false);
  const noKey = health !== null && !health.has_api_key;
  const running = loop?.running ?? false;
  const empty = emptyStateFor(health);

  return (
    <main className="px-6 pb-16 pt-8 md:px-10 md:pt-7">
      <div className="mx-auto w-full max-w-[1040px]">
        <header className="flex items-end justify-between gap-6">
          <h1 className="display text-[48px] leading-[1]">Runs</h1>
          <button
            type="button"
            onClick={() => setDialog(true)}
            aria-haspopup="dialog"
            aria-expanded={dialog}
            title={noKey ? NO_KEY_LINE : undefined}
            className={primaryButton}
          >
            Start a run
          </button>
        </header>

        <p className="mt-4 min-h-[1.25rem] text-[13px] text-[var(--muted)]">
          {runs ? (
            runs.length === 0 ? (
              <>
                {empty.body}{" "}
                <button type="button" onClick={() => setDialog(true)} className={textButton}>
                  <span className="u-line">Start a run</span>
                </button>
              </>
            ) : (
              `${runs.length} ${runs.length === 1 ? "run" : "runs"}`
            )
          ) : error ? (
            <ApiDown onRetry={refreshRuns} />
          ) : (
            <span className="text-[var(--faint)]">loading…</span>
          )}
        </p>

        {runs && runs.length > 0 && (
          <table className="mt-6 w-full table-fixed border-collapse text-[13px]">
            <colgroup>
              <col className="w-[22%]" />
              <col className="w-[26%]" />
              <col className="w-[10%]" />
              <col className="w-[14%]" />
              <col className="w-[10%]" />
              <col />
            </colgroup>
            <thead>
              <tr className="border-b border-[var(--border)] text-left text-[10.5px] font-medium uppercase tracking-[0.08em] text-[var(--faint)]">
                <th className="py-2 pr-4 font-medium">Started</th>
                <th className="py-2 pr-4 font-medium">Agent</th>
                <th className="py-2 pr-4 text-right font-medium">Cycles</th>
                <th className="py-2 pr-4 text-right font-medium">Config</th>
                <th className="py-2 pr-4 text-right font-medium">Duration</th>
                <th className="py-2 text-right font-medium">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border)]">
              {runs.map((r) => {
                const route = { kind: "run" as const, id: r.id };
                const status = runStatusLabel(r, loop ? loop.running : null);
                return (
                  <tr
                    key={r.id}
                    role="link"
                    tabIndex={0}
                    aria-label={`${r.started_at ? fmtDate(r.started_at) : r.id} · ${runAgentLabel(r)} · ${status}`}
                    onClick={(e) => {
                      // The date cell is a real link (cmd-click, copy address); a plain click anywhere on the row opens the run.
                      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
                      navigate(route);
                    }}
                    onKeyDown={(e) => {
                      if (e.target !== e.currentTarget || (e.key !== "Enter" && e.key !== " ")) return;
                      e.preventDefault();
                      navigate(route);
                    }}
                    className="group cursor-pointer text-[var(--muted)] transition-colors hover:text-[var(--fg)]"
                  >
                    <td className={cn(cell, "tabular")}>
                      {/* The row is the tab stop; the link stays for the pointer's cmd-click and copy-address. */}
                      <a {...linkProps(route)} tabIndex={-1} className="rounded text-[var(--fg)]">
                        <span className="u-line">{r.started_at ? fmtDate(r.started_at) : r.id}</span>
                      </a>
                    </td>
                    <td className={cn(cell, "truncate")}>{runAgentLabel(r)}</td>
                    <td className={cn(cell, "tabular text-right")}>{r.cycles}</td>
                    <td className={cn(cell, "tabular text-right")}>{versionSpan(r)}</td>
                    <td className={cn(cell, "tabular text-right")}>{fmtDuration(r.duration_s)}</td>
                    <td className="py-3 text-right align-baseline">
                      <span className="inline-flex items-center gap-2">
                        {r.id === "live" && running && <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-[var(--live)] motion-safe:animate-pulse" />}
                        {status}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      <AnimatePresence>
        {dialog && <StartDialog settings={settings} onChange={onSettingsChange} onClose={() => setDialog(false)} health={health} loop={loop} refresh={refresh} />}
      </AnimatePresence>
    </main>
  );
}
