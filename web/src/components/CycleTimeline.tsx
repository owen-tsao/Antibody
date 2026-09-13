import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { Check, ChevronRight, Minus, X } from "lucide-react";
import { useEffect, useState } from "react";

import type { StepView, SubItem } from "@/lib/derive";
import { cn } from "@/lib/utils";

// One cycle as a vertical timeline: five agent nodes on a hairline, each with what it did and a
// sub-timeline of the concrete actions (tool calls, faults, gate criteria). The active node is a
// slowly turning dashed ring with an elapsed timer anchored to the step's real start time.
//
// Density is managed in two ways. The visible evidence under a step is short by construction
// (derive.ts picks the artifact, not the reasoning) and clamps at two lines. Anything long — the
// target's full reply, the repair model's rationale — sits behind a closed disclosure, so the
// default view is the story and the paragraphs are one click away.

export default function CycleTimeline({ steps, expanded = false }: { steps: StepView[]; expanded?: boolean }) {
  const reduced = useReducedMotion();
  return (
    <ol className="relative">
      {steps.map((s, i) => {
        const last = i === steps.length - 1;
        const quiet = s.state === "pending" || s.state === "skipped";
        const line = stripAgent(s.headline, s.label) || (s.state === "pending" ? "waiting" : "");
        return (
          <motion.li
            key={s.step}
            initial={reduced ? false : { opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.25, delay: i * 0.04 }}
            className="relative grid grid-cols-[1.25rem_1fr] gap-x-5"
          >
            {/* Spine segment below this node. Filled once the node is done; hairline otherwise. */}
            {!last && (
              <span
                aria-hidden
                className={cn(
                  "absolute bottom-0 left-[9px] top-6 w-px",
                  s.state === "done" || s.state === "failed" || s.state === "skipped"
                    ? "bg-[var(--border-2)]"
                    : "bg-[var(--border)]",
                )}
              />
            )}
            <Node state={s.state} />
            <div className={cn("min-w-0 pb-8", last && "pb-0", quiet && "opacity-50")}>
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 pt-px">
                <span className="text-[13px] font-medium text-[var(--fg)]">{s.label}</span>
                <span
                  className={cn(
                    "text-[13px]",
                    s.state === "failed" ? "text-[var(--danger)]" : "text-[var(--muted)]",
                    s.step === "gate" && s.state === "done" && /accepted/i.test(s.headline) && "text-[var(--live)]",
                  )}
                >
                  {line}
                </span>
                {s.state === "active" && s.since && <Elapsed since={s.since} />}
              </div>

              {s.evidence && !quiet && <Clamped text={s.evidence} expanded={expanded} />}

              {s.children && s.children.length > 0 && <SubTimeline items={s.children} />}

              {s.detail && !quiet && <Disclosure label={s.detail.label} text={s.detail.text} open={expanded} />}
            </div>
          </motion.li>
        );
      })}
    </ol>
  );
}

/** `Judge failed the target · llm` -> `failed the target · llm`, since the label already says Judge. */
function stripAgent(headline: string, label: string): string {
  if (headline === label) return "";
  return headline.startsWith(label + " ") ? headline.slice(label.length + 1) : headline;
}

function Node({ state }: { state: StepView["state"] }) {
  const reduced = useReducedMotion();
  const base = "relative z-10 mt-0.5 flex h-5 w-5 items-center justify-center rounded-full";
  if (state === "done") {
    return (
      <motion.span
        className={cn(base, "bg-[var(--fg)] text-[var(--bg)]")}
        initial={reduced ? false : { scale: 0.7 }}
        animate={{ scale: 1 }}
        transition={{ type: "spring", stiffness: 420, damping: 22 }}
      >
        <Check className="h-3 w-3" strokeWidth={2.5} />
      </motion.span>
    );
  }
  if (state === "failed") {
    return (
      <span className={cn(base, "border border-[var(--danger)] text-[var(--danger)]")}>
        <X className="h-3 w-3" strokeWidth={2.5} />
      </span>
    );
  }
  if (state === "active") {
    return (
      <span className={cn(base, "bg-[var(--bg)]")}>
        <motion.span
          className="absolute inset-0 rounded-full border border-dashed border-[var(--fg)]"
          animate={reduced ? undefined : { rotate: 360 }}
          transition={{ duration: 6, ease: "linear", repeat: Infinity }}
        />
        <span className="h-1.5 w-1.5 rounded-full bg-[var(--fg)]" />
      </span>
    );
  }
  if (state === "skipped") {
    return (
      <span className={cn(base, "border border-[var(--border)] text-[var(--faint)]")}>
        <Minus className="h-3 w-3" strokeWidth={2} />
      </span>
    );
  }
  return <span className={cn(base, "border border-[var(--border-2)] bg-[var(--bg)]")} />;
}

function SubTimeline({ items }: { items: SubItem[] }) {
  return (
    <ol className="mt-3 space-y-2">
      {items.map((it, i) => (
        <li key={i} className="flex items-baseline gap-3 text-[12.5px]">
          <span
            aria-hidden
            className={cn(
              "mt-[6px] h-1.5 w-1.5 shrink-0 self-start rounded-full",
              it.tone === "danger"
                ? "bg-[var(--danger)]"
                : it.tone === "ok"
                  ? "bg-[var(--live)]"
                  : it.tone === "blocked"
                    ? "border border-[var(--border-2)]"
                    : "bg-[var(--border-2)]",
            )}
          />
          <span
            className={cn(
              "min-w-0 break-words",
              it.code && "code text-[12px]",
              it.tone === "danger" ? "text-[var(--danger)]" : "text-[var(--fg)]",
            )}
          >
            {it.label}
          </span>
          {it.detail && <span className="tabular whitespace-nowrap text-[12px] text-[var(--faint)]">{it.detail}</span>}
        </li>
      ))}
    </ol>
  );
}

const CLAMP_CHARS = 180;

function Clamped({ text, expanded }: { text: string; expanded: boolean }) {
  const [open, setOpen] = useState(false);
  const long = !expanded && text.length > CLAMP_CHARS;
  return (
    <p className="mt-1.5 max-w-[68ch] text-[13px] leading-[1.6] text-[var(--muted)]">
      {open || !long ? text : text.slice(0, CLAMP_CHARS).trimEnd() + "…"}
      {long && (
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="ml-1.5 rounded text-[12px] text-[var(--faint)] underline-offset-2 hover:text-[var(--fg)] hover:underline"
        >
          {open ? "less" : "more"}
        </button>
      )}
    </p>
  );
}

/** A closed-by-default paragraph. The trigger is a quiet text row; the body slides open. */
function Disclosure({ label, text, open: initialOpen }: { label: string; text: string; open: boolean }) {
  const [open, setOpen] = useState(initialOpen);
  const reduced = useReducedMotion();
  const isPrompt = label.includes("prompt");
  return (
    <div className="mt-3">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="group -ml-1 flex items-center gap-1 rounded px-1 py-0.5 text-[12px] text-[var(--faint)] transition-colors hover:text-[var(--fg)]"
      >
        <ChevronRight
          className={cn("h-3 w-3 transition-transform duration-200", open && "rotate-90")}
          strokeWidth={2}
        />
        {open ? `hide ${label}` : `show ${label}`}
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            key="body"
            initial={reduced ? false : { height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={reduced ? undefined : { height: 0, opacity: 0 }}
            transition={{ duration: 0.22, ease: [0.2, 0.65, 0.3, 0.9] }}
            className="overflow-hidden"
          >
            <p
              className={cn(
                "mt-2 max-w-[72ch] whitespace-pre-wrap border-l border-[var(--border)] pl-4 leading-[1.65] text-[var(--muted)]",
                isPrompt ? "code text-[12px]" : "text-[13px]",
              )}
            >
              {text}
            </p>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function Elapsed({ since }: { since: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const s = Math.max(0, Math.floor((now - new Date(since).getTime()) / 1000));
  const mm = Math.floor(s / 60);
  const ss = String(s % 60).padStart(2, "0");
  return (
    <span className="tabular text-[12px] text-[var(--faint)]">
      {mm}:{ss}
    </span>
  );
}
