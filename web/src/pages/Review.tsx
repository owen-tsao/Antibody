import { ArrowLeft, ArrowRight, CaretDown, CaretRight, Check, Code, Copy, TerminalWindow, X } from "@phosphor-icons/react";
import { type KeyboardEvent, type MouseEvent, useCallback, useEffect, useRef, useState } from "react";

import { api, type Agent, type AgentConfig, type InboxAgent, type ToolRule } from "@/api";
import AgentTile from "@/components/AgentTile";
import ApiDown from "@/components/ApiDown";
import ConfigDiff, { type DiffMode } from "@/components/ConfigDiff";
import Page from "@/components/Page";
import { ReviewMark } from "@/components/RunResults";
import type { ShellData } from "@/components/Shell";
import { usePoll } from "@/hooks/usePoll";
import {
  activeTab,
  approvedBase,
  ARCHIVED_RUN_NOTE,
  closeTab,
  decisionLabel,
  decisionStatus,
  reviewItemAt,
  diffHeadline,
  fileChanged,
  firstChangedFile,
  fixesLine,
  flattenTree,
  fmtAgo,
  fmtTimeShort,
  FRAMEWORKS,
  type Framework,
  gateLine,
  gateShort,
  gatewayCommand,
  type InboxEntry,
  inboxCardLine,
  inboxCardTitle,
  inboxGateLine,
  inboxHistoryAll,
  inboxItemLine,
  inboxQueue,
  inboxTree,
  inboxWaitingLabel,
  indentGuides,
  intentWords,
  legitCoverageWarning,
  liveTabs,
  openTab,
  pendingLabel,
  pendingNeighbours,
  patchNoteLine,
  pendingOrder,
  pseudoFiles,
  type PseudoFile,
  pseudoFileText,
  readSource,
  replayEmptyLine,
  replayLine,
  replayRows,
  replayTitle,
  type ReviewItem,
  type ReviewTab,
  type ReviewTabs,
  reviewTree,
  ruledTools,
  ruleSnippet,
  runOwner,
  runTitle,
  stripTitle,
  tabKey,
  tabLabel,
  tabOfVersion,
  tabRunName,
  tabTitle,
  treeKey,
  type TreeNode,
  versionName,
} from "@/lib/derive";
import { linkProps, navigate, REVIEW, reviewVersion } from "@/lib/routes";
import { primaryButton, surface, textButton } from "@/lib/ui";
import { cn } from "@/lib/utils";

// Approvals change when a person acts, here or on another screen; a slow poll catches the latter and is what brings
// the inbox back after an outage when the shell's recovery signal is missed (a tab in the background).
const READ_MS = 30_000;

/** The one run the editor has open: its cycles (for the strip's gate line and goal) and approvals (for the marks and the approved base). Rejects whole: a run with no approvals on hand would read as all pending, with Approve on versions already decided. */
async function readRun(run: string) {
  const source = readSource(run);
  const [cycles, approvals] = await Promise.all([api.cycles(source), api.approvals(source)]);
  return { run, cycles, approvals };
}

/** The candidate and its base for a `runId:version:base` key; null for an empty key. */
async function readPair(key: string) {
  if (!key) return null;
  const [runId, ver, b] = key.split(":");
  const source = readSource(runId!);
  const [before, after] = await Promise.all([api.config(Number(b), source), api.config(Number(ver), source)]);
  return { key, before, after };
}

/**
 * `/app/review` (plan 12 §5): the inbox — one flat list of every version waiting for a decision, across agents,
 * with the decided and archived ones behind a `History` line — and, at `/app/review/:run/:version`, the editor for
 * one version: the title strip (`Fix 3 · fixes cycle 8 · <attack>`, the gate's numbers, the icon row, prev / next
 * through the pending sequence, Reject / Approve), a tree of that run's agent's runs and versions from the same
 * inbox, and the document — a tab strip, the file's diff against the last approved version (not the parent: a
 * reviewer sees everything since what they last signed off), and a shadow-replay drawer scoped to the agent's own
 * tools backend. Both faces share one poll of `GET /api/review/inbox`.
 */
export default function Review({ run, v, shell }: { run?: string; v?: number; shell: ShellData }) {
  const { down } = shell;
  const { data: inbox, error: inboxError, refresh: rereadInbox } = usePoll(api.reviewInbox, READ_MS);
  // The shell's 2 s polls see the API come back long before this page's next tick would: re-read on recovery.
  const wasDown = useRef(false);
  useEffect(() => {
    if (wasDown.current && !down) rereadInbox();
    wasDown.current = down;
  }, [down, rereadInbox]);

  if (run === undefined || v === undefined) return <Inbox inbox={inbox} error={inboxError} reread={rereadInbox} shell={shell} />;
  return <Editor run={run} v={v} inbox={inbox} inboxError={inboxError} rereadInbox={rereadInbox} shell={shell} />;
}

/**
 * The inbox (plan 13 §4): every pending version across agents as a decision card — the current run's undecided
 * ones, the only kind a decision can be recorded on — current run first, highest version first. The card holds
 * what the fix is for, what the gate measured, the repair agent's own words for the change, and Reject / Approve,
 * so the decision is taken where the item is listed; `Open the diff →` is the editor for anyone who wants to read
 * the change first. Nothing pending is one line, not a panel. Under it, one quiet toggle reveals the history:
 * undecided versions of archived runs (`from an older run`) and everything already decided, with the run named
 * since titles repeat across runs.
 */
function Inbox({ inbox, error, reread, shell }: { inbox: InboxAgent[] | null; error: string | null; reread: () => void; shell: ShellData }) {
  const { down, refresh } = shell;
  const queue = inbox ? inboxQueue(inbox) : [];
  const history = inbox ? inboxHistoryAll(inbox) : [];
  const [showHistory, setShowHistory] = useState(false);
  const waiting = inboxWaitingLabel(queue);
  // The pending versions are all on the current run, so one read of its configs gives every card its patch note.
  const hasQueue = queue.length > 0;
  const configsFn = useCallback(() => (hasQueue ? api.configs("live") : Promise.resolve(null)), [hasQueue]);
  const { data: configs } = usePoll(configsFn, READ_MS);
  const noteOf = (version: number) => patchNoteLine(configs?.find((c) => c.version === version)?.patch_note);

  // One decision in flight at a time; a failure stays with the version it came from until the next attempt.
  const [busy, setBusy] = useState<number | null>(null);
  const [failure, setFailure] = useState<{ version: number; text: string } | null>(null);
  const frozen = down ? "The API is unreachable; deciding resumes when it answers." : null;
  const decide = async (version: number, status: "approved" | "rejected") => {
    setBusy(version);
    setFailure(null);
    try {
      await api.review(version, status);
      reread();
      refresh();
    } catch (e) {
      setFailure({ version, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(null);
    }
  };

  return (
    <Page eyebrow="Review" title="Inbox" action={waiting && <span className="tabular text-[12px] text-[var(--faint)]">{waiting}</span>}>
      {inbox === null ? (
        <p className="text-[12.5px] text-[var(--faint)]">{error ? down ? <ApiDown onRetry={refresh} /> : `The inbox could not be read · ${error}` : "Loading…"}</p>
      ) : inbox.length === 0 ? (
        <p className="text-[12.5px] text-[var(--faint)]">No agents yet — connect one and run Heal; the fixes it proposes show up here.</p>
      ) : (
        <>
          {queue.length === 0 ? (
            <p className="text-[12.5px] text-[var(--faint)]">Nothing waiting for you. Fixes the current run proposes show up here.</p>
          ) : (
            <ul className="grid gap-4 lg:grid-cols-2">
              {queue.map((i) => (
                <DecisionCard key={`${i.run}:${i.version}`} item={i} note={noteOf(i.version)} busy={busy === i.version} frozen={frozen} failure={failure?.version === i.version ? failure.text : null} onDecide={(s) => void decide(i.version, s)} />
              ))}
            </ul>
          )}
          {history.length > 0 && (
            <div className="mt-8">
              <button type="button" onClick={() => setShowHistory((h) => !h)} aria-expanded={showHistory} className={cn(textButton, "inline-flex h-7 items-center gap-1.5 text-[12px]")}>
                <CaretRight size={11} weight="bold" aria-hidden className={cn("text-[var(--faint)] transition-transform", showHistory && "rotate-90")} />
                <span className="tabular">History · {history.length}</span>
              </button>
              {showHistory && (
                <ul className={cn(surface, "mt-3 divide-y divide-[var(--border)] overflow-hidden")}>
                  {history.map((i) => (
                    <InboxRow key={`${i.run}:${i.version}`} item={i} />
                  ))}
                </ul>
              )}
            </div>
          )}
        </>
      )}
    </Page>
  );
}

/**
 * One pending version as a decision: who it is for, `Fix 2` and the attack it blocks as the headline, the gate's
 * numbers, the repair agent's reason, then the two decisions — Approve filled, Reject quiet — with the editor one
 * click away. The Approve is the card's one loud element; the surface carries the rest.
 */
function DecisionCard({ item, note, busy, frozen, failure, onDecide }: { item: InboxEntry; note: string | null; busy: boolean; frozen: string | null; failure: string | null; onDecide: (s: "approved" | "rejected") => void }) {
  const line = inboxCardLine(item);
  return (
    <li className={cn(surface, "flex flex-col gap-3 p-5")}>
      <div className="flex items-center justify-between gap-3 text-[12px] text-[var(--faint)]">
        <span className="inline-flex min-w-0 items-center gap-2">
          {item.agent ? <AgentTile agent={item.agent} size={20} /> : <span className="h-5 w-5 shrink-0 rounded-[5px] border border-[var(--border)]" aria-hidden />}
          <span className="truncate">{item.agent?.name ?? "deleted agent"}</span>
        </span>
        {item.run_started && <span className="tabular shrink-0">{fmtAgo(item.run_started)}</span>}
      </div>
      <h2 className="text-[15px] font-medium leading-snug text-[var(--fg)]">
        <span className="tabular">{versionName(item.version, item.cycle !== null, null)}</span>
        <span className="text-[var(--faint)]"> · </span>
        {inboxCardTitle(item)}
      </h2>
      {line && <p className="tabular text-[12.5px] text-[var(--muted)]">{line}</p>}
      {note && (
        <p className="line-clamp-2 text-[12.5px] leading-relaxed text-[var(--muted)]" title={note}>
          {note}
        </p>
      )}
      <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
        <a {...linkProps(reviewVersion(item.run, item.version))} className={cn(textButton, "text-[12.5px]")}>
          <span>Open the diff →</span>
        </a>
        <span className="flex items-center gap-3" title={frozen ?? undefined}>
          <button type="button" disabled={busy || !!frozen} onClick={() => onDecide("rejected")} className={textButton}>
            Reject
          </button>
          <button type="button" disabled={busy || !!frozen} onClick={() => onDecide("approved")} className={cn(primaryButton, "h-8")}>
            {busy ? "…" : "Approve"}
          </button>
        </span>
      </div>
      {failure && (
        <p role="alert" className="text-[12px] text-[var(--danger)]">
          {failure}
        </p>
      )}
    </li>
  );
}

/**
 * One version in the history: agent tile and name · `Fix 4` · what it fixes · run · gate line · the decision's mark,
 * or `from an older run` for an undecided version nothing can be decided on any more · when · →. The run is named
 * because titles repeat across runs (`Order lookup returns null` nine times).
 */
function InboxRow({ item }: { item: InboxEntry }) {
  const decision = item.status ? { version: item.version, status: item.status, at: item.decided_at, note: item.note ?? "" } : null;
  const when = decision?.at ?? item.run_started;
  const gate = inboxGateLine(item.gate);
  return (
    <li>
      <a {...linkProps(reviewVersion(item.run, item.version))} className="group flex h-11 items-center gap-3 px-4 text-[12.5px] transition-[background-color] duration-150 hover:bg-[var(--hover)]">
        <span className="flex w-[150px] shrink-0 items-center gap-2 text-[var(--muted)]">
          {item.agent ? <AgentTile agent={item.agent} size={20} /> : <span className="h-5 w-5 shrink-0 rounded-[5px] border border-[var(--border)]" aria-hidden />}
          <span className="truncate">{item.agent?.name ?? "deleted agent"}</span>
        </span>
        <span className="tabular w-[76px] shrink-0 font-medium text-[var(--fg)]">{versionName(item.version, item.cycle !== null, null)}</span>
        {/* The two prose columns share the remaining width 3:2 — fixed widths would starve the attack title on a laptop. */}
        <span className="min-w-0 flex-[3] truncate text-[var(--fg)]" title={item.title}>
          {inboxItemLine(item)}
        </span>
        <span className="hidden w-[150px] shrink-0 truncate text-[11.5px] text-[var(--muted)] sm:inline" title={`run ${item.run}`}>
          {runTitle(item.run, { started_at: item.run_started })}
        </span>
        <span className="hidden min-w-0 flex-[2] truncate text-[11.5px] text-[var(--muted)] lg:inline" title={gate ?? undefined}>
          {gate}
        </span>
        <span className="flex w-[110px] shrink-0 justify-end text-[11.5px] text-[var(--muted)]">{decision ? <ReviewMark decision={decision} compact /> : "from an older run"}</span>
        <span className="tabular w-[72px] shrink-0 text-right text-[11.5px] text-[var(--faint)]">{when ? fmtAgo(when) : ""}</span>
        <ArrowRight size={12} className="shrink-0 text-[var(--faint)] transition-colors group-hover:text-[var(--fg)]" aria-hidden />
      </a>
    </li>
  );
}

/** The editor for one version of one run; its agent is the run's. */
function Editor({ run, v, inbox, inboxError, rereadInbox, shell }: { run: string; v: number; inbox: InboxAgent[] | null; inboxError: string | null; rereadInbox: () => void; shell: ShellData }) {
  const { runs, runsError, agents, agentsError, down, refresh: refreshShell } = shell;
  const owner = runOwner(runs, run);
  const agent = agents?.find((a) => a.id === owner?.id) ?? null;

  // The open run's own files: its cycles fill the strip, its approvals decide the diff's base. Re-read after a
  // decision here; `usePoll` keeps the last good answer through an outage.
  const readFn = useCallback(() => readRun(run), [run]);
  const { data: read, error: readError, refresh: reread } = usePoll(readFn, READ_MS);
  const current = read && read.run === run ? read : null;

  // The tree: the agent's runs as the inbox lists them, the open run's cycles filled in. An inbox that does not know
  // this run (an older API, a run just archived) still shows the run itself, built from its own files.
  const fromInbox = inboxTree(inbox ?? [], agent?.id ?? null, runs, current ? { run, cycles: current.cycles } : null);
  const row = runs?.find((r) => r.id === run) ?? null;
  const tree = fromInbox.some((r) => r.runId === run) || !row || !current ? fromInbox : [...reviewTree([{ row, cycles: current.cycles, approvals: current.approvals }]), ...fromInbox];
  const { prev, next } = pendingNeighbours(pendingOrder(inbox ?? []), run, v);

  const item = reviewItemAt(tree, run, v);
  const base = item ? approvedBase(current?.approvals ?? null, item.version) : null;

  // The candidate and its approved base (v0 when nothing is approved yet); keyed so a new pick refetches.
  const cfgKey = item ? `${item.runId}:${item.version}:${base ?? 0}` : "";
  const cfgFn = useCallback(() => readPair(cfgKey), [cfgKey]);
  const { data: cfgs, error: cfgError, refresh: rereadPair } = usePoll(cfgFn, 0);
  const pair = cfgs && cfgs.key === cfgKey ? cfgs : null;

  // The shell's 2 s polls see the API come back long before this page's next tick would: re-read both on recovery.
  const wasDown = useRef(false);
  useEffect(() => {
    if (wasDown.current && !down) {
      reread();
      rereadPair();
    }
    wasDown.current = down;
  }, [down, reread, rereadPair]);

  // Moving to a version of another run (a tree click, the prev / next arrows) is a new question, and the run read
  // is a slow poll: without this the page would show "loading" until the next 30 s tick. The mount's own first tick
  // is left alone, so only a change of run re-reads.
  const lastRun = useRef(run);
  useEffect(() => {
    if (lastRun.current !== run) reread();
    lastRun.current = run;
  }, [run, reread]);

  const files = pseudoFiles(row?.target ?? agent?.id ?? "builtin");
  const changed = (f: PseudoFile) => (pair ? fileChanged(pair.before, pair.after, f) : false);

  // One strip for the whole page, like an editor's: tabs from any version stay open, and the shown tab decides which
  // version the tree selects. Only the tabs in state are ever drawn (`lib/derive.ts` `openTab` / `closeTab`).
  const [strip, setStrip] = useState<ReviewTabs>({ tabs: [], active: null });
  const shownTab = activeTab(strip);
  const shownFile = shownTab && item && shownTab.run === item.runId && shownTab.version === item.version ? shownTab.file : null;
  // Two adjustments made while rendering, each settling in one pass: tabs whose version left the tree go (a run
  // was cleared); a selected version with no tab of its own opens on its first changed file once both configs are
  // here to say which that is.
  const loading = agents === null || runs === null || (current === null && readError === null) || (inbox === null && inboxError === null);
  const kept = loading ? strip.tabs : liveTabs(strip.tabs, tree);
  if (kept.length !== strip.tabs.length) {
    setStrip({ tabs: kept, active: kept.some((t) => tabKey(t) === strip.active) ? strip.active : null });
  } else if (item && pair && shownFile === null) {
    setStrip(openTab(strip.tabs, { run: item.runId, version: item.version, file: firstChangedFile(pair.before, pair.after, files) }));
  }

  const runName = (id: string) => tabRunName(id, runs?.find((r) => r.id === id));
  const runTitleOf = (id: string) => tree.find((r) => r.runId === id)?.title ?? id;
  // Showing another version is a navigation: the address is the version (plan 11 §2), so Back returns to it.
  const goTo = (runId: string, version: number) => {
    if (runId !== run || version !== v) navigate(reviewVersion(runId, version));
  };
  const show = (tab: ReviewTab) => {
    setStrip((s) => openTab(s.tabs, tab));
    goTo(tab.run, tab.version);
  };
  const openFile = (f: PseudoFile) => {
    if (item) show({ run: item.runId, version: item.version, file: f });
  };
  const close = (k: string) => {
    if (strip.tabs.length < 2) return;
    const nextStrip = closeTab(strip.tabs, strip.active, k);
    setStrip(nextStrip);
    const now = activeTab(nextStrip);
    if (now && k === strip.active) goTo(now.run, now.version);
  };
  const [mode, setMode] = useState<DiffMode>("unified");

  // The tree's own state: which runs are open (the current run by default), whether the selected version shows
  // its files, and which row holds the roving tab stop.
  const [openRuns, setOpenRuns] = useState<Record<string, boolean>>({});
  const [filesOpen, setFilesOpen] = useState(true);
  const nodes = flattenTree(tree, openRuns, item, filesOpen, files, changed);
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const focused = nodes.some((n) => n.key === focusKey) ? focusKey : item ? treeKey.version(item.runId, item.version) : nodes[0]?.key ?? null;
  const treeRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (focusKey && treeRef.current?.contains(document.activeElement)) treeRef.current.querySelector<HTMLElement>(`[data-key="${focusKey}"]`)?.focus();
  }, [focusKey, nodes.length]);

  // Selecting a version focuses its open tab when it has one; otherwise the render above opens its first changed file.
  const select = (i: ReviewItem) => {
    setFilesOpen(true);
    const t = tabOfVersion(strip.tabs, i.runId, i.version);
    setStrip((s) => ({ ...s, active: t ? tabKey(t) : null }));
    goTo(i.runId, i.version);
  };
  const toggleRun = (runId: string, open?: boolean) => {
    const isOpen = nodes.some((n) => n.kind === "run" && n.run.runId === runId && n.open);
    setOpenRuns((o) => ({ ...o, [runId]: open ?? !isOpen }));
  };
  const onTreeKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = nodes.findIndex((n) => n.key === focused);
    const node = nodes[i];
    if (!node) return;
    const go = (j: number) => setFocusKey(nodes[Math.max(0, Math.min(nodes.length - 1, j))]!.key);
    switch (e.key) {
      case "ArrowDown":
        go(i + 1);
        break;
      case "ArrowUp":
        go(i - 1);
        break;
      case "Home":
        go(0);
        break;
      case "End":
        go(nodes.length - 1);
        break;
      case "ArrowRight":
        if (node.kind === "run") {
          if (node.open) go(i + 1);
          else toggleRun(node.run.runId, true);
        } else if (node.kind === "version") {
          if (node.open) go(i + 1);
          else select(node.item);
        }
        break;
      case "ArrowLeft":
        if (node.kind === "run") toggleRun(node.run.runId, false);
        else if (node.kind === "version") {
          if (node.open) setFilesOpen(false);
          else setFocusKey(treeKey.run(node.item.runId));
        } else setFocusKey(treeKey.version(node.item.runId, node.item.version));
        break;
      case "Enter":
      case " ":
        if (node.kind === "run") toggleRun(node.run.runId);
        else if (node.kind === "version") select(node.item);
        else openFile(node.file);
        break;
      default:
        return;
    }
    e.preventDefault();
    setFocusKey((k) => k ?? node.key);
  };

  // The error is keyed to the version it came from, so it does not hang over the next pick.
  const [failure, setFailure] = useState<{ key: string; text: string } | null>(null);
  const note = failure && failure.key === cfgKey ? failure.text : null;
  const [busy, setBusy] = useState(false);
  const decide = async (status: "approved" | "rejected") => {
    if (!item) return;
    setBusy(true);
    setFailure(null);
    try {
      await api.review(item.version, status);
      reread();
      rereadInbox();
      refreshShell();
    } catch (e) {
      setFailure({ key: cfgKey, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  if (runsError && runs === null) return <ApiDown onRetry={refreshShell} />;
  // Nothing on screen yet and the reads are failing: the same line every page shows, not "Loading…" for ever.
  const unreachable = loading && (agentsError !== null || (current === null && readError !== null));
  const emptyLine = loading ? (unreachable ? <ApiDown onRetry={refreshShell} /> : "Loading…") : !row ? "No such run — it may have been cleared." : !item ? `This run has no v${v}.` : null;
  // Approve / Reject need the approvals on hand to be the current ones: through an outage, or while this page's own
  // read is failing, the tree is last-good data and a decision would be made against marks that may have changed.
  const frozen = down ? "The API is unreachable; deciding resumes when it answers." : readError !== null ? "The approvals could not be re-read; deciding resumes when they load." : null;

  return (
    <Page
      eyebrow={
        <span className="flex items-baseline gap-1.5">
          <a {...linkProps(REVIEW)} className="rounded transition-colors hover:text-[var(--fg)]">
            Review
          </a>
          <span>/</span>
          <span className="max-w-[200px] truncate text-[var(--muted)]">{owner?.name ?? (runs ? "unknown agent" : "…")}</span>
          <span>/</span>
        </span>
      }
      // `Fix N` vs `Version N` needs the run's cycles (`item.cycle`); until they are read the short form is the one name that is always true.
      title={item && current ? <span title={fixesLine(item)}>{stripTitle(item)}</span> : `v${v}`}
      action={
        <>
          <span className="flex items-center gap-0.5" aria-label="Pending versions">
            <button type="button" disabled={!prev} onClick={() => prev && navigate(reviewVersion(prev.run, prev.version))} title={prev ? `previous pending · ${prev.run === "live" ? "current run" : prev.run} v${prev.version}` : "No earlier pending version"} aria-label="Previous pending version" className={ICON_BUTTON}>
              <ArrowLeft size={14} aria-hidden />
            </button>
            <button type="button" disabled={!next} onClick={() => next && navigate(reviewVersion(next.run, next.version))} title={next ? `next pending · ${next.run === "live" ? "current run" : next.run} v${next.version}` : "No later pending version"} aria-label="Next pending version" className={ICON_BUTTON}>
              <ArrowRight size={14} aria-hidden />
            </button>
          </span>
          {item && (
            <>
              <span aria-hidden className="h-4 w-px bg-[var(--border)]" />
              <StripActions item={item} cfg={pair?.after ?? null} agent={agent} busy={busy} frozen={frozen} onDecide={decide} />
            </>
          )}
        </>
      }
      className="flex max-w-none flex-col p-0 md:h-[calc(100dvh-3.5rem)] md:flex-none md:flex-row"
    >
      <div ref={treeRef} role="tree" aria-label="Versions to review" onKeyDown={onTreeKey} className="shrink-0 overflow-y-auto border-b border-[var(--border)] py-2 md:w-[260px] md:border-b-0 md:border-r">
        {!loading &&
          row &&
          nodes.map((node) => (
            <TreeRow
              key={node.key}
              node={node}
              focused={node.key === focused}
              // Exactly one row carries the bar: the shown tab's file, or its version while the files are folded.
              selected={node.kind === "file" ? node.key === strip.active : node.kind === "version" && !node.open && !!item && item.runId === node.item.runId && item.version === node.item.version}
              onFocusKey={setFocusKey}
              onToggleRun={toggleRun}
              onSelect={select}
              onOpenFile={openFile}
              onToggleFiles={() => setFilesOpen((o) => !o)}
            />
          ))}
      </div>

      <section className="flex min-h-0 min-w-0 flex-1 flex-col">
        {item && (
          <div className="flex h-9 shrink-0 items-stretch border-b border-[var(--border)] pr-3">
            <TabStrip strip={strip} runName={runName} runTitle={runTitleOf} onShow={show} onClose={close} />
            {pair && shownFile && changed(shownFile) && (
              <div role="radiogroup" aria-label="Diff layout" className="ml-3 flex shrink-0 items-center gap-1 text-[12px]">
                {(["unified", "split"] as const).map((m) => (
                  <button key={m} type="button" role="radio" aria-checked={mode === m} onClick={() => setMode(m)} className={cn("rounded px-2 py-0.5 transition-[color,background-color] duration-150", mode === m ? "bg-[var(--hover)] text-[var(--fg)]" : "text-[var(--faint)] hover:text-[var(--fg)]")}>
                    {m === "unified" ? "unified" : "side-by-side"}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        <div className="flex min-h-[240px] flex-1 flex-col overflow-auto px-4 py-4">
          {!item ? (
            <p className="flex flex-1 items-center justify-center text-[12.5px] text-[var(--faint)]">{emptyLine ?? "Pick a version to see what changed."}</p>
          ) : (
            <>
              <p className="tabular mb-3 text-[12px] leading-4 text-[var(--faint)]">{diffHeadline(item.version, base, item.decision !== null)}</p>
              {note && (
                <p role="alert" className="mb-3 text-[12.5px] text-[var(--danger)]">
                  {note}
                </p>
              )}
              {cfgError ? (
                <p className="text-[12.5px] text-[var(--muted)]">{down ? <ApiDown onRetry={refreshShell} /> : `Could not load this version: ${cfgError}`}</p>
              ) : !pair || !shownFile ? (
                <p className="text-[12.5px] text-[var(--faint)]">Loading…</p>
              ) : (
                <ConfigDiff before={pair.before} after={pair.after} file={shownFile} mode={changed(shownFile) ? mode : "unified"} collapseAt={Infinity} />
              )}
            </>
          )}
        </div>

        {item && <ReplayDrawer runId={item.runId} version={item.version} agent={agent} />}
      </section>
    </Page>
  );
}

/** One row of the tree: a run (caret, title, pending badge), a version (status dot, `v3`, what it fixes, its mark right-aligned) or a file (name, changed dot). `selected` is the one row with the hairline bar on the hover fill. */
function TreeRow({
  node,
  focused,
  selected,
  onFocusKey,
  onToggleRun,
  onSelect,
  onOpenFile,
  onToggleFiles,
}: {
  node: TreeNode;
  focused: boolean;
  selected: boolean;
  onFocusKey: (k: string) => void;
  onToggleRun: (runId: string) => void;
  onSelect: (i: ReviewItem) => void;
  onOpenFile: (f: PseudoFile) => void;
  onToggleFiles: () => void;
}) {
  const click = () => {
    onFocusKey(node.key);
    if (node.kind === "run") onToggleRun(node.run.runId);
    else if (node.kind === "version") {
      if (node.open) onToggleFiles();
      else onSelect(node.item);
    } else onOpenFile(node.file);
  };
  const Caret = node.kind !== "file" && node.open ? CaretDown : CaretRight;
  const guides = indentGuides(node.depth);
  return (
    <div
      role="treeitem"
      data-key={node.key}
      tabIndex={focused ? 0 : -1}
      aria-level={node.depth + 1}
      aria-expanded={node.kind === "file" ? undefined : node.open}
      aria-selected={selected}
      // The tooltip would become the row's accessible name; the label keeps what the row shows.
      title={node.kind === "version" ? fixesLine(node.item) : undefined}
      aria-label={node.kind === "version" ? `v${node.item.version} · ${decisionStatus(node.item.decision)} · ${node.item.fixes}` : undefined}
      onClick={click}
      className={cn(
        "flex h-7 cursor-default items-center gap-2 pr-3 text-[12.5px] outline-offset-[-2px] transition-[color,background-color] duration-150 hover:bg-[var(--hover)]",
        selected && "bg-[var(--hover)] shadow-[inset_1px_0_0_var(--fg)]",
      )}
      style={{
        paddingLeft: 10 + node.depth * 14,
        // Hairline indent guides under each ancestor's caret, as a background so the hover fill sits beneath them.
        backgroundImage: guides.map(() => "linear-gradient(var(--border), var(--border))").join(", ") || undefined,
        backgroundSize: guides.length ? "1px 100%" : undefined,
        backgroundRepeat: guides.length ? "no-repeat" : undefined,
        backgroundPosition: guides.map((x) => `${x}px 0`).join(", ") || undefined,
      }}
    >
      {node.kind === "run" && (
        <>
          <Caret size={11} className="shrink-0 text-[var(--faint)]" aria-hidden />
          <span className="min-w-0 flex-1 truncate font-medium text-[var(--fg)]">{node.run.title}</span>
          <span className="tabular shrink-0 text-[11px] text-[var(--faint)]">{pendingLabel(node.run.pending, node.run.current)}</span>
        </>
      )}
      {node.kind === "version" && (
        <>
          <StatusDot status={decisionStatus(node.item.decision)} />
          <span className="tabular shrink-0 text-[var(--fg)]">v{node.item.version}</span>
          <span className="min-w-0 flex-1 truncate text-[var(--faint)]">{node.item.fixes}</span>
          <span className="shrink-0 text-[11px] text-[var(--faint)]">{decisionStatus(node.item.decision)}</span>
        </>
      )}
      {node.kind === "file" && (
        <>
          <span className={cn("code min-w-0 flex-1 truncate text-[12px]", selected ? "text-[var(--fg)]" : node.changed ? "text-[var(--muted)]" : "text-[var(--faint)]")}>{node.file}</span>
          {node.changed && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--fg)]" aria-label="changed" />}
        </>
      )}
    </div>
  );
}

/**
 * The editor's tab strip: every open tab in state, the shown one in the foreground with a hairline sitting on the
 * strip's bottom border so it reads as joined to the document. Overflow scrolls sideways without a scrollbar, the
 * hidden side faded. Keyboard on the list: ←/→ and Home/End move, Enter (the button's own) shows, Delete/Backspace
 * closes; middle-click closes too. The last tab has no close: the document always shows something.
 */
function TabStrip({ strip, runName, runTitle, onShow, onClose }: { strip: ReviewTabs; runName: (run: string) => string; runTitle: (run: string) => string; onShow: (t: ReviewTab) => void; onClose: (key: string) => void }) {
  const listRef = useRef<HTMLDivElement>(null);
  const [fade, setFade] = useState({ left: false, right: false });
  const measure = useCallback(() => {
    const el = listRef.current;
    if (!el) return;
    const left = el.scrollLeft > 1;
    const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
    setFade((f) => (f.left === left && f.right === right ? f : { left, right }));
  }, []);
  useEffect(() => {
    measure();
    const el = listRef.current;
    if (!el) return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [measure, strip.tabs.length]);
  // The shown tab is brought into view when it changes (a tree click can pick a tab past the edge).
  useEffect(() => {
    if (strip.active) listRef.current?.querySelector<HTMLElement>(`[data-key="${strip.active}"]`)?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [strip.active]);

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const tabs = Array.from(listRef.current?.querySelectorAll<HTMLElement>('[role="tab"]') ?? []);
    const i = tabs.findIndex((t) => t === document.activeElement);
    if (i < 0) return;
    switch (e.key) {
      case "ArrowRight":
        tabs[Math.min(tabs.length - 1, i + 1)]?.focus();
        break;
      case "ArrowLeft":
        tabs[Math.max(0, i - 1)]?.focus();
        break;
      case "Home":
        tabs[0]?.focus();
        break;
      case "End":
        tabs[tabs.length - 1]?.focus();
        break;
      case "Delete":
      case "Backspace": {
        const key = tabs[i]?.dataset.key;
        if (key) {
          onClose(key);
          // Focus follows the neighbour the strip activates, so a second Delete keeps closing.
          requestAnimationFrame(() => listRef.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus());
        }
        break;
      }
      default:
        return;
    }
    e.preventDefault();
  };
  const mask = fade.left || fade.right ? `linear-gradient(to right, ${fade.left ? "transparent, #000 24px" : "#000"}, ${fade.right ? "#000 calc(100% - 24px), transparent" : "#000"})` : undefined;
  const closable = strip.tabs.length > 1;
  return (
    <div
      ref={listRef}
      role="tablist"
      aria-label="Open files"
      onKeyDown={onKey}
      onScroll={measure}
      className="-mb-px flex min-w-0 flex-1 items-stretch overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      style={{ maskImage: mask, WebkitMaskImage: mask }}
    >
      {strip.tabs.map((t) => {
        const key = tabKey(t);
        const on = key === strip.active;
        const label = tabLabel(t, strip.tabs, runName);
        return (
          <div
            key={key}
            className={cn(
              "group relative flex shrink-0 items-stretch transition-[color,background-color] duration-150",
              on ? "text-[var(--fg)] after:absolute after:inset-x-0 after:bottom-0 after:h-px after:bg-[var(--fg)]" : "text-[var(--muted)] hover:bg-[var(--hover)] hover:text-[var(--fg)]",
            )}
          >
            <button
              type="button"
              role="tab"
              data-key={key}
              aria-selected={on}
              tabIndex={on ? 0 : -1}
              title={tabTitle(t, runTitle(t.run))}
              onClick={() => onShow(t)}
              onMouseDown={(e: MouseEvent) => {
                if (e.button === 1) e.preventDefault();
              }}
              onAuxClick={(e: MouseEvent) => {
                if (e.button === 1 && closable) onClose(key);
              }}
              className={cn("code flex max-w-[240px] items-center truncate pl-4 text-[12px] outline-offset-[-2px]", closable ? "pr-0.5" : "pr-4")}
            >
              <span className="truncate">{label}</span>
            </button>
            {closable && (
              <button
                type="button"
                tabIndex={-1}
                onClick={() => onClose(key)}
                aria-label={`Close ${label}`}
                className={cn("mr-1.5 flex h-6 w-6 self-center items-center justify-center rounded text-[var(--faint)] transition-[color,background-color,opacity] duration-150 hover:bg-[var(--hover)] hover:text-[var(--fg)] group-hover:opacity-100", on ? "opacity-100" : "opacity-0")}
              >
                <X size={11} aria-hidden />
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** The version's mark as a 6 px dot: pending hollow, approved filled, rejected dim. */
function StatusDot({ status }: { status: "pending" | "approved" | "rejected" }) {
  return <span aria-hidden className={cn("h-1.5 w-1.5 shrink-0 rounded-full", status === "approved" ? "bg-[var(--fg)]" : status === "rejected" ? "bg-[var(--faint)]" : "border border-[var(--muted)]")} />;
}

/** The header's right end: the gate's numbers, the icon row (copy rules · copy gateway command · snippets), then the decision. `frozen` names why deciding is off for now (an outage); null means the marks on screen are current. */
function StripActions({ item, cfg, agent, busy, frozen, onDecide }: { item: ReviewItem; cfg: AgentConfig | null; agent: Agent | null; busy: boolean; frozen: string | null; onDecide: (s: "approved" | "rejected") => void }) {
  const gate = gateShort(item.cycle);
  const uncovered = legitCoverageWarning(item.cycle?.gate?.legit_covered);
  return (
    <>
      {gate && (
        <span title={uncovered ?? gateLine(item.cycle) ?? undefined} className={cn("tabular hidden text-[12px] lg:inline", uncovered ? "text-[var(--danger)]" : "text-[var(--muted)]")}>
          {gate}
        </span>
      )}
      <span className="flex items-center gap-0.5">
        <CopyIcon label="Copy tool_rules.json" text={cfg ? pseudoFileText(cfg, "tool_rules.json") : null} icon={Copy} />
        <CopyIcon label="Copy the gateway command, this version pinned" text={gatewayCommand(item.version, agent?.tools_backend)} icon={TerminalWindow} />
        <SnippetsPopover cfg={cfg} agentId={agent && !agent.synthetic ? agent.id : null} />
      </span>
      <span aria-hidden className="h-4 w-px bg-[var(--border)]" />
      {item.decidable && !item.decision && !frozen ? (
        <>
          <button type="button" disabled={busy} onClick={() => onDecide("rejected")} className={textButton}>
            Reject
          </button>
          <button type="button" disabled={busy} onClick={() => onDecide("approved")} className={cn(primaryButton, "h-8")}>
            Approve
          </button>
        </>
      ) : (
        <span title={!item.decision ? (frozen ?? (!item.decidable ? ARCHIVED_RUN_NOTE : undefined)) : undefined}>
          <ReviewMark decision={item.decision} compact={!item.decision} label={!item.decision && !frozen ? decisionLabel("pending", item.decidable) : undefined} />
        </span>
      )}
    </>
  );
}

const ICON_BUTTON = "inline-flex h-7 w-7 items-center justify-center rounded-md text-[var(--muted)] transition-colors hover:bg-[var(--hover)] hover:text-[var(--fg)] disabled:cursor-default disabled:text-[var(--faint)] disabled:hover:bg-transparent";

/** A 28 px icon button that copies `text` and shows a check for a moment; inert while there is nothing to copy. */
function CopyIcon({ label, text, icon: Icon }: { label: string; text: string | null; icon: typeof Copy }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard blocked (http origin, permissions): nothing to show; the text is in the document pane.
    }
  };
  return (
    <button type="button" onClick={copy} disabled={!text} title={copied ? "copied" : label} aria-label={label} className={ICON_BUTTON}>
      {copied ? <Check size={14} aria-hidden /> : <Icon size={14} aria-hidden />}
    </button>
  );
}

/** Copy that says "copied" for a moment, as text — for the snippets panel, where the icon row's check would be lost. */
function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard blocked: the text is on screen to select.
    }
  };
  return (
    <button type="button" onClick={copy} className={cn(textButton, "text-[12px]")}>
      <span>{copied ? "copied" : "copy"}</span>
    </button>
  );
}

/** The framework snippets behind one icon: a popover under the header's right end; Escape or a click outside closes it. */
function SnippetsPopover({ cfg, agentId }: { cfg: AgentConfig | null; agentId: string | null }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!(e.target instanceof Node) || !rootRef.current?.contains(e.target)) setOpen(false);
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <span ref={rootRef} className="relative inline-flex">
      <button type="button" onClick={() => setOpen((o) => !o)} disabled={!cfg} aria-expanded={open} aria-haspopup="dialog" title="Framework snippets" aria-label="Framework snippets" className={cn(ICON_BUTTON, open && "bg-[var(--hover)] text-[var(--fg)]")}>
        <Code size={14} aria-hidden />
      </button>
      {open && cfg && (
        <div role="dialog" aria-label="Framework snippets" className="absolute right-0 top-full z-40 mt-2 w-[min(560px,calc(100vw-48px))] rounded-lg border border-[var(--border-2)] bg-[var(--card)] shadow-[0_8px_32px_rgba(0,0,0,.5)]">
          <Snippets cfg={cfg} agentId={agentId} />
        </div>
      )}
    </span>
  );
}

/** The document pane's foot: an editor's terminal panel — one title row, the replay's bars and samples when opened. */
function ReplayDrawer({ runId, version, agent }: { runId: string; version: number; agent: Agent | null }) {
  const [open, setOpen] = useState(false);
  const backend = agent?.tools_backend ?? null;
  const empty = replayEmptyLine(agent);
  // No backend, no fetch: the log is per install, and another agent's calls are not this agent's traffic.
  const fn = useCallback(() => (backend ? api.gatewayReplay(version, readSource(runId), backend) : Promise.resolve(null)), [runId, version, backend]);
  const { data, error } = usePoll(fn, 30_000);
  const rows = data ? replayRows(data) : [];
  const Caret = open ? CaretDown : CaretRight;
  return (
    <div className="shrink-0 border-t border-[var(--border)]">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex h-9 w-full items-center justify-between px-4 text-[12.5px] text-[var(--muted)] outline-offset-[-2px] transition-[color,background-color] duration-150 hover:bg-[var(--hover)] hover:text-[var(--fg)]">
        <span className="flex items-center gap-2">
          <Caret size={11} className="text-[var(--faint)]" aria-hidden />
          {replayTitle(data)}
        </span>
        {data && data.calls > 0 && <span className="tabular text-[var(--faint)]">would block {data.would_block}</span>}
      </button>
      {open && (
        <div className="max-h-[40vh] overflow-y-auto px-4 pb-4">
          {empty ? (
            <p className="text-[12.5px] text-[var(--faint)]">{empty}</p>
          ) : error ? (
            <p className="text-[12.5px] text-[var(--faint)]">Replay is not available yet.</p>
          ) : !data ? (
            <p className="text-[12.5px] text-[var(--faint)]">Loading…</p>
          ) : data.calls === 0 ? (
            <p className="text-[12.5px] text-[var(--faint)]">No real calls logged for this backend yet. Run the gateway in front of your agent and this fills in.</p>
          ) : (
            <div className="flex flex-col gap-4">
              <p className="text-[13px] text-[var(--fg)]">{replayLine(data)}</p>
              <ul className="flex flex-col gap-2">
                {rows.map((r) => (
                  <li key={r.tool} className="flex items-center gap-3 text-[12.5px]">
                    <span className="code w-[180px] shrink-0 truncate text-[var(--muted)]">{r.tool}</span>
                    <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-[var(--inset)]">
                      <span className="block h-full rounded-full bg-[var(--fg)]" style={{ width: `${Math.round(r.frac * 100)}%` }} />
                    </span>
                    <span className="tabular w-[72px] shrink-0 text-right text-[var(--faint)]">
                      {r.wouldBlock}/{r.calls}
                    </span>
                  </li>
                ))}
              </ul>
              {data.samples.length > 0 && (
                <ul className="divide-y divide-[var(--border)] border-t border-[var(--border)]">
                  {data.samples.map((s, i) => (
                    <li key={`${s.at}-${i}`} className="flex items-center gap-4 py-2 text-[12.5px]">
                      <span className="code min-w-0 flex-1 truncate text-[var(--fg)]" title={JSON.stringify(s.args)}>
                        {s.tool}({Object.keys(s.args).join(", ")})
                      </span>
                      <span className="hidden min-w-0 max-w-[280px] truncate text-[var(--muted)] sm:inline">{s.reason}</span>
                      <span className="tabular w-[64px] shrink-0 text-right text-[var(--faint)]">{fmtTimeShort(s.at)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Pure templates per framework and tool (plan 10 B2): a starting point, not a verified integration. */
function Snippets({ cfg, agentId }: { cfg: AgentConfig; agentId: string | null }) {
  const tools = ruledTools(cfg);
  const [framework, setFramework] = useState<Framework>("openai-agents");
  const [tool, setTool] = useState<string | null>(null);
  const shownTool = tool && tools.includes(tool) ? tool : tools[0] ?? null;

  // The class comes from the agent's tool proposal; the built-in agent has none, so the snippet says "unclassified".
  const classesFn = useCallback(() => (agentId ? api.agentTools(agentId).catch(() => null) : Promise.resolve(null)), [agentId]);
  const { data: proposal } = usePoll(classesFn, 0);

  const rule: ToolRule | null = shownTool ? cfg.tool_policy.tool_rules?.[shownTool] ?? null : null;
  if (!shownTool || !rule) return <p className="px-4 py-6 text-center text-[12px] text-[var(--faint)]">This version carries no tool rules, so there is nothing to translate.</p>;
  const text = ruleSnippet(shownTool, rule, framework, proposal?.classes[shownTool]);
  return (
    <div className="flex flex-col gap-3 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-1">
          {FRAMEWORKS.map((f) => (
            <button key={f.id} type="button" onClick={() => setFramework(f.id)} aria-pressed={framework === f.id} className={cn("rounded-md px-2.5 py-1 text-[12.5px] transition-colors", framework === f.id ? "bg-[var(--hover)] text-[var(--fg)]" : "text-[var(--muted)] hover:text-[var(--fg)]")}>
              {f.label}
            </button>
          ))}
        </div>
        <CopyButton text={text} />
      </div>
      {tools.length > 1 && (
        <div className="flex flex-wrap items-center gap-1">
          {tools.map((t) => (
            <button key={t} type="button" onClick={() => setTool(t)} aria-pressed={t === shownTool} className={cn("code rounded-md px-2 py-0.5 text-[12px] transition-colors", t === shownTool ? "bg-[var(--hover)] text-[var(--fg)]" : "text-[var(--faint)] hover:text-[var(--fg)]")}>
              {t}
            </button>
          ))}
        </div>
      )}
      <pre className="code max-h-[360px] overflow-auto whitespace-pre-wrap break-words text-[12px] leading-[1.6] text-[var(--muted)]">{text}</pre>
      {rule.requires_user_intent && (
        <p className="text-[12px] text-[var(--faint)]">
          Intent words for <span className="code">{shownTool}</span>: {intentWords(shownTool, rule).join(", ") || "none"}
        </p>
      )}
      <p className="text-[11.5px] text-[var(--faint)]">A starting point — read before you paste.</p>
    </div>
  );
}
