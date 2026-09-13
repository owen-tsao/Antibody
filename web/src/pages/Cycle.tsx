import { motion, useReducedMotion } from "framer-motion";
import { ArrowUpRight } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { api, type CycleRecord } from "@/api";
import BackLink from "@/components/BackLink";
import ConfigDiff from "@/components/ConfigDiff";
import { usePoll } from "@/hooks/usePoll";
import { cycleSteps, fmtTime, humanizeKind } from "@/lib/derive";
import { CHART_H, CHART_W, cycleChartSvg } from "@/lib/previewSvg";
import { cn } from "@/lib/utils";

// One cycle, full page. Left: the five steps as short rows, each a plain-language headline and one
// line of what happened. Right: the gate history chart, drawn at the exact size of the left list so
// the two columns share top and bottom edges. Below: the config diff, when the config changed.

const LEGIT_SIZE = 3;

export default function Cycle({
  n,
  onBack,
  onCycle,
}: {
  n: number;
  onBack: () => void;
  onCycle: (n: number) => void;
}) {
  const { data: cycles, error } = usePoll(api.cycles, 10_000);
  const reduced = useReducedMotion();
  const r = cycles?.find((c) => c.cycle === n);

  const idx = cycles && r ? cycles.indexOf(r) : -1;
  const prev = idx > 0 ? cycles![idx - 1] : undefined;
  const next = cycles && idx >= 0 && idx < cycles.length - 1 ? cycles[idx + 1] : undefined;

  return (
    <main className="min-h-full px-6 pb-20 pt-20 md:px-10 md:pt-24">
      <BackLink onClick={onBack} label="Back to results" />
      <motion.div
        className="mx-auto w-full max-w-6xl"
        initial={reduced ? false : { opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3, ease: [0.2, 0.65, 0.3, 0.9] }}
      >
        {!cycles ? (
          <p className="text-[13px] text-[var(--faint)]">{error ? "api unreachable" : "loading…"}</p>
        ) : !r ? (
          <p className="text-[13px] text-[var(--faint)]">cycle {n} has no record</p>
        ) : (
          <>
            <Header r={r} />
            <Body key={r.cycle} r={r} all={cycles} />

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
    </main>
  );
}

function Header({ r }: { r: CycleRecord }) {
  const evalUrls = r.gate?.weave_eval_urls ?? [];
  const evalUrl = evalUrls.at(-1);
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
        {(r.weave_call_url || evalUrl) && (
          <div className="flex items-center gap-5">
            {r.weave_call_url && (
              <a href={r.weave_call_url} target="_blank" rel="noreferrer" className={link}>
                <span className="u-line">Trace in Weave</span> <ArrowUpRight className={arrow} strokeWidth={1.75} />
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
                <span className="u-line">Gate evaluation</span> <ArrowUpRight className={arrow} strokeWidth={1.75} />
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
// the screen (matches the page's top padding), and the margin kept under it.
const STICKY_TOP_PX = 96;
const STICKY_BOTTOM_PX = 24;
const CHART_MIN_H = 288;
// How long the reveal runs; after this the animation class comes off so resizes do not replay it.
const REVEAL_MS = 1400;

function Body({ r, all }: { r: CycleRecord; all: CycleRecord[] }) {
  const steps = cycleSteps(r, LEGIT_SIZE);
  const changed = r.config_before !== r.config_after;
  const reduced = useReducedMotion();

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
            <ConfigDiff cycle={r} collapseAt={6} onSettled={settle} />
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
          dangerouslySetInnerHTML={{ __html: cycleChartSvg(r, all, LEGIT_SIZE, { w: Math.max(1, size.w), h: Math.max(1, size.h - 2) }) }}
        />
      </div>
    </motion.div>
  );
}
