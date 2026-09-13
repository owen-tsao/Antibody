import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useState } from "react";

import CycleTimeline from "@/components/CycleTimeline";
import { fmtTime, type CycleResult, type CycleView } from "@/lib/derive";
import { cn } from "@/lib/utils";

// One cycle at a time. Tabs along the top pick a cycle; while the loop runs the box follows the
// newest cycle unless the user has picked an older one, in which case a quiet notice offers the
// jump instead of yanking the view. Cycle changes slide in from the side the reader is moving.

const RESULT_DOT: Record<CycleResult, string> = {
  running: "var(--fg)",
  blocked: "var(--live)",
  repaired: "var(--live)",
  unfixed: "var(--danger)",
  failed: "var(--danger)",
};

export default function CyclesBox({ views }: { views: CycleView[] }) {
  const reduced = useReducedMotion();
  const newest = views[0]?.cycle ?? null;
  const [picked, setPicked] = useState<number | null>(null);

  // `picked === null` means "follow the newest".
  const current = picked !== null ? views.find((v) => v.cycle === picked) ?? views[0] : views[0];

  // Direction of travel, derived during render (not in an effect) so it is right on the very
  // render in which the key changes. AnimatePresence passes it to the exiting panel via `custom`,
  // since that panel's own props are frozen from its last render.
  const [shown, setShown] = useState<number | null>(current?.cycle ?? null);
  const [dir, setDir] = useState<1 | -1>(1);
  if (current && shown !== current.cycle) {
    if (shown !== null) setDir(current.cycle > shown ? 1 : -1);
    setShown(current.cycle);
  }

  if (!current) return null;
  // A tab the user picked that has since vanished (replay seeked backwards) shows the newest, so it
  // must not also offer "latest →".
  const behind = picked !== null && newest !== null && newest !== picked && views.some((v) => v.cycle === picked);

  return (
    <section className="rounded-lg border border-[var(--border)]">
      <div className="flex items-center justify-between gap-4 border-b border-[var(--border)] px-3 py-2">
        <CycleTabs
          views={views}
          current={current.cycle}
          onPick={(c) => setPicked(c === newest ? null : c)}
        />
        <AnimatePresence>
          {behind && (
            <motion.button
              type="button"
              initial={{ opacity: 0, x: 6 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0 }}
              onClick={() => setPicked(null)}
              className="mr-1 whitespace-nowrap text-[12px] text-[var(--muted)] hover:text-[var(--fg)]"
            >
              latest →
            </motion.button>
          )}
        </AnimatePresence>
      </div>

      <div className="relative overflow-hidden">
        <AnimatePresence mode="wait" initial={false} custom={dir}>
          <motion.div
            key={current.cycle}
            custom={dir}
            variants={{
              enter: (d: number) => (reduced ? { opacity: 0 } : { opacity: 0, x: 32 * d }),
              center: { opacity: 1, x: 0 },
              exit: (d: number) => (reduced ? { opacity: 0 } : { opacity: 0, x: -24 * d }),
            }}
            initial="enter"
            animate="center"
            exit="exit"
            transition={{ duration: 0.28, ease: [0.2, 0.65, 0.3, 0.9] }}
            className="px-8 pb-8 pt-7"
          >
            <header className="flex flex-wrap items-start justify-between gap-x-8 gap-y-2">
              <div className="min-w-0 flex-1">
                <div className="tabular flex flex-wrap items-center gap-x-2.5 text-[12px] text-[var(--faint)]">
                  <span>{current.name}</span>
                  {current.kind && (
                    <>
                      <span>·</span>
                      <span>{current.kind}</span>
                    </>
                  )}
                  {current.timestamp && (
                    <>
                      <span>·</span>
                      <span>{fmtTime(current.timestamp)}</span>
                    </>
                  )}
                </div>
                <h2 className="mt-1.5 max-w-[46ch] text-[18px] font-medium leading-snug tracking-[-0.01em]">
                  {current.title}
                </h2>
                {current.message && (
                  <p className="mt-2 max-w-[64ch] text-[13px] leading-[1.6] text-[var(--muted)]">“{current.message}”</p>
                )}
              </div>
              <div className="tabular flex shrink-0 items-center gap-3 pt-0.5 text-[13px]">
                <span className="flex items-center gap-2 text-[var(--muted)]">
                  <span className="h-1.5 w-1.5 rounded-full" style={{ background: RESULT_DOT[current.result] }} />
                  {current.result}
                </span>
                <span className="text-[var(--faint)]">·</span>
                <span className="text-[var(--fg)]">{current.versions}</span>
              </div>
            </header>

            <div className="mt-7 border-t border-[var(--border)] pt-7">
              <CycleTimeline steps={current.steps} />
            </div>
          </motion.div>
        </AnimatePresence>
      </div>
    </section>
  );
}

// Oldest -> newest, so reading order matches time. The active tab, and the one under the pointer,
// expand from `7` to `cycle 7`; the others stay as bare numbers. The word's width animates from 0,
// which is what moves the neighbours, so no layout animation is needed on the buttons. The live
// cycle is not marked on its tab: the box's own header and the active node already say so.
function CycleTabs({
  views,
  current,
  onPick,
}: {
  views: CycleView[];
  current: number;
  onPick: (cycle: number) => void;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const reduced = useReducedMotion();
  return (
    <ol className="flex flex-wrap items-center gap-0.5">
      {[...views].reverse().map((v) => {
        const active = v.cycle === current;
        const wide = active || hover === v.cycle;
        return (
          <li key={v.cycle}>
            <button
              type="button"
              onClick={() => onPick(v.cycle)}
              onMouseEnter={() => setHover(v.cycle)}
              onMouseLeave={() => setHover(null)}
              onFocus={() => setHover(v.cycle)}
              onBlur={() => setHover(null)}
              aria-current={active ? "true" : undefined}
              aria-label={`cycle ${v.cycle}`}
              className={cn(
                "tabular relative flex h-7 items-center whitespace-nowrap rounded-md px-2.5 text-[12px] transition-colors duration-150",
                active ? "bg-[var(--inset)] text-[var(--fg)]" : "text-[var(--faint)] hover:text-[var(--fg)]",
              )}
            >
              <AnimatePresence initial={false}>
                {wide && (
                  <motion.span
                    key="word"
                    initial={reduced ? false : { opacity: 0, width: 0 }}
                    animate={{ opacity: 1, width: "auto" }}
                    exit={reduced ? undefined : { opacity: 0, width: 0 }}
                    transition={{ duration: 0.16 }}
                    className="overflow-hidden"
                  >
                    cycle&nbsp;
                  </motion.span>
                )}
              </AnimatePresence>
              {v.cycle}
            </button>
          </li>
        );
      })}
    </ol>
  );
}
