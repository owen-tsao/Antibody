import { useCallback, useMemo, useState } from "react";

import { api } from "@/api";
import { CARD_PHOTO } from "@/components/AgentCard";
import ApiDown from "@/components/ApiDown";
import Page from "@/components/Page";
import ScheduleDialog from "@/components/ScheduleDialog";
import type { ShellData } from "@/components/Shell";
import RadialOrbitalTimeline, { type TimelineItem } from "@/components/ui/radial-orbital-timeline";
import { usePoll } from "@/hooks/usePoll";
import { agentHueRotate, relatedSchedules, scheduleEnergy, schedulesLine, scheduleStatus, scheduleTitle, seedCount, triggerLabel } from "@/lib/derive";
import type { RunSettings } from "@/lib/settings";
import { primaryButton } from "@/lib/ui";

const LIST_MS = 15_000;
const STATIC_MS = 60_000;

/**
 * `/app/schedules` (docs/plans/09-roadmap-v1.md §6): every schedule as a node on Owen's radial orbital timeline
 * (`ui/radial-orbital-timeline`), circling a chrome core — each node the schedule's agent as its tile shows it (the
 * agent card's photo in the agent's hue, `AgentTile`) inside a chrome ring, the schedule's name and its trigger in
 * words beneath; a schedule whose agent was deleted is a plain orb. A node's glow grows as its next run nears;
 * nodes on the same agent pulse together when one is picked. Clicking a node turns it to the front and opens the
 * schedule's dialog — its settings, and the run now / pause / delete actions. Schedules fire from the API's own
 * ticker (api/schedules.py), through the same start path as Heal, so a keyless install or a running loop shows in
 * the dialog as `skipped …`, never as a crash.
 */
export default function Schedules({ shell, settings }: { shell: ShellData; settings: RunSettings }) {
  const { agents, agentsError, loop, refresh: refreshShell } = shell;
  const { data: rows, error, refresh } = usePoll(api.schedules, LIST_MS);
  const { data: manifest } = usePoll(api.manifest, STATIC_MS);
  // `create` opens an empty dialog; a schedule id opens that one. The orbit's selection follows the id.
  const [dialog, setDialog] = useState<"create" | string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const act = useCallback(
    async (fn: () => Promise<unknown>) => {
      setActionError(null);
      try {
        await fn();
      } catch (e) {
        setActionError(e instanceof Error ? e.message : String(e));
        throw e;
      } finally {
        refresh();
        refreshShell();
      }
    },
    [refresh, refreshShell],
  );

  // The orbit wants numeric ids; `nodes[i]` stands for `rows[i]`, so id = i + 1 (0 is "none" to the component).
  // `agent_name` is the API's word for "the agent still exists": null means deleted, and the node goes plain.
  const nodes = useMemo<TimelineItem[]>(
    () =>
      (rows ?? []).map((s, i, all) => ({
        id: i + 1,
        title: scheduleTitle(s),
        date: triggerLabel(s.trigger),
        avatar: s.agent_name ? { src: CARD_PHOTO, hue: agentHueRotate(s.agent) } : null,
        relatedIds: relatedSchedules(all, i).map((j) => j + 1),
        status: scheduleStatus(s, loop),
        energy: scheduleEnergy(s),
      })),
    [rows, loop],
  );
  const selectedNode = rows && dialog && dialog !== "create" ? rows.findIndex((s) => s.id === dialog) + 1 || null : null;
  const existing = rows && dialog && dialog !== "create" ? (rows.find((s) => s.id === dialog) ?? null) : null;

  const loaded = !!rows && !!agents;
  return (
    <Page
      title="Schedules"
      className="flex max-w-none flex-col"
      action={
        <div className="flex items-center gap-4">
          {rows && rows.length > 0 && <span className="tabular text-[12px] text-[var(--faint)]">{schedulesLine(rows)}</span>}
          <button type="button" className={primaryButton} disabled={!loaded || agents.length === 0} onClick={() => setDialog("create")}>
            New schedule
          </button>
        </div>
      }
    >
      {!loaded ? (
        <p className="text-[13px]">{error || agentsError ? <ApiDown onRetry={refresh} /> : <span className="text-[var(--faint)]">loading…</span>}</p>
      ) : (
        // The orbit floats on the page: the app shell is the one frame. `overflow-hidden` keeps far nodes from
        // spilling into the header when the field is short.
        <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
          <RadialOrbitalTimeline timelineData={nodes} selectedId={selectedNode} className="min-h-[560px] flex-1" onSelect={(item) => setDialog(item && rows ? (rows[item.id - 1]?.id ?? null) : null)}>
            {rows.length === 0 && (
              <div className="pointer-events-none absolute inset-x-0 bottom-10 flex flex-col items-center gap-1.5 text-center">
                <p className="text-[13px] text-[var(--muted)]">Nothing on the orbit yet.</p>
                <p className="max-w-[44ch] text-[12px] leading-[1.55] text-[var(--faint)]">A schedule attacks an agent on a clock, or whenever its tools change, with the run settings you choose. Every run shows up in Runs.</p>
              </div>
            )}
          </RadialOrbitalTimeline>
        </div>
      )}
      {actionError && (
        <p role="alert" className="mt-3 text-[12px] text-[var(--danger)]">
          {actionError}
        </p>
      )}
      {dialog && agents && (dialog === "create" || existing) && (
        <ScheduleDialog
          agents={agents}
          existing={existing}
          seedCount={seedCount(manifest)}
          defaults={settings}
          onClose={() => setDialog(null)}
          onSaved={() => {
            refresh();
            refreshShell();
          }}
          onRun={existing ? () => act(() => api.scheduleRun(existing.id)) : undefined}
          onToggle={existing ? (on) => act(() => api.scheduleUpdate(existing.id, { enabled: on })) : undefined}
          onDelete={existing ? () => act(() => api.scheduleDelete(existing.id)) : undefined}
        />
      )}
    </Page>
  );
}
