import { motion } from "framer-motion";
import { ArrowUpRight } from "@phosphor-icons/react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { api, type CycleRecord, type ReadSource } from "@/api";
import ApiDown from "@/components/ApiDown";
import Page from "@/components/Page";
import ConfigDiff from "@/components/ConfigDiff";
import { usePoll } from "@/hooks/usePoll";
import { useMotionPref } from "@/hooks/useMotionPref";
import { cycleSteps, fmtTime, humanizeKind, readSource, runTitle, ticketLink } from "@/lib/derive";
import { CHART_H, CHART_W, cycleChartSvg } from "@/lib/previewSvg";
import { cn } from "@/lib/utils";

// One cycle, full page. Left: the five steps as short rows, each a plain-language headline and one
// line of what happened. Right: the gate history chart, drawn at the exact size of the left list so
// the two columns share top and bottom edges. Below: the config diff, when the config changed.
// Every read names the run (`source`): a history run's cycle is read from that run's files, and a
// tape playing elsewhere cannot change what this page shows.

export default function Cycle({
  id,
  n,
  onBack,
  onCycle,
}: {
  /** The run this cycle belongs to (`live`, `golden` or a history id). */
  id: string;
  n: number;
  onBack: () => void;
  onCycle: (n: number) => void;
}) {
  const source: ReadSource = readSource(id);
  const cyclesFn = useCallback(() => api.cycles(source), [source]);
  const { data: cycles, error, refresh } = usePoll(cyclesFn, 10_000);
  const reduced = useMotionPref();
  const r = cycles?.find((c) => c.cycle === n);

  const idx = cycles && r ? cycles.indexOf(r) : -1;
  const prev = idx > 0 ? cycles![idx - 1] : undefined;
  const next = cycles && idx >= 0 && idx < cycles.length - 1 ? cycles[idx + 1] : undefined;

  return (
    <Page
      eyebrow={
        // The shell's "Runs" goes to the list; the way back to this run is the page's own.
        <button type="button" onClick={onBack} className="rounded transition-colors hover:text-[var(--fg)]">
          {runTitle(id)} /
        </button>
      }
      title={`Cycle ${n}`}
    >
      <motion.div
        initial={reduced ? false : { opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3, ease: [0.2, 0.65, 0.3, 0.9] }}
      >
        {!cycles ? (
          <p className="text-[13px] text-[var(--faint)]">{error ? <ApiDown onRetry={refresh} /> : "loading…"}</p>
        ) : !r ? (
          <p className="text-[13px] text-[var(--faint)]">cycle {n} has no record</p>
        ) : (
          <>
            <Header r={r} />
            <Body key={r.cycle} r={r} all={cycles} source={source} />

            <nav className="mt-14 flex items-center justify-between border-t border-[var(--border)] pt-5 text-[13px]">
              {prev ? (
                <button type="button" onClick={() => onCycle(prev.cycle)} className="tabular rounded text-[var(--muted)] hover:text-[var(--fg)]">
                  ← cycle {prev.cycle}
                </button>
              ) : (
                <span />
              )}
              {next ? (
                <button type="button" onClick={() => onCycle(next.cycle)} className="tabular rounded text-[var(--muted)] hover:text-[var(--fg)]">
                  cycle {next.cycle} →
                </button>
              ) : (
                <span />
              )}
            </nav>
          </>
        )}
      </motion.div>
    </Page>
  );
}

function Header({ r }: { r: CycleRecord }) {
  const evalUrls = r.gate?.weave_eval_urls ?? [];
  const evalUrl = evalUrls.at(-1);
  const ticket = ticketLink(r);
  const link =
    "group inline-flex items-center gap-1 rounded text-[13px] text-[var(--muted)] transition-colors hover:text-[var(--fg)]";
  const arrow = "h-3.5 w-3.5 transition-transform duration-150 group-hover:-translate-y-px group-hover:translate-x-px";

  return (
    <header className="grid gap-x-12 gap-y-4 border-b border-[var(--border)] pb-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
      <div className="min-w-0 max-w-[60ch]">
        <h1 className="text-[28px] font-medium leading-[1.2] tracking-[-0.02em]">{r.scenario.title}</h1>
        <p className="mt-2 text-[14px] leading-[1.6] text-[var(--muted)]">“{r.scenario.user_message}”</p>
      </div>
      <div className="flex flex-col gap-1.5 lg:items-end lg:text-right">
        {(ticket || r.weave_call_url || evalUrl) && (
          <div className="flex items-center gap-5">
            {ticket && (
              <a
                href={ticket.url}
                target="_blank"
                rel="noreferrer"
                className={link}
                title="The real Zendesk ticket this episode worked; the agent's actions and reply are on it as an internal note"
              >
                Ticket #{ticket.id} in Zendesk <ArrowUpRight className={arrow} />
              </a>
            )}
            {r.weave_call_url && (
              <a href={r.weave_call_url} target="_blank" rel="noreferrer" className={link}>
                <span className="u-line">Trace in Weave</span> <ArrowUpRight className={arrow} />
              </a>
            )}
            {evalUrl && (
              <a
                href={evalUrl}
                target="_blank"
                rel="noreferrer"
                className={link}
                title={`${evalUrls.length} gate ${evalUrls.length === 1 ? "evaluation" : "evaluations"} (new, regression, legit); opens the last`}
              >
                Gate evaluation <ArrowUpRight className={arrow} />
              </a>
            )}
          </div>
        )}
        <p className="tabular flex flex-wrap items-center gap-x-2.5 text-[12px] text-[var(--faint)] lg:justify-end">
          <span>cycle {r.cycle}</span>
          <span>·</span>
          <span>{humanizeKind(r.scenario.kind)}</span>
          <span>·</span>
          <span>{fmtTime(r.timestamp)}</span>
          <span>·</span>
          <span>{r.scenario.origin === "chaos_agent" ? "chaos scenario" : `${r.scenario.origin} scenario`}</span>
        </p>
      </div>
    </header>
  );
}

// Distance from the viewport top at which the chart pins when the left column is taller than
// the screen (the page's top padding inside the shell), and the margin kept under it.
const STICKY_TOP_PX = 28;
const STICKY_BOTTOM_PX = 24;
const CHART_MIN_H = 288;
// How long the reveal runs; after this the animation class comes off so resizes do not replay it.
const REVEAL_MS = 1400;

function Body({ r, all, source }: { r: CycleRecord; all: CycleRecord[]; source: ReadSource }) {
  const steps = cycleSteps(r);
  const changed = r.config_before !== r.config_after;
  const reduced = useMotionPref();

  // The chart is as tall as the left column (steps + diff) so the two share top and bottom edges,
  // but never taller than the viewport: past that it caps and sticks, riding beside a long diff
  // instead of stretching into a skyscraper or scrolling away. Height comes from measuring the
  // left column, never the chart itself, so there is no feedback loop.
  //
  // The diff loads asynchronously and changes the column's height when it lands, so the chart
  // waits for it (`ready`) before its first measurement and reveal. Otherwise the reveal would
  // play once at the "loading…" height and again at the real one. A timeout guards a slow API.
  const colRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const sizeRef = useRef({ w: CHART_W, h: CHART_H });
  const [size, setSize] = useState({ w: CHART_W, h: CHART_H });
  const [ready, setReady] = useState(!changed);
  const [revealing, setRevealing] = useState(false);
  const settle = useCallback(() => setReady(true), []);

  useEffect(() => {
    if (ready) return;
    const id = setTimeout(() => setReady(true), 800);
    return () => clearTimeout(id);
  }, [ready]);

  useLayoutEffect(() => {
    if (!ready) return;
    const col = colRef.current;
    const panel = panelRef.current;
    if (!col || !panel) return;

    // Returns whether the size changed.
    const measure = (): boolean => {
      const cap = window.innerHeight - STICKY_TOP_PX - STICKY_BOTTOM_PX;
      const h = Math.round(Math.min(Math.max(col.getBoundingClientRect().height, CHART_MIN_H), Math.max(CHART_MIN_H, cap)));
      const w = panel.clientWidth;
      if (w <= 0 || h <= 0) return false;
      if (sizeRef.current.w === w && sizeRef.current.h === h) return false;
      sizeRef.current = { w, h };
      setSize(sizeRef.current);
      return true;
    };

    measure();
    setRevealing(true);
    const startedAt = performance.now();
    const stop = setTimeout(() => setRevealing(false), REVEAL_MS);

    // Any later size change (diff expanded, window resized) regenerates the SVG, which would
    // restart the CSS animation; end the reveal first so it does not play again.
    const onResize = () => {
      if (measure() && performance.now() - startedAt > 100) setRevealing(false);
    };
    const ro = new ResizeObserver(onResize);
    ro.observe(col);
    ro.observe(panel);
    window.addEventListener("resize", onResize);
    return () => {
      clearTimeout(stop);
      ro.disconnect();
      window.removeEventListener("resize", onResize);
    };
  }, [ready]);

  return (
    <motion.div
      className="mt-5 grid gap-x-12 gap-y-10 lg:grid-cols-2"
      initial={reduced ? false : { opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.28, ease: [0.2, 0.65, 0.3, 0.9] }}
    >
      <div ref={colRef}>
        <ol>
          {steps.map((s, i) => (
            <li
              key={s.step}
              className={cn(
                "grid grid-cols-[2rem_1fr] gap-x-4 py-5 first:pt-0 last:pb-0 [&+&]:border-t [&+&]:border-[var(--border)]",
                s.tone === "skipped" && "opacity-50",
              )}
            >
              <span className="tabular pt-px text-[12px] text-[var(--faint)]">{String(i + 1).padStart(2, "0")}</span>
              <div className="min-w-0">
                <div className="flex flex-wrap items-baseline gap-x-3">
                  <span className="text-[15px] font-medium tracking-[-0.01em]">{s.label}</span>
                  <span
                    className={cn(
                      "text-[13px]",
                      s.tone === "danger" ? "text-[var(--danger)]" : s.tone === "ok" ? "text-[var(--live)]" : "text-[var(--muted)]",
                    )}
                  >
                    {s.headline}
                  </span>
                </div>
                {s.line && <p className="mt-1.5 max-w-[56ch] text-[13px] leading-[1.6] text-[var(--muted)]">{s.line}</p>}
              </div>
            </li>
          ))}
        </ol>

        {changed && (
          <div className="mt-10 border-t border-[var(--border)] pt-5">
            <ConfigDiff cycle={r} source={source} collapseAt={6} onSettled={settle} />
          </div>
        )}
      </div>

      <div className="relative">
        <div
          ref={panelRef}
          className={cn(
            "sticky overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--card)] transition-opacity duration-200 [&>svg]:block",
            !ready && "opacity-0",
            revealing && "chart-animate",
          )}
          style={{ top: STICKY_TOP_PX, height: size.h }}
          // Trusted: generated by this app from its own records (see lib/previewSvg.ts). The SVG
          // is 2px shorter than the panel so it fits inside the 1px border.
          dangerouslySetInnerHTML={{ __html: cycleChartSvg(r, all, { w: Math.max(1, size.w), h: Math.max(1, size.h - 2) }) }}
        />
      </div>
    </motion.div>
  );
}
