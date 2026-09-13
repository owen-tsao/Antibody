import { motion, useReducedMotion } from "framer-motion";
import { ArrowUpRight } from "lucide-react";

import OrbButton from "@/components/OrbButton";

export type StartMode = "live" | "replay";

export default function Intro({ onNext }: { onNext: () => void }) {
  const reduced = useReducedMotion();
  const fade = (delay: number) => ({
    initial: { opacity: 0, y: reduced ? 0 : 12 },
    animate: { opacity: 1, y: 0 },
    transition: { duration: 0.7, delay, ease: [0.25, 0.1, 0.25, 1] as const },
  });

  return (
    <section className="relative flex min-h-screen flex-col items-center justify-center overflow-hidden px-6 text-white">
      <motion.h1
        {...fade(0.1)}
        className="display text-center leading-[0.92] tracking-[-0.02em]"
        style={{
          fontSize: "clamp(88px, 15vw, 224px)",
          textShadow: "0 2px 40px rgba(0, 0, 0, 0.35)",
        }}
      >
        Antibody
      </motion.h1>

      <motion.p
        {...fade(0.3)}
        className="mt-6 whitespace-nowrap text-center text-[18px] font-normal text-white sm:text-[20px]"
        style={{ textShadow: "0 1px 14px rgba(0, 0, 0, 0.8), 0 0 2px rgba(0, 0, 0, 0.4)" }}
      >
        Self-healing for AI agents
      </motion.p>

      <motion.div {...fade(0.55)} className="mt-16">
        <OrbButton onClick={onNext} aria-label="Continue" className="h-24 w-24" lift={{ x: 2, y: -2 }}>
          <ArrowUpRight className="h-7 w-7" strokeWidth={1.75} />
        </OrbButton>
      </motion.div>
    </section>
  );
}
