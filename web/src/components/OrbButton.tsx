import { motion, useReducedMotion, type HTMLMotionProps } from "framer-motion";

import { MetalFrame } from "@/components/ui/liquid-metal-border";
import { cn } from "@/lib/utils";

// The splash pages' one control: a white disc in a liquid-metal rim that paints black on hover while
// its content lifts on a spring (the overshoot is the "bump"). Used for the intro's arrow and the
// Heal page's word. `group` on the button lets the inner disc react to hover; the rim speeds up on
// its own (ui/liquid-metal-border).
export default function OrbButton({
  className,
  children,
  lift = { x: 0, y: -2 },
  ...props
}: HTMLMotionProps<"button"> & {
  children: React.ReactNode;
  /** Direction the content nudges on hover; the arrow lifts along its own diagonal. */
  lift?: { x: number; y: number };
}) {
  const reduced = useReducedMotion();
  // Softer spring: less overshoot, so the bump reads as a nudge rather than a jump.
  const spring = { type: "spring", stiffness: 380, damping: 22, mass: 0.7 } as const;

  return (
    <motion.button
      type="button"
      initial="rest"
      whileHover={reduced ? undefined : "hover"}
      whileTap="tap"
      variants={{
        rest: { scale: 1 },
        hover: { scale: 1.03, transition: spring },
        tap: { scale: 0.97, transition: { duration: 0.1 } },
      }}
      className={cn("group relative rounded-full shadow-[0_8px_40px_rgba(0,0,0,0.25)] focus-visible:outline-white", className)}
      {...props}
    >
      <MetalFrame
        radius={9999}
        thickness={2}
        className="h-full w-full"
        innerClassName="flex h-[calc(100%-4px)] items-center justify-center bg-white text-black transition-colors duration-200 ease-out group-hover:bg-black group-hover:text-white"
      >
        <motion.span
          className="flex items-center justify-center"
          variants={{
            rest: { x: 0, y: 0, transition: spring },
            hover: { x: lift.x, y: lift.y, transition: spring },
            tap: { x: lift.x * 0.5, y: lift.y * 0.5, transition: { duration: 0.1 } },
          }}
        >
          {children}
        </motion.span>
      </MetalFrame>
    </motion.button>
  );
}
