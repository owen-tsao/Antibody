import { motion, useReducedMotion } from "framer-motion";
import { ArrowLeft, ArrowRight } from "lucide-react";

import { MetalFrame } from "@/components/ui/liquid-metal-border";
import { cn } from "@/lib/utils";

// Fixed circular controls in the page corners. Back sits top-left on every page after the intro;
// Forward sits top-right and is only rendered when the caller says there is somewhere to go.
// Each is a black disc in a liquid-metal rim (ui/liquid-metal-border); `light` (on the gradient
// pages) and `dark` (black tool pages) only differ in the icon's resting colour.

interface Props {
  onClick: () => void;
  label: string;
  tone?: "light" | "dark";
}

const frame = "fixed top-6 z-20 h-9 w-9 md:top-8";
const button =
  "flex h-full w-full items-center justify-center rounded-full transition-colors duration-150 focus-visible:outline-white";
const tones = {
  light: "text-white/80 hover:text-white",
  dark: "text-[var(--muted)] hover:text-[var(--fg)]",
};

export default function BackLink({ onClick, label, tone = "dark" }: Props) {
  return (
    <MetalFrame radius={9999} className={cn(frame, "left-6 md:left-8")} innerClassName="h-[calc(100%-3px)]">
      <button type="button" onClick={onClick} aria-label={label} title={label} className={cn(button, tones[tone])}>
        <ArrowLeft className="h-4 w-4" strokeWidth={1.75} />
      </button>
    </MetalFrame>
  );
}

export function ForwardLink({ onClick, label, tone = "dark" }: Props) {
  const reduced = useReducedMotion();
  return (
    <motion.div
      initial={reduced ? { opacity: 0 } : { opacity: 0, x: 12, scale: 0.9 }}
      animate={{ opacity: 1, x: 0, scale: 1 }}
      exit={reduced ? { opacity: 0 } : { opacity: 0, x: 12, scale: 0.9 }}
      transition={{ type: "spring", stiffness: 320, damping: 24 }}
      className={cn(frame, "right-6 md:right-8")}
    >
      <MetalFrame radius={9999} className="h-full w-full" innerClassName="h-[calc(100%-3px)]">
        <button type="button" onClick={onClick} aria-label={label} title={label} className={cn(button, tones[tone])}>
          <ArrowRight className="h-4 w-4" strokeWidth={1.75} />
        </button>
      </MetalFrame>
    </motion.div>
  );
}
