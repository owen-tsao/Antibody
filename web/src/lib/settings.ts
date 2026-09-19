// Run settings for a start form (docs/plans/02-run-settings-and-history.md, A2; Block 3.4 adds `untilQuiet`
// and `target`). Every field maps to a flag `chaos.loop run` already has; the API contract is `LoopStartBody`
// in api.ts. No flag, no field.

import type { LoopStartBody, World } from "@/api";

export type { World };

export interface RunSettings {
  /** `--seeds N`; null = all seeds (the CLI default). */
  seeds: number | null;
  /** `--chaos-cycles N`. */
  chaosCycles: number;
  /** `--repair-attempts N`. */
  repairAttempts: number;
  /** false → `--no-second-pass`. */
  secondPass: boolean;
  /** `--until-quiet N`: stop once N chaos attacks in a row are blocked; `chaosCycles` becomes the cap. null = off. */
  untilQuiet: number | null;
  /** "mock" → `ANTIBODY_NO_ZENDESK=1` in the loop's environment. Not in the fields any more; the API default `auto` is right. */
  world: World;
  /** The agent to attack (an id from GET /api/agents); null = the API's own default. */
  target: string | null;
}

// Bounds are A1's `Field(ge=, le=)`; `SEEDS.max` is the API's cap when the manifest cannot say how many
// seeds exist (it can, and the fields use that smaller number).
export const CHAOS_CYCLES = { min: 0, max: 10 } as const;
export const SEEDS = { min: 0, max: 10 } as const;
export const REPAIR_ATTEMPTS = { min: 1, max: 5 } as const;
export const UNTIL_QUIET = { min: 1, max: 10 } as const;

/** Mirrors the CLI's own defaults (chaos/loop.py) and A1's Pydantic defaults. */
export const DEFAULT_SETTINGS: RunSettings = {
  seeds: null,
  chaosCycles: 3,
  repairAttempts: 3,
  secondPass: true,
  untilQuiet: null,
  world: "auto",
  target: null,
};

export const SETTINGS_KEY = "antibody.settings.v1";

// The one constant behind "about N minutes". Measured on the golden run recorded 2026-09-13: six cycles
// (two seeds, chaos, one second-pass retry) in 452 s of `data/golden/status_log.jsonl` (`t_rel` of its
// last row) → 75 s per cycle. Repair attempts and the second pass only cost time when attacks land, so
// they are not in the estimate; it is a floor, and says so with "about".
export const MINUTES_PER_CYCLE = 1.25;

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  if (typeof v !== "number" || !Number.isInteger(v)) return fallback;
  return Math.min(max, Math.max(min, v));
}

/** Coerce anything (a parsed localStorage value, an old schema) into a valid RunSettings. Unknown keys are dropped. */
export function normalizeSettings(raw: unknown): RunSettings {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_SETTINGS };
  const r = raw as Record<string, unknown>;
  const chaosCycles = clampInt(r.chaosCycles, CHAOS_CYCLES.min, CHAOS_CYCLES.max, DEFAULT_SETTINGS.chaosCycles);
  return {
    seeds: r.seeds === null ? null : clampInt(r.seeds, SEEDS.min, SEEDS.max, DEFAULT_SETTINGS.seeds ?? 0),
    chaosCycles,
    repairAttempts: clampInt(r.repairAttempts, REPAIR_ATTEMPTS.min, REPAIR_ATTEMPTS.max, DEFAULT_SETTINGS.repairAttempts),
    secondPass: typeof r.secondPass === "boolean" ? r.secondPass : DEFAULT_SETTINGS.secondPass,
    // The API rejects `until_quiet` above `chaos_cycles` (400), so the cap is enforced here too.
    untilQuiet: typeof r.untilQuiet === "number" && chaosCycles > 0 ? clampInt(r.untilQuiet, UNTIL_QUIET.min, Math.min(UNTIL_QUIET.max, chaosCycles), 1) : null,
    // `world` has no field any more; a "mock" persisted by an older build must not keep steering runs unseen.
    world: "auto",
    target: typeof r.target === "string" && r.target ? r.target : null,
  };
}

export function loadSettings(): RunSettings {
  try {
    const text = window.localStorage.getItem(SETTINGS_KEY);
    return text ? normalizeSettings(JSON.parse(text)) : { ...DEFAULT_SETTINGS };
  } catch {
    // Private mode, quota, or a hand-edited value that is not JSON: run with the defaults.
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(s: RunSettings): void {
  try {
    window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {
    // Storage unavailable: the settings still apply to this page load.
  }
}

/** Whether the fields a person can edit are at their defaults; `target` is a choice, not a setting, and is not compared. */
export function isDefaultSettings(s: RunSettings): boolean {
  return (
    s.seeds === DEFAULT_SETTINGS.seeds &&
    s.chaosCycles === DEFAULT_SETTINGS.chaosCycles &&
    s.repairAttempts === DEFAULT_SETTINGS.repairAttempts &&
    s.secondPass === DEFAULT_SETTINGS.secondPass &&
    s.untilQuiet === DEFAULT_SETTINGS.untilQuiet &&
    s.world === DEFAULT_SETTINGS.world
  );
}

/** The POST /api/loop/start body for these settings. */
export function toStartBody(s: RunSettings): LoopStartBody {
  return {
    chaos_cycles: s.chaosCycles,
    seeds: s.seeds,
    repair_attempts: s.repairAttempts,
    second_pass: s.secondPass,
    until_quiet: s.untilQuiet,
    world: s.world,
    target: s.target,
  };
}

/**
 * Cycles the run will attempt: seeds (all → `seedCount`, or the API cap when unknown; `--seeds N` past the
 * count just runs them all) plus chaos cycles. 0 means A1 answers 400 "nothing to run". With `untilQuiet`
 * set this is a ceiling, not a plan.
 */
export function plannedCycles(s: RunSettings, seedCount: number | null): number {
  const available = seedCount ?? SEEDS.max;
  const seeds = s.seeds === null ? available : Math.min(s.seeds, available);
  return seeds + s.chaosCycles;
}

/** "about 4 minutes" / "at most 4 minutes" (until-quiet on) / "about a minute" / "nothing to run". */
export function estimateLabel(s: RunSettings, seedCount: number | null): string {
  const cycles = plannedCycles(s, seedCount);
  if (cycles === 0) return "nothing to run";
  const minutes = Math.round(cycles * MINUTES_PER_CYCLE);
  const qualifier = s.untilQuiet !== null ? "at most" : "about";
  return minutes <= 1 ? `${qualifier} a minute` : `${qualifier} ${minutes} minutes`;
}
