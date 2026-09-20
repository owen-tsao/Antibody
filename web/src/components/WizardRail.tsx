import { motion } from "framer-motion";
import { Check } from "@phosphor-icons/react";

import { useMotionPref } from "@/hooks/useMotionPref";
import { cn } from "@/lib/utils";

/**
 * The step rail from Owen's `wizard-steps` component (component-library, `prompts/wizard-steps-rail-integration.md`),
 * extracted on its own: 28 px rounded tiles, number → check once done, a spring scale on the current tile,
 * connectors whose fill scales in from the left. Adapted to the monochrome tokens, `framer-motion` and Phosphor;
 * the step content, buttons and crossfade panel stayed behind — the wizard page owns those.
 *
 * Steps up to `furthest` are buttons (you can go back to anything you have reached); later ones, and
 * `skipped` ones the chosen path never visits, are inert. A skipped tile keeps its number rather than
 * earning a check, so the rail never claims a step was done.
 */

const RAIL = { type: "spring", stiffness: 520, damping: 40, mass: 0.5 } as const;

export interface WizardRailStep {
  id: string;
  label: string;
}

export default function WizardRail({
  steps,
  index,
  furthest = index,
  skipped = [],
  onGoTo,
  label = "Steps",
  className,
}: {
  steps: WizardRailStep[];
  /** Zero-based current step. */
  index: number;
  /** The highest step reached, so earlier ones stay clickable after going back. */
  furthest?: number;
  /** Zero-based steps the path jumped over; shown as passed but not done, and not clickable. */
  skipped?: number[];
  onGoTo?: (index: number) => void;
  label?: string;
  className?: string;
}) {
  const reduced = useMotionPref();
  const total = steps.length;
  const transition = reduced ? { duration: 0 } : RAIL;

  return (
    <>
      <p aria-live="polite" className="sr-only">
        {`Step ${index + 1} of ${total}: ${steps[index]?.label ?? ""}`}
      </p>
      <ol aria-label={label} className={cn("flex list-none items-center gap-1 p-0", className)}>
        {steps.map((s, i) => {
          const passed = i < index;
          const skip = skipped.includes(i);
          const done = passed && !skip;
          const here = i === index;
          const name = `Step ${i + 1} of ${total}: ${s.label}${skip ? " (skipped)" : ""}`;
          const tile = (
            <motion.span
              aria-hidden
              className={cn(
                "grid size-7 place-items-center rounded-[8px] border text-[11.5px] font-medium tabular-nums transition-colors duration-150",
                done
                  ? "border-[var(--fg)] bg-[var(--fg)] text-[var(--bg)]"
                  : here
                    ? "border-[var(--border-2)] bg-[var(--card)] text-[var(--fg)]"
                    : "border-[var(--border)] bg-[var(--card)] text-[var(--faint)]",
              )}
              initial={false}
              animate={{ scale: here ? 1 : 0.92 }}
              transition={transition}
            >
              {done ? <Check size={12} weight="bold" aria-hidden /> : i + 1}
            </motion.span>
          );
          return (
            <li key={s.id} className="flex items-center gap-1">
              {i <= furthest && !skip && onGoTo ? (
                <button
                  type="button"
                  aria-current={here ? "step" : undefined}
                  aria-label={name}
                  title={s.label}
                  onClick={() => !here && onGoTo(i)}
                  className="rounded-[8px] outline-none focus-visible:shadow-[0_0_0_1.5px_var(--border-2)]"
                >
                  {tile}
                </button>
              ) : (
                <span title={s.label}>
                  <span className="sr-only">{name}</span>
                  {tile}
                </span>
              )}
              {i < total - 1 && (
                <span aria-hidden className="relative h-[3px] w-6 overflow-hidden rounded-[2px] bg-[var(--inset)]">
                  <motion.span
                    className="absolute inset-0 origin-left rounded-[2px] bg-[var(--fg)]"
                    initial={false}
                    animate={{ scaleX: passed ? 1 : 0 }}
                    transition={transition}
                  />
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </>
  );
}
