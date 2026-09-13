import { motion, useReducedMotion } from "framer-motion";
import { ArrowLeft, ArrowRight } from "lucide-react";

import { cn } from "@/lib/utils";

// Fixed circular controls in the page corners. Back sits top-left on every page after the intro;
// Forward sits top-right and is only rendered when the caller says there is somewhere to go.
// `light` sits on the gradient (intro/heal), `dark` on the black tool pages.

interface Props {
  onClick: () => void;
  label: string;
  tone?: "light" | "dark";
}

const base =
  "fixed top-6 z-20 flex h-9 w-9 items-center justify-center rounded-full border transition-colors duration-150 md:top-8";
const tones = {
  light: "border-white/40 text-white hover:border-white/70 hover:bg-white/10",
  dark: "border-[var(--border-2)] text-[var(--muted)] hover:border-white/30 hover:text-[var(--fg)]",
};

export default function BackLink({ onClick, label, tone = "dark" }: Props) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className={cn(base, "left-6 md:left-8", tones[tone])}
    >
      <ArrowLeft className="h-4 w-4" strokeWidth={1.75} />
    </button>
  );
}

export function ForwardLink({ onClick, label, tone = "dark" }: Props) {
  const reduced = useReducedMotion();
  return (
    <motion.button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      initial={reduced ? { opacity: 0 } : { opacity: 0, x: 12, scale: 0.9 }}
      animate={{ opacity: 1, x: 0, scale: 1 }}
      exit={reduced ? { opacity: 0 } : { opacity: 0, x: 12, scale: 0.9 }}
      transition={{ type: "spring", stiffness: 320, damping: 24 }}
      className={cn(base, "right-6 md:right-8", tones[tone])}
    >
      <ArrowRight className="h-4 w-4" strokeWidth={1.75} />
    </motion.button>
  );
}
