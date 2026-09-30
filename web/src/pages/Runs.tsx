import type { LoopState, RunRow } from "@/api";
import AgentTile from "@/components/AgentTile";
import ApiDown from "@/components/ApiDown";
import Page from "@/components/Page";
import { fmtDate, fmtDuration, runAgentLabel, runStatusLabel, versionSpan } from "@/lib/derive";
import { linkProps, navigate } from "@/lib/routes";
import { eyebrow, pill, surface } from "@/lib/ui";
import { cn } from "@/lib/utils";

/**
 * `/app/runs` (docs/plans/07-app-rework.md §9): every run as one hairline table, newest first — the
 * current run first, labelled by whether its loop is alive; the reference run labelled as such. A row opens
 * the run; **watch** on a row that has a recording opens it playing. Runs are started from Current run,
 * not here: this page is the record.
 *
 * Columns (plan 13 §3): the date carries the row's weight, the agent takes the slack, the numbers sit
 * right-aligned against their headers — so the table has no floating gutters.
 */

const cell = "px-4 py-3 align-middle";
const head = "px-4 py-2.5 font-normal";
const num = "tabular text-right";

export default function Runs({ runs, runsError, loop, refresh }: { runs: RunRow[] | null; runsError: string | null; loop: LoopState | null; refresh: () => void }) {
  const count = runs ? `${runs.length} ${runs.length === 1 ? "run" : "runs"}` : null;
  return (
    <Page title="Runs" action={count && <span className="tabular text-[12px] text-[var(--faint)]">{count}</span>}>
      {!runs ? (
        <p className="text-[13px]">{runsError ? <ApiDown onRetry={refresh} /> : <span className="text-[var(--faint)]">loading…</span>}</p>
      ) : runs.length === 0 ? (
        <p className="text-[13px] text-[var(--muted)]">No runs yet. Heal an agent from Current run; every run shows up here.</p>
      ) : (
        <div className={cn(surface, "overflow-hidden")}>
          <table className="w-full table-fixed border-collapse text-[13px]">
            <colgroup>
              <col className="w-[160px]" />
              <col />
              <col className="w-[110px]" />
              <col className="w-[80px]" />
              <col className="w-[90px]" />
              <col className="w-[150px]" />
              <col className="w-[72px]" />
            </colgroup>
            <thead>
              <tr className={cn(eyebrow, "border-b border-[var(--border)] text-left")}>
                <th className={head}>Started</th>
                <th className={head}>Agent</th>
                <th className={head}>Config</th>
                <th className={cn(head, "text-right")}>Cycles</th>
                <th className={cn(head, "text-right")}>Duration</th>
                <th className={head}>Status</th>
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
                    className="group cursor-pointer text-[var(--muted)] transition-colors hover:bg-[var(--hover)]"
                  >
                    <td className={cn(cell, "tabular")}>
                      {/* The row is the tab stop; the link stays for the pointer's cmd-click and copy-address. */}
                      <a {...linkProps(route)} tabIndex={-1} className="rounded font-medium text-[var(--fg)]">
                        {r.started_at ? fmtDate(r.started_at) : r.id}
                      </a>
                    </td>
                    <td className={cn(cell, "truncate")}>
                      <span className="inline-flex max-w-full items-center gap-2">
                        {r.agent && <AgentTile agent={r.agent} size={20} />}
                        <span className="truncate">{runAgentLabel(r)}</span>
                      </span>
                    </td>
                    <td className={cell}>
                      <span className={pill}>{versionSpan(r)}</span>
                    </td>
                    <td className={cn(cell, num)}>{r.cycles}</td>
                    <td className={cn(cell, num)}>{fmtDuration(r.duration_s)}</td>
                    <td className={cn(cell, "truncate")}>{status}</td>
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
