// Display preferences (docs/plans/07-app-rework.md §10): how the app behaves on this machine, not what a run
// does. They are deliberately not `RunSettings` — every field there is a `chaos.loop run` flag, and none of
// these are. Persisted under their own key; read through `PrefsContext` so `usePoll`, the replay start and
// every motion read see one value.

import { createContext, useContext } from "react";

export const REPLAY_SPEEDS = [1, 2, 3, 5] as const;
export type ReplaySpeed = (typeof REPLAY_SPEEDS)[number];

export const POLL_CADENCES = { normal: 1, slow: 3 } as const;
export type PollCadence = keyof typeof POLL_CADENCES;

/** `system` follows the OS setting; the other two override it either way. */
export const MOTION_PREFS = ["system", "reduced", "full"] as const;
export type MotionPref = (typeof MOTION_PREFS)[number];

export interface Prefs {
  /** The rate "watch it back" starts a tape at. 3× plays the golden run in about five minutes. */
  replaySpeed: ReplaySpeed;
  /** `slow` triples every poll interval — for a laptop on battery or an API across a slow link. */
  pollCadence: PollCadence;
  motion: MotionPref;
}

export const DEFAULT_PREFS: Prefs = { replaySpeed: 3, pollCadence: "normal", motion: "system" };

const PREFS_KEY = "antibody.prefs.v1";

function normalizePrefs(raw: unknown): Prefs {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_PREFS };
  const r = raw as Record<string, unknown>;
  return {
    replaySpeed: (REPLAY_SPEEDS as readonly number[]).includes(r.replaySpeed as number) ? (r.replaySpeed as ReplaySpeed) : DEFAULT_PREFS.replaySpeed,
    pollCadence: r.pollCadence === "slow" ? "slow" : "normal",
    motion: (MOTION_PREFS as readonly string[]).includes(r.motion as string) ? (r.motion as MotionPref) : DEFAULT_PREFS.motion,
  };
}

export function loadPrefs(): Prefs {
  try {
    const text = window.localStorage.getItem(PREFS_KEY);
    return text ? normalizePrefs(JSON.parse(text)) : { ...DEFAULT_PREFS };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

export function savePrefs(p: Prefs): void {
  try {
    window.localStorage.setItem(PREFS_KEY, JSON.stringify(p));
  } catch {
    // Storage unavailable: the preferences still apply to this page load.
  }
}

export function isDefaultPrefs(p: Prefs): boolean {
  return p.replaySpeed === DEFAULT_PREFS.replaySpeed && p.pollCadence === DEFAULT_PREFS.pollCadence && p.motion === DEFAULT_PREFS.motion;
}

/** Provided once in `main.tsx`; the default lets a component render outside the provider (tests, spikes) with the defaults. */
export const PrefsContext = createContext<{ prefs: Prefs; setPrefs: (next: Prefs) => void }>({ prefs: DEFAULT_PREFS, setPrefs: () => undefined });

export function usePrefs() {
  return useContext(PrefsContext);
}
