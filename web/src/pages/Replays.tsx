import { api } from "@/api";
import ApiDown from "@/components/ApiDown";
import { usePoll } from "@/hooks/usePoll";
import { fmtDate, fmtDuration, replayRows, runAgentLabel } from "@/lib/derive";
import { linkProps } from "@/lib/routes";
import { textButton } from "@/lib/ui";

/**
 * `/app/replays` (docs/plans/00-overview.md Block 4.4): every run that can be played back — the demo tape
 * first, then finished runs newest first — with **watch**, which opens the run page with the route's
 * `replay` flag set. The run page owns playback (lane 4B); this is only the list.
 */

const RUNS_MS = 15_000;

export default function Replays() {
  const { data: runs, error, refresh } = usePoll(api.runs, RUNS_MS);
  const rows = runs ? replayRows(runs) : null;

  return (
    <main className="px-6 pb-16 pt-8 md:px-10 md:pt-7">
      <div className="mx-auto w-full max-w-[1040px]">
        <h1 className="display text-[48px] leading-[1]">Replays</h1>
        <p className="mt-4 min-h-[1.25rem] text-[13px] text-[var(--muted)]">
          {rows ? (
            rows.length <= 1 ? "Only the demo tape so far. Finished runs appear here." : `${rows.length} recordings`
          ) : error ? (
            <ApiDown onRetry={refresh} />
          ) : (
            <span className="text-[var(--faint)]">loading…</span>
          )}
        </p>

        {rows && rows.length > 0 && (
          <table className="mt-6 w-full table-fixed border-collapse text-[13px]">
            <colgroup>
              <col className="w-[24%]" />
              <col className="w-[12%]" />
              <col className="w-[10%]" />
              <col />
              <col className="w-[10%]" />
            </colgroup>
            <thead>
              <tr className="border-b border-[var(--border)] text-left text-[10.5px] font-medium uppercase tracking-[0.08em] text-[var(--faint)]">
                <th className="py-2 pr-4 font-medium">Recorded</th>
                <th className="py-2 pr-4 text-right font-medium">Duration</th>
                <th className="py-2 pr-4 text-right font-medium">Cycles</th>
                <th className="py-2 pr-4 font-medium">Agent</th>
                <th className="py-2 text-right font-medium">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border)] text-[var(--muted)]">
              {rows.map((r) => (
                <tr key={r.id} className="align-baseline">
                  <td className="tabular py-3 pr-4">
                    <span className="text-[var(--fg)]">{r.started_at ? fmtDate(r.started_at) : r.id}</span>
                    {r.label && <span className="ml-2 text-[12px] text-[var(--faint)]">{r.label}</span>}
                  </td>
                  <td className="tabular py-3 pr-4 text-right">{fmtDuration(r.duration_s)}</td>
                  <td className="tabular py-3 pr-4 text-right">{r.cycles}</td>
                  <td className="truncate py-3 pr-4">{runAgentLabel(r)}</td>
                  <td className="py-3 text-right">
                    <a {...linkProps({ kind: "run", id: r.id, replay: true })} className={textButton}>
                      <span className="u-line">watch</span>
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </main>
  );
}
