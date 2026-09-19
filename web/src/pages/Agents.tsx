import { useState } from "react";

import { api, ApiError, type Health, type PingResult } from "@/api";
import ApiDown from "@/components/ApiDown";
import { usePoll } from "@/hooks/usePoll";
import { exampleState, pingLabel, pingResultLine, runsByAgent, toolMapping, toolsMappedLabel } from "@/lib/derive";
import { linkProps, onboarding } from "@/lib/routes";
import { cn } from "@/lib/utils";

/**
 * `/app/agents` (docs/plans/00-overview.md Block 3.3): every connected support agent as a hairline table —
 * name · how it is reached · last ping · tools mapped · runs — with quiet actions per row and one primary
 * action, Connect agent, top-right. The built-in agent is the demo; the example agent can be started and
 * stopped from here; stored agents can be pinged and deleted (confirm on the second click).
 *
 * `GET /api/agents` is polled at 3 s, never faster: each call probes port 8790 with a 1 s timeout while the
 * example agent is down. Pings made here live in page state — synthetic rows have nowhere to keep one.
 */

const AGENTS_MS = 3_000;
const RUNS_MS = 10_000;

export const NO_KEY_REASON = "Set WANDB_API_KEY to run live";

const quiet =
  "group rounded text-[12px] text-[var(--muted)] transition-colors hover:text-[var(--fg)] disabled:cursor-default disabled:text-[var(--faint)] disabled:hover:text-[var(--faint)]";
export const primaryButton =
  "inline-flex h-8 items-center rounded-lg bg-[var(--fg)] px-3 text-[13px] font-medium text-[var(--bg)] transition-opacity hover:opacity-85 disabled:cursor-default disabled:opacity-40 disabled:hover:opacity-40";

type Pinging = PingResult | "pending";

export default function AgentsList({ health }: { health: Health | null }) {
  const { data: agents, error, refresh } = usePoll(api.agents, AGENTS_MS);
  const { data: runs } = usePoll(api.runs, RUNS_MS);
  // The built-in row lists exactly the storefront's tools (api/agents.py `_builtin_row`). /api/manifest's
  // `tools` is the shorter TOOL_SPECS list (3 of 5), which would make the demo agent read "3/5" against itself.
  const storefront = agents?.find((a) => a.id === "builtin")?.tools?.map((t) => t.name) ?? null;
  const runCounts = runsByAgent(runs ?? []);

  const [pings, setPings] = useState<Record<string, Pinging>>({});
  // One inline message per row: a ping error is a result, not a message; these are HTTP failures (409, 503).
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [confirming, setConfirming] = useState<string | null>(null);
  // "starting…" from the click until the next poll's `starting`/`running` takes over (a few seconds at most).
  const [justStarted, setJustStarted] = useState(false);

  const note = (id: string, text: string | null) =>
    setNotes((n) => {
      const next = { ...n };
      if (text === null) delete next[id];
      else next[id] = text;
      return next;
    });

  const ping = async (id: string) => {
    setPings((p) => ({ ...p, [id]: "pending" }));
    note(id, null);
    try {
      const r = await api.agentPing(id);
      setPings((p) => ({ ...p, [id]: r }));
    } catch (e) {
      setPings((p) => {
        const next = { ...p };
        delete next[id];
        return next;
      });
      note(id, e instanceof Error ? e.message : String(e));
    } finally {
      refresh();
    }
  };

  const remove = async (id: string) => {
    setConfirming(null);
    try {
      await api.agentDelete(id);
    } catch (e) {
      note(id, e instanceof Error ? e.message : String(e));
    } finally {
      refresh();
    }
  };

  const startExample = async () => {
    note("example", null);
    setJustStarted(true);
    setTimeout(() => setJustStarted(false), 2 * AGENTS_MS);
    try {
      await api.exampleStart();
    } catch (e) {
      setJustStarted(false);
      note("example", e instanceof Error ? e.message : String(e));
    } finally {
      refresh();
    }
  };

  const stopExample = async () => {
    note("example", null);
    setJustStarted(false);
    try {
      await api.exampleStop();
    } catch (e) {
      // 404 = nothing was running; the row already says so.
      if (!(e instanceof ApiError && e.status === 404)) note("example", e instanceof Error ? e.message : String(e));
    } finally {
      refresh();
    }
  };

  const noKey = health !== null && !health.has_api_key;
  const connected = (agents ?? []).filter((a) => !a.synthetic);

  return (
    <main className="px-6 pb-16 pt-8 md:px-10 md:pt-7">
      <div className="mx-auto w-full max-w-[1040px]">
        <header className="flex items-end justify-between gap-6">
          <h1 className="display text-[48px] leading-[1]">Agents</h1>
          <a {...linkProps(onboarding(1))} className={primaryButton}>
            Connect agent
          </a>
        </header>

        <p className="mt-4 min-h-[1.25rem] text-[13px] text-[var(--muted)]">
          {agents ? (
            `${agents.length} ${agents.length === 1 ? "agent" : "agents"}${connected.length === 0 ? " · none of your own yet" : ""}`
          ) : error ? (
            <ApiDown onRetry={refresh} />
          ) : (
            <span className="text-[var(--faint)]">loading…</span>
          )}
        </p>

        {agents && (
          <table className="mt-6 w-full table-fixed border-collapse text-[13px]">
            <colgroup>
              <col className="w-[26%]" />
              <col className="w-[20%]" />
              <col className="w-[30%]" />
              <col className="w-[7%]" />
              <col className="w-[7%]" />
              <col />
            </colgroup>
            <thead>
              <tr className="border-b border-[var(--border)] text-left text-[10.5px] font-medium uppercase tracking-[0.08em] text-[var(--faint)]">
                <th className="py-2 pr-4 font-medium">Name</th>
                <th className="py-2 pr-4 font-medium">Reached at</th>
                <th className="py-2 pr-4 font-medium">Last ping</th>
                <th className="py-2 pr-4 text-right font-medium">Tools</th>
                <th className="py-2 pr-4 text-right font-medium">Runs</th>
                <th className="py-2 text-right font-medium">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border)]">
              {agents.map((a) => {
                const p = pings[a.id];
                const inSession = p && p !== "pending" ? p : null;
                const mapping = inSession ? inSession.mapping : toolMapping(a.tools, storefront);
                const isExample = a.id === "example";
                const state = isExample ? exampleState(a) : null;
                const starting = state === "starting" || (isExample && state === "stopped" && justStarted);
                return (
                  <tr key={a.id} className="align-top">
                    <td className="py-3 pr-4">
                      <div className="font-medium text-[var(--fg)]">{a.name}</div>
                      <div className="mt-0.5 text-[12px] text-[var(--faint)]">
                        {a.id === "builtin" ? "demo agent · in-process" : isExample ? `${starting ? "starting…" : state} · HTTP` : "HTTP"}
                      </div>
                    </td>
                    <td className="code py-3 pr-4 text-[12px] text-[var(--muted)]">{a.url ?? "—"}</td>
                    <td className="py-3 pr-4 text-[var(--muted)]">
                      {p === "pending" ? (
                        <span className="text-[var(--faint)]">pinging…</span>
                      ) : inSession ? (
                        <span className={cn(!inSession.ok && "text-[var(--danger)]")}>{pingResultLine(inSession)}</span>
                      ) : (
                        <span className={cn(a.last_ping && !a.last_ping.ok && "text-[var(--danger)]")}>{pingLabel(a.last_ping)}</span>
                      )}
                      {notes[a.id] && (
                        <div role="alert" className="mt-1 text-[12px] text-[var(--danger)]">
                          {notes[a.id]}
                        </div>
                      )}
                    </td>
                    <td className="tabular py-3 pr-4 text-right text-[var(--muted)]">{toolsMappedLabel(mapping)}</td>
                    <td className="tabular py-3 pr-4 text-right text-[var(--muted)]">{runCounts.get(a.id) ?? 0}</td>
                    <td className="py-3 text-right">
                      <div className="flex justify-end gap-4">
                        {a.id !== "builtin" && (
                          <button type="button" onClick={() => void ping(a.id)} disabled={p === "pending"} className={quiet}>
                            <span className="u-line">ping</span>
                          </button>
                        )}
                        {isExample &&
                          (state === "running" || state === "starting" ? (
                            <button type="button" onClick={() => void stopExample()} className={quiet}>
                              <span className="u-line">stop</span>
                            </button>
                          ) : (
                            <button
                              type="button"
                              onClick={() => void startExample()}
                              disabled={starting}
                              title={noKey ? `${NO_KEY_REASON}; the example agent calls inference` : undefined}
                              className={quiet}
                            >
                              <span className="u-line">{starting ? "starting…" : "start"}</span>
                            </button>
                          ))}
                        {!a.synthetic &&
                          (confirming === a.id ? (
                            <span className="inline-flex gap-3">
                              <button type="button" onClick={() => void remove(a.id)} className={cn(quiet, "text-[var(--danger)] hover:text-[var(--danger)]")}>
                                <span className="u-line">confirm delete</span>
                              </button>
                              <button type="button" onClick={() => setConfirming(null)} className={quiet}>
                                <span className="u-line">cancel</span>
                              </button>
                            </span>
                          ) : (
                            <button type="button" onClick={() => setConfirming(a.id)} className={quiet}>
                              <span className="u-line">delete</span>
                            </button>
                          ))}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}

        {agents && connected.length === 0 && (
          <p className="mt-6 text-[13px] text-[var(--muted)]">
            Only the built-in agents so far.{" "}
            <a {...linkProps(onboarding(1))} className="group rounded text-[var(--muted)] transition-colors hover:text-[var(--fg)]">
              <span className="u-line">Connect your support agent</span>
            </a>{" "}
            to attack it in the sandbox storefront.
          </p>
        )}
      </div>
    </main>
  );
}
