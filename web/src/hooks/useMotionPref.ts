import { useReducedMotion } from "framer-motion";

import { usePrefs } from "@/lib/prefs";

/**
 * Whether motion should be reduced right now: the Display preference when it says so either way, else the
 * OS setting (framer's `useReducedMotion`, which tracks the media query live). Every animated component reads
 * this, not `useReducedMotion` directly, so the preference reaches all of them.
 */
export function useMotionPref(): boolean {
  const system = useReducedMotion() ?? false;
  const { prefs } = usePrefs();
  if (prefs.motion === "reduced") return true;
  if (prefs.motion === "full") return false;
  return system;
}
