import type { LoopState, RunRow } from "@/api";
import AgentTile from "@/components/AgentTile";
import ApiDown from "@/components/ApiDown";
import Page from "@/components/Page";
import { fmtDate, fmtDuration, runAgentLabel, runStatusLabel, versionSpan } from "@/lib/derive";
import { linkProps, navigate } from "@/lib/routes";
import { cn } from "@/lib/utils";

/**
 * `/app/runs` (docs/plans/07-app-rework.md §9): every run as one hairline table, newest first — the
 * current run first, labelled by whether its loop is alive; the demo tape labelled as such. A row opens
 * the run; **watch** on a row that has a recording opens it playing. Runs are started from Current run,
 * not here: this page is the record.
 */

const cell = "px-4 py-3 align-middle";
const head = "px-4 py-2.5 font-medium";

export default function Runs({ runs, runsError, loop, refresh }: { runs: RunRow[] | null; runsError: string | null; loop: LoopState | null; refresh: () => void }) {
  const count = runs ? `${runs.length} ${runs.length === 1 ? "run" : "runs"}` : null;
  return (
    <Page title="Runs" action={count && <span className="tabular text-[12px] text-[var(--faint)]">{count}</span>}>
      {!runs ? (
        <p className="text-[13px]">{runsError ? <ApiDown onRetry={refresh} /> : <span className="text-[var(--faint)]">loading…</span>}</p>
      ) : runs.length === 0 ? (
        <p className="text-[13px] text-[var(--muted)]">No runs yet. Heal an agent from Current run; every run lands here.</p>
      ) : (
        <div className="overflow-hidden rounded-xl border border-[var(--frame)]">
        <table className="w-full table-fixed border-collapse text-[13px]">
          <colgroup>
            <col className="w-[18%]" />
            <col className="w-[24%]" />
            <col className="w-[10%]" />
            <col className="w-[13%]" />
            <col className="w-[11%]" />
            <col />
            <col className="w-[8%]" />
          </colgroup>
          <thead>
            <tr className="border-b border-[var(--border)] text-left text-[10.5px] font-medium uppercase tracking-[0.08em] text-[var(--faint)]">
              <th className={head}>Started</th>
              <th className={head}>Agent</th>
              <th className={cn(head, "text-center")}>Cycles</th>
              <th className={cn(head, "text-center")}>Config</th>
              <th className={cn(head, "text-center")}>Duration</th>
              <th className={cn(head, "text-center")}>Status</th>
              <th className={head} aria-label="Playback" />
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
                  className="group cursor-pointer text-[var(--muted)] transition-colors hover:bg-[var(--hover)] hover:text-[var(--fg)]"
                >
                  <td className={cn(cell, "tabular")}>
                    {/* The row is the tab stop; the link stays for the pointer's cmd-click and copy-address. */}
                    <a {...linkProps(route)} tabIndex={-1} className="rounded text-[var(--fg)]">
                      {r.started_at ? fmtDate(r.started_at) : r.id}
                    </a>
                  </td>
                  <td className={cn(cell, "truncate")}>
                    <span className="inline-flex max-w-full items-center gap-2">
                      {r.agent && <AgentTile agent={r.agent} size={20} />}
                      <span className="truncate">{runAgentLabel(r)}</span>
                    </span>
                  </td>
                  <td className={cn(cell, "tabular text-center")}>{r.cycles}</td>
                  <td className={cn(cell, "tabular text-center")}>{versionSpan(r)}</td>
                  <td className={cn(cell, "tabular text-center")}>{fmtDuration(r.duration_s)}</td>
                  <td className={cn(cell, "text-center")}>{status}</td>
                  <td className={cn(cell, "text-right")}>
                    {r.recording && (
                      <a
                        {...linkProps({ kind: "run", id: r.id, replay: true })}
                        onClick={(e) => {
                          e.stopPropagation();
                          linkProps({ kind: "run", id: r.id, replay: true }).onClick(e);
                        }}
                        className="rounded text-[12px] text-[var(--faint)] transition-colors hover:text-[var(--fg)]"
                      >
                        watch
                      </a>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        </div>
      )}
    </Page>
  );
}
