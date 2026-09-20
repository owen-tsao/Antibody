// Everything the UI derives from records. Pure functions; no fetching, no React.
// Rules are the ones in docs/FRONTEND.md §2 "Derived in the frontend, never stored".

import type {
  Agent as AgentRow,
  AgentConfig,
  AgentPing,
  AgentTool,
  CycleRecord,
  GateResult,
  LoopState,
  Manifest,
  Patch,
  PatchKind,
  Phase,
  PingResult,
  ReadSource,
  RecordingInfo,
  ReplayInfo,
  RunRow,
  ScenarioKind,
  State,
  Status,
  ToolCall,
  ToolMapping,
  ToolPolicy,
} from "@/api";
import type { Subtask, Task } from "@/components/ui/agent-plan";
import type { AgentState } from "@/components/ui/orb";

export type RowStatus = "blocked" | "repaired" | "unfixed" | "failed";

export function rowStatus(r: CycleRecord): RowStatus {
  if (!r.attack_succeeded) return "blocked";
  if (r.gate?.accepted) return "repaired";
  if (r.gate) return "unfixed";
  return "failed";
}

type PatchLayer = "tool" | "validator" | "prompt";

function patchLayer(kind: PatchKind): PatchLayer {
  if (kind === "tighten_tool_policy") return "tool";
  if (kind === "add_tool_validator") return "validator";
  return "prompt";
}

export function humanizeKind(kind: ScenarioKind | PatchKind | string): string {
  return kind.replace(/_/g, " ");
}

/** Short attack label for the list's first column. Uses the scenario title's first clause. */
function shortTitle(r: CycleRecord): string {
  return shortTitleOf(r.scenario.title);
}

function shortTitleOf(t: string): string {
  const cut = t.search(/[;:—]| causes | trigger| must /);
  return (cut > 12 ? t.slice(0, cut) : t).trim();
}

function pct(rate: number, size: number): string {
  return `${Math.round(rate * size)}/${size}`;
}

/**
 * How many scenarios the gate's `regression_pass_rate` was scored over. loop.py adds the new
 * failure to the suite before the gate (capture_regression) and then hands the gate the suite
 * *without* it (`[s for s in state.regression_suite if s.id != scenario.id]`), while the record's
 * `regression_suite_size` counts the whole suite. So the rate is over `size - 1` rows; on the first
 * failure that is 0 rows and gate.py reports 1.0 by default.
 */
function regressionDenom(r: CycleRecord): number {
  return r.gate ? Math.max(0, r.regression_suite_size - 1) : r.regression_suite_size;
}

/** `2/2`, or `—` when the gate had no earlier failures to check against. */
export function regressionPct(r: CycleRecord): string {
  if (!r.gate) return "—";
  const n = regressionDenom(r);
  return n === 0 ? "—" : pct(r.gate.regression_pass_rate, n);
}

/** `3/3` from the record's own legit denominator; `—` without a gate. */
export function legitPct(r: CycleRecord): string {
  return r.gate ? pct(r.gate.legit_pass_rate, r.legit_suite_size) : "—";
}

interface Headline {
  version: number | null;
  suiteSize: number;
  legit: string;
  lastGate: "accepted" | "rejected" | null;
}

function headline(cycles: CycleRecord[]): Headline {
  const last = cycles.at(-1);
  const lastWithGate = [...cycles].reverse().find((c) => c.gate);
  return {
    version: last?.config_after ?? null,
    suiteSize: last?.regression_suite_size ?? 0,
    legit: lastWithGate ? legitPct(lastWithGate) : "—",
    lastGate: lastWithGate?.gate ? (lastWithGate.gate.accepted ? "accepted" : "rejected") : null,
  };
}

/** The target's tool calls as far as the record shows: the episode when present, else the judge's cited call. */
function recordCalls(r: CycleRecord): CallLike[] {
  const tc = r.verdict.evidence.tool_call;
  return r.episode?.tool_calls ?? (tc ? [tc] : []);
}

export interface DiffLine {
  sign: "+" | "-" | " ";
  text: string;
}

/** Line diff between two configs, over the fields a patch can touch. */
export function configDiff(before: AgentConfig, after: AgentConfig): DiffLine[] {
  const lines: DiffLine[] = [];
  const list = (label: string, a: string[], b: string[]) => {
    const A = new Set(a), B = new Set(b);
    for (const x of a) if (!B.has(x)) lines.push({ sign: "-", text: `${label}: ${x}` });
    for (const x of b) if (!A.has(x)) lines.push({ sign: "+", text: `${label}: ${x}` });
  };
  list("rule", before.guardrail_rules, after.guardrail_rules);
  list("validator", before.tool_output_validators, after.tool_output_validators);
  if (before.system_prompt !== after.system_prompt) {
    for (const l of before.system_prompt.split("\n")) lines.push({ sign: "-", text: `prompt: ${l}` });
    for (const l of after.system_prompt.split("\n")) lines.push({ sign: "+", text: `prompt: ${l}` });
  }
  // ToolPolicy now lists every field schemas.py has, so this narrowing is honest; the merge catches a
  // field that only the newer config carries (older configs omit fields added since).
  const merged: ToolPolicy = { ...before.tool_policy, ...after.tool_policy };
  const norm = (v: boolean | number | null | undefined) => (v === undefined ? false : v);
  for (const k of Object.keys(merged) as (keyof ToolPolicy)[]) {
    const b = norm(before.tool_policy[k]);
    const a = norm(after.tool_policy[k]);
    if (b !== a) {
      lines.push({ sign: "-", text: `policy.${k}: ${String(b)}` });
      lines.push({ sign: "+", text: `policy.${k}: ${String(a)}` });
    }
  }
  return lines;
}

export function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/** `10:31 PM` — hour and minute only, for labels where seconds are noise (the Heal replay link). */
export function fmtTimeShort(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

/** Seconds → `m:ss` (`207.4` → `3:27`). For elapsed/duration readouts, never wall-clock times. */
export function fmtClock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** `Sep 18, 10:31 PM` — a run's date for lists where the year is noise. */
export function fmtDate(iso: string): string {
  return new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/** `m:ss` for a row's `duration_s`, or `—` when the run left no phase log. */
export function fmtDuration(seconds: number | null): string {
  return seconds === null ? "—" : fmtClock(seconds);
}

// ---------------------------------------------------------------------------
// Tool-call labels shared by the cycle page and the cycles box.
// ---------------------------------------------------------------------------

/** Tools that change the world when they execute. Mirrors SIDE_EFFECT_TOOLS in api/manifest.py. */
const SIDE_EFFECT_TOOLS: ReadonlySet<string> = new Set(["issue_refund", "send_email"]);

/** Free-text arguments that would blow a one-line row; the call is identified by the rest. */
const VERBOSE_ARGS: ReadonlySet<string> = new Set(["reason", "subject", "body"]);

type CallLike = Pick<ToolCall, "tool" | "args"> & Partial<Pick<ToolCall, "blocked_by_policy" | "blocked_by">>;

/** `issue_refund(B-2001, 899.00)`. Amounts print with two decimals even when the model sent "899". */
function toolCallLabel(tc: CallLike): string {
  const parts = Object.entries(tc.args ?? {})
    .filter(([k]) => !VERBOSE_ARGS.has(k))
    .map(([k, v]) => {
      if (v === null || v === undefined) return "";
      if (k === "amount" && v !== "" && Number.isFinite(Number(v))) return Number(v).toFixed(2);
      return typeof v === "object" ? JSON.stringify(v) : String(v);
    });
  return `${tc.tool}(${parts.join(", ")})`;
}

/** A side-effect tool that actually ran: the thing the demo's red is for. */
function isSideEffectExecuted(tc: CallLike): boolean {
  return SIDE_EFFECT_TOOLS.has(tc.tool) && !tc.blocked_by_policy;
}

export interface PreviewCall {
  label: string;
  /** danger = the call the judge cites as the failure; blocked = policy stopped it; null = everything else */
  tone: "danger" | "blocked" | null;
  /** The policy reason, when the call was blocked (`policy: refunds require the customer to ask`). */
  blockedBy: string | null;
}

/** Key order in `args` is not significant (the judge may rebuild the dict), so compare sorted entries. */
function argsKey(args: Record<string, unknown> | undefined): string {
  return JSON.stringify(Object.entries(args ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

function sameCall(a: CallLike, b: CallLike): boolean {
  return a.tool === b.tool && argsKey(a.args) === argsKey(b.args);
}

/**
 * Red goes on one call only: the one the judge cites as evidence. Marking every executed side
 * effect red (an 8B model sends a couple of harmless status emails per episode) buries the refund
 * the demo is about. When the judge failed the episode without citing a call, fall back to the
 * executed side effects so a failure never renders with no red at all.
 */
function previewCalls(calls: CallLike[], evidence?: CallLike | null, passed?: boolean | null): PreviewCall[] {
  const cited = evidence ? calls.find((tc) => sameCall(tc, evidence)) : undefined;
  const isDanger = (tc: CallLike) =>
    cited ? tc === cited : passed === false && isSideEffectExecuted(tc);
  return calls.map((tc) => ({
    label: toolCallLabel(tc),
    tone: tc.blocked_by_policy ? "blocked" : isDanger(tc) ? "danger" : null,
    blockedBy: tc.blocked_by_policy ? (tc.blocked_by ?? null) : null,
  }));
}

/** How many seed scenarios the manifest lists; null while it has not loaded. Bounds the seeds stepper. */
export function seedCount(manifest: Manifest | null): number | null {
  return manifest ? manifest.families.filter((f) => f.seed_id).length : null;
}

// ---------------------------------------------------------------------------
// The live run page: the four roles as orbs, their words, the phase they are in.
// ---------------------------------------------------------------------------

export type Agent = "chaos" | "target" | "judge" | "repair";
export const AGENTS: readonly Agent[] = ["chaos", "target", "judge", "repair"];

/** The five steps of a cycle, in the order the loop runs them. */
export type Step = Agent | "gate";
export const STEPS: readonly Step[] = ["chaos", "target", "judge", "repair", "gate"];

export const AGENT_LABEL: Record<Step, string> = {
  chaos: "Chaos",
  target: "Target",
  judge: "Judge",
  repair: "Repair",
  gate: "Gate",
};

/** Verb per phase for the headline: `cycle 2 · judge is scoring`. */
const PHASE_VERB: Record<Exclude<Phase, "idle">, string> = {
  baseline: "measuring baseline",
  chaos: "chaos is attacking",
  target: "target is responding",
  judge: "judge is scoring",
  repair: "repair is patching",
  gate: "gate is verifying",
};

/**
 * The phase's verb, with the one exception the status row spells out: the end-of-run vulnerability
 * measurement reuses the `baseline` phase (same orb, same legit traffic) and tags itself `measuring`.
 */
function phaseLabel(status: Status & { phase: Exclude<Phase, "idle"> }): string {
  if (status.phase === "baseline" && status.measuring === "vulnerability") return "measuring vulnerability";
  return PHASE_VERB[status.phase];
}

export function isRunning(status: Status | null): status is Status & { phase: Exclude<Phase, "idle"> } {
  return !!status && status.phase !== "idle";
}

const NO_AGENTS: ReadonlySet<Agent> = new Set();

/**
 * The orbs that are lit for this status. Usually one, but the gate is not an agent: while the loop
 * is in `gate`, chaos/gate.py runs the candidate Target through the regression + legit suites and
 * the Judge scores every episode (run_evaluation), so both of those orbs are working. The gate is
 * also the longest phase (~47 s median vs ~6 s for target); mapping it to nothing left the page
 * dark for half of every cycle.
 */
function activeAgents(status: Status | null): ReadonlySet<Agent> {
  if (!isRunning(status)) return NO_AGENTS;
  if (status.phase === "baseline") return new Set<Agent>(["target"]);
  if (status.phase === "gate") return new Set<Agent>(["target", "judge"]);
  return new Set<Agent>([status.phase]);
}

export function orbStates(status: Status | null): Record<Agent, AgentState> {
  const active = activeAgents(status);
  return {
    chaos: active.has("chaos") ? "thinking" : null,
    target: active.has("target") ? "thinking" : null,
    judge: active.has("judge") ? "thinking" : null,
    repair: active.has("repair") ? "thinking" : null,
  };
}

/** `regression` / `scoring` are the gate's words for Target and Judge; both mean "lit". */
export type OrbWord = "idle" | "thinking" | "regression" | "scoring" | "done";

export function isActiveWord(w: OrbWord): boolean {
  return w !== "idle" && w !== "done";
}

/**
 * The state word under each orb. `done` means this agent's step in the current cycle has finished
 * and a later step is running; it never applies during baseline (a new cycle has not begun).
 * During the gate, Target reads `regression` and Judge `scoring` (see activeAgents); Repair is
 * `done` because its patch is the thing being evaluated.
 */
export function orbWord(agent: Agent, status: Status | null): OrbWord {
  if (!isRunning(status)) return "idle";
  if (status.phase === "gate") {
    if (agent === "target") return "regression";
    if (agent === "judge") return "scoring";
  }
  if (activeAgents(status).has(agent)) return "thinking";
  if (status.phase === "baseline") return "idle";
  const here = STEPS.indexOf(status.phase);
  return STEPS.indexOf(agent) < here ? "done" : "idle";
}

/** The idle/done orb colours (the component's grey preset). Active hues live in Run.tsx ORB_COLORS. */
export const ORB_GREY: [string, string] = ["#E5E7EB", "#9CA3AF"];

/**
 * The sampled-fix count as words: `fixed 2/2`, or `fixed 1/2 — not accepted` when a sample failed and the
 * gate said no. Null when the gate ran the fix once (records from before sampling, or GATE_FIX_SAMPLES=1),
 * where today's accepted/rejected wording already says everything the numbers would.
 */
function fixLine(g: Pick<GateResult, "accepted" | "fix_samples" | "fix_passes">): string | null {
  if (g.fix_samples <= 1) return null;
  const n = `fixed ${g.fix_passes}/${g.fix_samples}`;
  return !g.accepted && g.fix_passes < g.fix_samples ? `${n} — not accepted` : n;
}

// --- Run page (docs/plans/00-overview.md Block 4.6) ------------------------------------------------

/** Where a run's files are read from: `live`, the committed `golden` tape, or one history folder (`run:<id>`). */
export function readSource(id: string): ReadSource {
  if (id === "live" || id === "golden") return id;
  return `run:${id}`;
}

/** What `POST /api/replay/start` plays for this run; null for `live` (the live run is what a replay stands in for). */
export function recordingFor(id: string): RecordingInfo["source"] | null {
  return id === "live" ? null : readSource(id) as RecordingInfo["source"];
}

/**
 * The run whose tape is playing, as a runs-list id (`golden`, or the history id behind `run:<id>`): the inverse
 * of `recordingFor`, so the rail's "Current run" can point at the tape's own page rather than `/app/run`.
 * Null when nothing is playing.
 */
export function replayRunId(replay: Pick<ReplayInfo, "active" | "recording"> | null): string | null {
  if (!replay?.active || !replay.recording) return null;
  const src = replay.recording.source;
  return src.startsWith("run:") ? src.slice("run:".length) : src;
}

/**
 * Whether the active replay is the one this page would show. A replay overrides only `live` reads, so on
 * `/app/run` any tape is what is on screen; a history run is on screen only when its own tape plays.
 */
export function replayIsFor(replay: Pick<ReplayInfo, "active" | "recording"> | null, id: string | null): boolean {
  if (!replay?.active || id === null) return false;
  return id === "live" || replay.recording?.source === recordingFor(id);
}

export type RunMode = "starting" | "live" | "finished" | "watching";

/**
 * Which of the run page's four faces to show. `watching` wins while this run's tape plays (reads flip to
 * `live` for the duration); `live` needs `/app/run` and a loop alive; `starting` is that loop before
 * `run.json` lands (404 on the run row, never an error); everything else — a history row, or the un-archived
 * run whose loop has exited — is `finished`.
 */
export function runMode(id: string, row: RunRow | null, loop: LoopState | null, replay: ReplayInfo | null): RunMode {
  if (replayIsFor(replay, id)) return "watching";
  if (id === "live" && loop?.running) return row ? "live" : "starting";
  return "finished";
}

/**
 * Current run with nothing in `runs/`: the card-and-Heal face. `live` reads fall back to the demo tape when
 * `runs/` is empty, so "the row poll fails *and* state came from golden" is the signal. `state === null` is
 * loading, not empty — the page must never flash the last-run face for a tick. A real run whose state read
 * momentarily fails keeps its row, so it never lands here.
 */
export function emptyLiveFace(id: string, mode: RunMode, rowError: string | null, state: State | null): boolean {
  return id === "live" && mode === "finished" && rowError !== null && state?.source === "golden";
}

/**
 * Current run whose loop has exited but whose files are still in `runs/`: orbs at rest over the results. Needs
 * a state read that came from the live files — `null` is loading, `golden` is the empty face — so a cleared tree
 * never shows the demo tape's cycles under the old run's header for a tick.
 */
export function lastRunFace(id: string, mode: RunMode, state: State | null): boolean {
  return id === "live" && mode === "finished" && state?.source === "live";
}

/**
 * Current run at rest: its face — last run or empty — is decided by three reads that land in any order (the
 * row, the cycles, the state). Until each has answered or failed the page is loading; otherwise the tape's
 * cycles paint under "no run yet" and the orbs arrive a beat later. A state still tagged `replay` is a tape's
 * frame held from a moment ago, not an answer for the run at rest, so it counts as pending too — the re-read
 * that replaces it runs one render later. False while anything plays.
 */
export function idleFaceSettling(
  id: string,
  mode: RunMode,
  reads: { row: RunRow | null; rowError: string | null; cycles: CycleRecord[] | null; cyclesError: string | null; state: State | null; stateError: string | null },
): boolean {
  if (id !== "live" || mode !== "finished") return false;
  const pending = (value: unknown, error: string | null) => value === null && error === null;
  return pending(reads.row, reads.rowError) || pending(reads.cycles, reads.cyclesError) || pending(reads.state, reads.stateError) || reads.state?.source === "replay";
}

/** The page title: the run as an object, not the view of it. */
export function runTitle(id: string): string {
  if (id === "live") return "Current run";
  if (id === "golden") return "Demo tape";
  return `Run ${id}`;
}

/** `Sep 18, 10:31 PM` — for a run's start, where the day matters and the seconds do not. */
function fmtDateTime(iso: string): string {
  return new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/** The run's agent by name: the joined row's, else "demo agent" for the built-in target, else the stored target string. */
function runAgentName(row: Pick<RunRow, "agent" | "target">): string {
  if (row.agent) return row.agent.name;
  return row.target === "builtin" ? "demo agent" : row.target;
}

/**
 * The finished header: `started Sep 18, 10:31 PM · demo agent · mock · --chaos-cycles 5 --seeds 2 · v0 → v3`.
 * Only the facts the row has (a legacy archive lists no flags).
 */
export function runHeaderLine(row: RunRow): string {
  const parts: string[] = [];
  if (row.started_at) parts.push(`started ${fmtDateTime(row.started_at)}`);
  parts.push(runAgentName(row), row.world);
  if (row.flags.length) parts.push(row.flags.join(" "));
  const first = row.versions[0] ?? 0;
  const last = row.final_version ?? row.versions.at(-1) ?? first;
  parts.push(first === last ? `v${last}` : `v${first} → v${last}`);
  return parts.join(" · ");
}

/** The stats plate's numbers as one line, for the finished view where no orbs sit under a plate. */
export function summaryLine(s: RunSummary): string {
  return [
    `${s.accepted} ${s.accepted === 1 ? "patch" : "patches"} accepted`,
    `${s.rejected} rejected`,
    `${s.blocked} ${s.blocked === 1 ? "attack" : "attacks"} blocked`,
    `${s.suiteSize} ${s.suiteSize === 1 ? "test" : "tests"} in suite`,
    `legit users ${s.legit}`,
  ].join(" · ");
}

/**
 * Versions a finished run offers to roll back to: every config it saved, oldest first, except the one live
 * already is (`current`: known once a rollback in this session copied it in — the API has no "live equals run X
 * v3" fact to read). `live` offers none — the API refuses it (400) because the live tree is what a rollback
 * writes into; `--from-version` is the CLI's way there. Nothing while a loop runs either, since the loop owns
 * the live config then.
 */
export function rollbackVersions(id: string, row: RunRow | null, loop: LoopState | null, current: number | null): number[] {
  if (id === "live" || !row || loop?.running) return [];
  return [...new Set(row.configs?.map((c) => c.version) ?? row.versions)].filter((v) => v !== current).sort((a, b) => a - b);
}

// --- CycleRecord → Task ------------------------------------------------------------------------

/** Unique tool names the Target actually called: from the episode, else the judge's cited call. */
function targetTools(r: CycleRecord): string[] {
  return [...new Set(recordCalls(r).map((c) => c.tool))];
}

function taskStatus(r: CycleRecord, isLast: boolean): string {
  const s = rowStatus(r);
  if (s === "blocked" || s === "repaired") return "completed";
  // A rejected gate with a later cycle is `need-help` per the spec; the latest one is `failed`.
  if (s === "unfixed" && !isLast) return "need-help";
  return "failed";
}

function subtask(id: string, title: string, description: string, status: string, tools?: string[]): Subtask {
  return { id, title, description, status, priority: "high", ...(tools && tools.length ? { tools } : {}) };
}

/** A finished cycle as one Plan task with the five steps as subtasks. */
function cycleToTask(r: CycleRecord, isLast: boolean): Task {
  const id = String(r.cycle);
  const faults = r.scenario.faults.map((f) => `${f.tool}: ${f.mode}`).join(", ");
  const tc = r.verdict.evidence.tool_call;
  const calls = previewCalls(recordCalls(r), tc, r.verdict.passed);
  const callsLine = calls
    .map((c) => (c.tone === "blocked" ? `${c.label} · blocked by policy` : c.label))
    .join(" · ");
  const subtasks: Subtask[] = [
    subtask(
      `${id}.chaos`,
      r.scenario.origin === "chaos_agent" ? "Chaos generated the scenario" : `Chaos replayed a ${r.scenario.origin} scenario`,
      faults ? `fault: ${faults} — ${r.scenario.attacker_goal}` : r.scenario.attacker_goal,
      "completed",
    ),
    subtask(
      `${id}.target`,
      tc
        ? `Target called ${tc.tool}`
        : calls.length
          ? `Target made ${calls.length} tool ${calls.length === 1 ? "call" : "calls"}`
          : r.attack_succeeded
            ? "Target responded"
            : "Target handled it safely",
      callsLine || r.scenario.expected_behavior,
      "completed",
      targetTools(r),
    ),
    subtask(
      `${id}.judge`,
      r.verdict.passed
        ? `Judge passed the target · ${r.verdict.method}`
        : `Judge failed the target · ${r.verdict.failure_kind ?? "unknown"}`,
      r.verdict.reason,
      r.verdict.passed ? "completed" : "failed",
    ),
    subtask(
      `${id}.repair`,
      r.patch ? `Repair proposed ${r.patch.kind}` : "Repair not needed",
      r.patch
        ? (r.patch.guardrail_rule ?? r.patch.validator_name ?? r.patch.system_prompt ?? r.patch.rationale)
        : "The attack was blocked, so there is nothing to patch.",
      r.patch ? "completed" : r.attack_succeeded ? "pending" : "completed",
    ),
    subtask(
      `${id}.gate`,
      r.gate
        ? `Gate ${r.gate.accepted ? "accepted" : "rejected"} · regression ${regressionPct(r)} · legit ${legitPct(r)}`
        : "Gate not run",
      r.gate ? r.gate.reason : `Config stays at v${r.config_after}.`,
      r.gate ? (r.gate.accepted ? "completed" : "failed") : r.attack_succeeded ? "pending" : "completed",
    ),
  ];
  return {
    id,
    title: `Cycle ${r.cycle} · ${r.scenario.title}`,
    description: r.scenario.user_message,
    status: taskStatus(r, isLast),
    priority: "high",
    level: 0,
    dependencies: [
      r.config_before === r.config_after ? `v${r.config_after}` : `v${r.config_before} → v${r.config_after}`,
    ],
    subtasks,
  };
}

/**
 * The cycle the loop is in right now, before its record exists. Built from status.json alone:
 * steps before the current phase are done (no evidence yet), the current one is in progress.
 *
 * `baseline` with a cycle number > 0 is loop.py re-measuring legit traffic right after a gate
 * accepted (set_phase(cycle, "baseline", False)); every step of that cycle has finished and its
 * record is about to be written, so all five show as completed.
 */
function inFlightTask(status: Status & { phase: Exclude<Phase, "idle"> }, latestVersion: number | null): Task {
  const cycle = status.cycle ?? 0;
  const id = String(cycle);
  const here = status.phase === "baseline" ? STEPS.length : STEPS.indexOf(status.phase);
  const retrying = (status.attempt ?? 1) > 1;
  const subtasks: Subtask[] = STEPS.map((step, i) => {
    const running = i === here;
    const done = i < here;
    const attempt =
      status.attempt && status.attempt > 1 && (step === "repair" || step === "gate") ? ` · attempt ${status.attempt}` : "";
    // On a repair retry the gate has already run once and rejected; say so instead of "waiting".
    if (step === "gate" && !running && !done && retrying) {
      return {
        id: `${id}.${step}`,
        title: `Gate rejected attempt ${status.attempt! - 1}`,
        description: "the repair is trying again",
        status: "failed",
        priority: "high",
      };
    }
    const title = running
      ? `${AGENT_LABEL[step]} ${STEP_VERB[step]}${attempt}`
      : done
        ? `${AGENT_LABEL[step]} done`
        : AGENT_LABEL[step];
    return {
      id: `${id}.${step}`,
      title,
      // Only the first finished step carries the note; repeating it on every row is noise.
      description: running
        ? `since ${status.since ? fmtTime(status.since) : "—"}`
        : done
          ? i === 0
            ? "evidence lands when the cycle is written"
            : ""
          : "waiting",
      status: running ? "in-progress" : done ? "completed" : "pending",
      priority: "high",
    };
  });
  return {
    id,
    title: status.phase === "baseline" ? `Cycle ${cycle} · patch accepted, re-measuring baseline` : `Cycle ${cycle} · in progress`,
    description: "Scenario text arrives with the record once the cycle is written.",
    status: "in-progress",
    priority: "high",
    level: 0,
    dependencies: latestVersion === null ? [] : [`v${latestVersion}`],
    subtasks,
  };
}

const STEP_VERB: Record<Step, string> = {
  chaos: "is attacking",
  target: "is responding",
  judge: "is scoring",
  repair: "is patching",
  gate: "is verifying",
};

/**
 * Newest first. If status.json names a cycle that has no record yet, it is prepended as the
 * in-flight task. Two cases add nothing: `baseline` for cycle 0 (the run is measuring production
 * before any attack, there is no cycle to show), and a status naming a cycle whose record already
 * exists (a loop that died mid-phase leaves status.json behind; the record is the truth).
 */
function cyclesToTasks(cycles: CycleRecord[], status: Status | null): Task[] {
  const tasks = cycles.map((r, i) => cycleToTask(r, i === cycles.length - 1)).reverse();
  if (isRunning(status)) {
    const cycle = status.cycle ?? 0;
    const startOfRun = status.phase === "baseline" && cycle === 0;
    const recorded = cycles.some((c) => c.cycle === cycle);
    if (!startOfRun && !recorded) {
      tasks.unshift(inFlightTask(status, cycles.at(-1)?.config_after ?? null));
    }
  }
  return tasks;
}

// ---------------------------------------------------------------------------------------------
// Single-cycle view (the Agents "cycles box"). Built on the Task mapping above so the evidence
// text has one source of truth; this only reshapes it into what the rail and ledger render.
// ---------------------------------------------------------------------------------------------

export type StepState = "done" | "active" | "pending" | "failed" | "skipped";

/** A child node under a step: a tool call, a fault, a gate criterion. */
export interface SubItem {
  label: string;
  detail?: string;
  tone?: "danger" | "ok" | "blocked" | null;
  /** The label is code (a tool call, a fault on a tool), so it is set in monospace. */
  code?: boolean;
}

export interface StepView {
  step: Step;
  label: string;
  state: StepState;
  /** One line: what happened (`Judge failed the target · unauthorized_action`). */
  headline: string;
  /** The evidence beneath it, kept short and always visible (verdict reason, artifact, gate reason). */
  evidence: string;
  /**
   * The long form, collapsed by default: the target's full reply, the repair model's rationale, a
   * rewritten system prompt. What a reader opens when the one-liner is not enough.
   */
  detail?: { label: string; text: string };
  /** Sub-timeline: what the agent actually did, one node each. */
  children?: SubItem[];
  /** ISO time the active step started; drives the elapsed timer. */
  since?: string;
}

export type CycleResult = RowStatus | "running";

export interface CycleView {
  cycle: number;
  /** `Cycle 3` */
  name: string;
  /** Scenario title, or the in-flight placeholder. */
  title: string;
  /** Verbatim user message, when the record exists. */
  message: string | null;
  kind: string | null;
  result: CycleResult;
  /** `v2 → v3` or `v3` */
  versions: string;
  timestamp: string | null;
  steps: StepView[];
  weaveCallUrl: string | null;
  weaveEvalUrls: string[];
  live: boolean;
}

function stepState(status: string): StepState {
  if (status === "completed") return "done";
  if (status === "in-progress") return "active";
  if (status === "failed") return "failed";
  return "pending";
}

/**
 * The concrete thing a patch changes, in one line. The rationale is the repair model's thinking
 * and can run to a paragraph; the artifact is what actually landed in the config.
 */
function patchArtifact(p: Patch): string {
  if (p.guardrail_rule) return p.guardrail_rule;
  if (p.validator_name) return `validator ${p.validator_name}`;
  if (p.system_prompt) return "system prompt rewritten";
  if (p.tool_policy) {
    const on = Object.entries(p.tool_policy)
      .filter(([, v]) => v === true)
      .map(([k]) => k);
    return on.length ? `policy now requires ${on.join(", ")}` : "tool policy tightened";
  }
  return p.rationale;
}

/** Sub-timeline nodes for one step, from the record. */
function stepChildren(step: Step, r: CycleRecord): SubItem[] | undefined {
  if (step === "chaos") {
    const faults = r.scenario.faults.map((f) => ({ label: `${f.tool} · ${f.mode}`, code: true }));
    return faults.length ? faults : undefined;
  }
  if (step === "target") {
    const calls = previewCalls(recordCalls(r), r.verdict.evidence.tool_call, r.verdict.passed);
    return calls.length
      ? calls.map((c) => ({
          label: c.label,
          tone: c.tone,
          code: true,
          detail: c.tone === "blocked" ? "blocked by policy" : c.tone === "danger" ? "cited by the judge" : undefined,
        }))
      : undefined;
  }
  if (step === "gate" && r.gate) {
    const g = r.gate;
    const legitOk = g.accepted || !g.reason.startsWith("breaks a legit");
    const regressionOk = g.accepted || !g.reason.startsWith("reintroduces");
    const ok = (b: boolean): SubItem["tone"] => (b ? "ok" : "danger");
    // gate.py tolerates regression/legit rows the production config already failed; only a
    // protected row breaking rejects. So "2/5" next to a pass is honest, and the labels say so.
    return [
      { label: "fixes the new failure", detail: fixLine(g) ?? undefined, tone: ok(g.fixes_new_failure) },
      { label: "no past fix reintroduced", detail: `regression ${regressionPct(r)}`, tone: ok(regressionOk) },
      { label: "no legit flow newly broken", detail: `legit ${legitPct(r)}`, tone: ok(legitOk) },
    ];
  }
  return undefined;
}

/** Judge and gate get a verb-first headline; repair names the artifact, not the reasoning. */
function stepHeadline(step: Step, r: CycleRecord, fallback: string): string {
  if (step === "repair" && r.patch) return `Repair proposed ${humanizeKind(r.patch.kind)} · ${patchLayer(r.patch.kind)} layer`;
  return fallback;
}

/**
 * The always-visible line under each step. Short by construction: the attacker's goal, the judge's
 * reason, the patch artifact, the gate's reason. Target has no one-liner of its own; its tool calls
 * (the sub-timeline) are the evidence, and the full reply lives in `stepDetail`.
 */
function stepEvidence(step: Step, r: CycleRecord, fallback: string): string {
  if (step === "chaos") return r.scenario.attacker_goal;
  if (step === "target") return "";
  if (step === "repair" && r.patch) return patchArtifact(r.patch);
  return fallback;
}

/** The long form behind a disclosure. Only where there is something long to show. */
function stepDetail(step: Step, r: CycleRecord): StepView["detail"] {
  if (step === "target" && r.episode?.final_reply) return { label: "reply", text: r.episode.final_reply };
  if (step === "repair" && r.patch) {
    // The rationale is the model's thinking; a rewritten system prompt is the artifact itself but
    // too long for the one-liner. Prefer the prompt when that is what changed.
    if (r.patch.system_prompt) return { label: "new system prompt", text: r.patch.system_prompt };
    if (r.patch.rationale) return { label: "reasoning", text: r.patch.rationale };
  }
  return undefined;
}

function taskToView(t: Task, r: CycleRecord | undefined, status: Status | null): CycleView {
  const live = !r;
  // A blocked attack never reaches Repair or Gate; the Task mapping marks them "completed" for
  // the plan's checklist, but the timeline should not claim work that did not happen.
  const skippedAfterBlock = !!r && !r.attack_succeeded;
  const steps: StepView[] = t.subtasks.map((s, i) => {
    const step = STEPS[i];
    const skipped = skippedAfterBlock && (step === "repair" || step === "gate");
    const state = skipped ? "skipped" : stepState(s.status);
    return {
      step,
      label: AGENT_LABEL[step],
      state,
      headline: r ? stepHeadline(step, r, s.title) : s.title,
      evidence: r && !skipped ? stepEvidence(step, r, s.description) : s.description,
      detail: r && !skipped ? stepDetail(step, r) : undefined,
      children: r && !skipped ? stepChildren(step, r) : undefined,
      since: state === "active" && isRunning(status) ? status.since : undefined,
    };
  });
  return {
    cycle: Number(t.id),
    name: `Cycle ${t.id}`,
    title: r
      ? r.scenario.title
      : status?.phase === "baseline"
        ? "Patch accepted, re-measuring baseline"
        : "Scenario in progress",
    message: r ? r.scenario.user_message : null,
    kind: r ? humanizeKind(r.scenario.kind) : null,
    result: r ? rowStatus(r) : "running",
    versions: t.dependencies[0] ?? "",
    timestamp: r?.timestamp ?? null,
    steps,
    weaveCallUrl: r?.weave_call_url ?? null,
    weaveEvalUrls: r?.gate?.weave_eval_urls ?? [],
    live,
  };
}

/** Newest first; the in-flight cycle (if any) is first and has `live: true`. */
export function cycleViews(cycles: CycleRecord[], status: Status | null): CycleView[] {
  const byCycle = new Map(cycles.map((c) => [c.cycle, c]));
  return cyclesToTasks(cycles, status).map((t) => taskToView(t, byCycle.get(Number(t.id)), status));
}

export interface RunSummary {
  version: number | null;
  accepted: number;
  rejected: number;
  blocked: number;
  suiteSize: number;
  legit: string;
  cycles: number;
}

/** The numbers the hero states: where the config ended up and how it got there. */
export function runSummary(cycles: CycleRecord[]): RunSummary {
  const h = headline(cycles);
  return {
    version: h.version,
    accepted: cycles.filter((c) => c.gate?.accepted).length,
    rejected: cycles.filter((c) => c.gate && !c.gate.accepted).length,
    blocked: cycles.filter((c) => !c.attack_succeeded).length,
    suiteSize: h.suiteSize,
    legit: h.legit,
    cycles: cycles.length,
  };
}

/**
 * The real Zendesk ticket an episode worked, when the run was on the Zendesk world. The URL is only
 * trusted if it is an https link to a Zendesk agent ticket page: the record is data, not a place to
 * put an arbitrary href.
 */
export function ticketLink(r: CycleRecord): { id: number; url: string } | null {
  const ts = r.episode?.ticket_state;
  if (!ts) return null;
  const id = ts.ticket_id;
  const url = ts.url;
  if (typeof id !== "number" || !Number.isInteger(id) || typeof url !== "string") return null;
  if (!/^https:\/\/[a-z0-9-]+\.zendesk\.com\/agent\/tickets\/\d+$/i.test(url)) return null;
  return { id, url };
}

/** `9 cycles` / `1 cycle`. */
function cyclesCount(n: number): string {
  return `${n} ${n === 1 ? "cycle" : "cycles"}`;
}

/** A run row's second line in a short list: `demo tape` / `running` / `9 cycles`. */
export function runLine(r: Pick<RunRow, "id" | "cycles">, loopRunning: boolean): string {
  if (r.id === "golden") return "demo tape";
  if (r.id === "live" && loopRunning) return "running";
  return cyclesCount(r.cycles);
}

/** `Sep 19, 8:00 PM · v0 → v3 · 9 cycles` — a run as one line for a picker; the golden run's date is `demo tape`. */
export function runPickerLabel(r: Pick<RunRow, "id" | "started_at" | "cycles" | "versions" | "final_version">): string {
  const when = r.id === "golden" ? "demo tape" : r.started_at ? fmtDate(r.started_at) : r.id;
  return `${when} · ${versionSpan(r)} · ${cyclesCount(r.cycles)}`;
}

/** `67%` from a 0–1 rate. */
function percent(x: number): string {
  return `${Math.round(x * 100)}%`;
}

/** Every config version a run passed through, oldest first: `versions` from the row, else what the cycles saw. */
export function versionsOf(row: Pick<RunRow, "versions" | "final_version"> | null, cycles: CycleRecord[]): number[] {
  const set = new Set<number>(row?.versions ?? []);
  for (const c of cycles) {
    set.add(c.config_before);
    set.add(c.config_after);
  }
  if (row?.final_version !== null && row?.final_version !== undefined) set.add(row.final_version);
  return [...set].sort((x, y) => x - y);
}

/** The cycles that attacked version `v` (ran with `config_before === v`), in run order. */
function cyclesAgainst(cycles: CycleRecord[], v: number): CycleRecord[] {
  return cycles.filter((c) => c.config_before === v);
}

/** The cycle whose accepted patch produced version `v`, or null for v0 and for versions no cycle made (a rollback copy). */
function cycleThatMade(cycles: CycleRecord[], v: number): CycleRecord | null {
  return cycles.find((c) => c.config_after === v && c.config_before !== v) ?? null;
}

interface VersionStats {
  /** Attacks run against it and how many landed. */
  attacks: number;
  landed: number;
  /** `blocks 3 of 4 known attacks`, or null when the run's end measurement has nothing for this version. */
  blocks: string | null;
  /** The gate's scores for the patch that made it, or null for v0 / rollback copies. */
  gate: { regression: number; legit: number } | null;
}

/**
 * What one version of the config did in a run, for the Versions panel: what was thrown at it, what it blocks
 * by the run's end measurement, and how the gate scored the patch that made it.
 */
function versionStats(cycles: CycleRecord[], v: number, vuln: State["vulnerability"] | undefined): VersionStats {
  const against = cyclesAgainst(cycles, v);
  const maker = cycleThatMade(cycles, v);
  const landedAt = vuln && vuln.suite_size > 0 ? vuln.landed[`v${v}`] : undefined;
  return {
    attacks: against.length,
    landed: against.filter((c) => c.attack_succeeded).length,
    blocks: landedAt === undefined ? null : `blocks ${Math.max(0, vuln!.suite_size - landedAt)} of ${vuln!.suite_size} known ${vuln!.suite_size === 1 ? "attack" : "attacks"}`,
    gate: maker?.gate ? { regression: maker.gate.regression_pass_rate, legit: maker.gate.legit_pass_rate } : null,
  };
}

/** The Versions panel's one line for the picked version: `4 attacks · 2 landed · blocks 3 of 4 known attacks · gate 100% / 91%`. */
export function versionLine(cycles: CycleRecord[], v: number, vuln: State["vulnerability"] | undefined): string {
  const s = versionStats(cycles, v, vuln);
  const parts = [`${s.attacks} ${s.attacks === 1 ? "attack" : "attacks"}`, `${s.landed} landed`];
  if (s.blocks) parts.push(s.blocks);
  if (s.gate) parts.push(`gate ${percent(s.gate.regression)} / ${percent(s.gate.legit)}`);
  return parts.join(" · ");
}

export interface ResultsRow {
  cycle: number;
  /** `cycle 4 · Friend asks for another customer's order` */
  client: string;
  status: RowStatus;
  services: string;
}

/**
 * The hover list's rows for one config version: the cycles that attacked `v`, oldest first — or every cycle
 * when `v` is the final version and nothing ran against it, so a run with cycles never shows an empty list.
 */
export function resultsRows(cycles: CycleRecord[], v: number, last: number): ResultsRow[] {
  const against = cyclesAgainst(cycles, v);
  const rows = against.length === 0 && v === last ? cycles : against;
  return rows.map((c) => ({ cycle: c.cycle, client: `cycle ${c.cycle} · ${shortTitle(c)}`, status: rowStatus(c), services: cycleOutcome(c) }));
}

/** One cycle's outcome as a short phrase for a list row: blocked · patched → v3 · patch rejected · never patched. */
function cycleOutcome(r: CycleRecord): string {
  switch (rowStatus(r)) {
    case "blocked":
      return "blocked";
    case "repaired":
      return `patched → v${r.config_after}`;
    case "unfixed":
      return "patch rejected";
    case "failed":
      return "never patched";
  }
}

/** `judge is scoring` for the running phase, used under the hero while live. */
export function phaseVerb(status: Status | null): string | null {
  return isRunning(status) ? phaseLabel(status) : null;
}

// ---------------------------------------------------------------------------------------------
// Cycle page: five short rows. Each is a headline a person would say out loud and at most one
// sentence of detail. Anything longer is reachable through the Weave links in the header.
// ---------------------------------------------------------------------------------------------

export interface CycleStep {
  step: Step;
  label: string;
  /** Short, plain: `ran issue_refund(A-1002, 129.99)`, `accepted · v0 → v1`. */
  headline: string;
  /** One sentence or nothing. */
  line: string;
  tone: "ok" | "danger" | "skipped" | null;
}

/** The first sentence, or the first `max` characters, whichever is shorter. */
function firstSentence(text: string, max = 170): string {
  const t = text.trim();
  const m = /^[\s\S]{40,}?[.!?](?=\s|$)/.exec(t);
  const s = m ? m[0] : t;
  return s.length > max ? s.slice(0, max).trimEnd() + "…" : s;
}

function patchVerb(p: Patch): string {
  if (p.kind === "add_tool_validator") return p.validator_name ? `added validator ${p.validator_name}` : "added a tool validator";
  if (p.kind === "tighten_tool_policy") {
    const on = Object.entries(p.tool_policy ?? {})
      .filter(([, v]) => v === true)
      .map(([k]) => k.replace(/_/g, " "));
    return on.length ? `tightened tool policy · ${on.join(", ")}` : "tightened the tool policy";
  }
  if (p.kind === "add_guardrail_rule") return "added a guardrail rule";
  return "rewrote the system prompt";
}

export function cycleSteps(r: CycleRecord): CycleStep[] {
  const calls = recordCalls(r);
  const marks = previewCalls(calls, r.verdict.evidence.tool_call, r.verdict.passed);
  const cited = marks.find((m) => m.tone === "danger");
  const blocked = marks.filter((m) => m.tone === "blocked").length;

  const chaos: CycleStep = {
    step: "chaos",
    label: AGENT_LABEL.chaos,
    headline: humanizeKind(r.scenario.kind),
    line: firstSentence(r.scenario.attacker_goal),
    tone: null,
  };

  const target: CycleStep = {
    step: "target",
    label: AGENT_LABEL.target,
    headline: cited
      ? `ran ${cited.label}`
      : calls.length
        ? `${calls.length} tool ${calls.length === 1 ? "call" : "calls"}${blocked ? ` · ${blocked} blocked by policy` : ""}`
        : r.attack_succeeded
          ? "no tool calls on record"
          : "handled it without side effects",
    line: r.episode?.final_reply ? `“${firstSentence(r.episode.final_reply, 150)}”` : "",
    tone: cited ? "danger" : null,
  };

  const judge: CycleStep = {
    step: "judge",
    label: AGENT_LABEL.judge,
    headline: r.verdict.passed ? "passed · attack blocked" : `failed · ${humanizeKind(r.verdict.failure_kind ?? "unknown")}`,
    line: firstSentence(r.verdict.reason),
    tone: r.verdict.passed ? "ok" : "danger",
  };

  const repair: CycleStep = r.patch
    ? {
        step: "repair",
        label: AGENT_LABEL.repair,
        headline: patchVerb(r.patch),
        line: r.patch.guardrail_rule ? `“${firstSentence(r.patch.guardrail_rule)}”` : firstSentence(r.patch.rationale),
        tone: null,
      }
    : { step: "repair", label: AGENT_LABEL.repair, headline: "not needed", line: "", tone: "skipped" };

  const g = r.gate;
  const fixed = g ? fixLine(g) : null;
  const gate: CycleStep = g
    ? {
        step: "gate",
        label: "Gate",
        headline: g.accepted ? `accepted · v${r.config_before} → v${r.config_after}` : `rejected · v${r.config_after} stays`,
        line: [firstSentence(g.reason), fixed, `regression ${regressionPct(r)}`, `legit ${legitPct(r)}`]
          .filter(Boolean)
          .join(" · "),
        tone: g.accepted ? "ok" : "danger",
      }
    : { step: "gate", label: "Gate", headline: "not run", line: "", tone: "skipped" };

  return [chaos, target, judge, repair, gate];
}

// --- Agents, Runs (docs/plans/00-overview.md Block 4; 07-app-rework.md) -----------------------------------

/**
 * How far to turn the agent card's photo (`public/agent-card.jpg`, the Ruixen card's amber streak, hue ≈ 15°)
 * so every agent is its own colour, on the card and on its tile alike: the demo agent keeps the reference's
 * amber, the example agent is turned to a cool blue, a connected agent to its own hashed hue. Colour here is
 * identity, not decoration. Degrees for CSS `hue-rotate()`.
 */
export function agentHueRotate(id: string): number {
  const PHOTO_HUE = 15;
  const hue = agentHue(id);
  if (hue === null) return 0;
  return (hue - PHOTO_HUE + 360) % 360;
}

/** `v0 → v3` from a row's saved versions; `v3` when nothing changed; `—` with no configs at all. */
export function versionSpan(r: Pick<RunRow, "versions" | "final_version">): string {
  const to = r.final_version;
  if (to === null) return "—";
  const from = r.versions[0] ?? 0;
  return from === to ? `v${to}` : `v${from} → v${to}`;
}

/** Who a run attacked: the joined agent's name, "Demo agent" for the built-in target, else the raw target string. */
export function runAgentLabel(r: Pick<RunRow, "agent" | "target">): string {
  if (r.agent) return r.agent.name;
  return r.target === "builtin" ? "Demo agent" : r.target;
}

/**
 * The status word on a Runs row. The un-archived run is `live` whether or not its loop is alive (Block 4's
 * identity rule), so the loop decides between "running" and "finished · not archived" — and until the shell's
 * first `/api/loop` answer (`null`) the word is "…" rather than a guess; the demo tape is a recording, never a
 * run someone started here.
 */
export function runStatusLabel(r: Pick<RunRow, "id" | "label">, loopRunning: boolean | null): string {
  if (r.id === "golden") return r.label ?? "demo tape";
  if (r.id === "live") return loopRunning === null ? "…" : loopRunning ? "running" : "finished · not archived";
  return "finished";
}

/**
 * The runs of one agent, newest first as the list came. `GET /api/runs` joins `agent` for every row whose
 * target resolves, the built-in one included (verified against the API), so the id is the whole rule; runs
 * whose agent was deleted match nobody. The demo tape counts: it is a run of the built-in agent.
 */
export function runsForAgent(runs: RunRow[], agentId: string): RunRow[] {
  return runs.filter((r) => r.agent?.id === agentId);
}

/**
 * An agent's own hue (0-360), hashed from the id so two agents never share one; the example agent is pinned to
 * a cool blue so the two built-in cards read as a pair; `null` for the demo agent, which keeps the photo's own
 * colour. A hashed hue is kept at least 30° from both fixed hues, so a connected agent never looks like a built-in one.
 */
function agentHue(id: string): number | null {
  if (id === "builtin") return null;
  if (id === "example") return 215;
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  let hue = h % 360;
  for (const fixed of [15, 215]) {
    const away = ((hue - fixed) % 360 + 540) % 360 - 180;
    if (Math.abs(away) < 30) hue = (fixed + (away < 0 ? -30 : 30) + 360) % 360;
  }
  return hue;
}

export interface HomeStat {
  label: string;
  value: string;
}

/**
 * The Home card's stat row for the selected agent's last run: where the config ended, what it blocks, how
 * legit users fared, when. `cycles`/`state` `undefined` = still loading (values show "…"); `null` = the read
 * failed or the run has none (values say so). No run at all → a single "never attacked" stat.
 */
export function homeStats(run: RunRow | null, cycles: CycleRecord[] | null | undefined, state: State | null | undefined): HomeStat[] {
  if (!run) return [{ label: "last run", value: "never attacked" }];
  const summary = cycles ? runSummary(cycles) : null;
  return [
    { label: "config", value: versionSpan(run) },
    { label: "blocks", value: blocksLine(state === undefined ? undefined : (state?.vulnerability ?? null), run.final_version).replace(/^blocks /, "") },
    { label: "legit users", value: cycles === undefined ? "…" : summary ? summary.legit : "—" },
    { label: "last run", value: run.started_at ? fmtDate(run.started_at) : "—" },
  ];
}

export interface AttentionRow {
  cycle: number;
  title: string;
  /** Why it needs a look: the gate refused the patch, or the attack landed and nothing was patched. */
  why: "rejected" | "unpatched";
}

/**
 * Cycles a person should look at, newest first: an attack that landed and the config did not change for it
 * — the gate rejected the patch (`gate && !gate.accepted`) or there was no gate at all (`attack_succeeded &&
 * !gate`, chaos/schemas.py). Blocked attacks and accepted patches need nobody.
 */
export function needsAttention(cycles: CycleRecord[]): AttentionRow[] {
  return cycles
    .filter((c) => c.attack_succeeded && (!c.gate || !c.gate.accepted))
    .map((c) => ({ cycle: c.cycle, title: shortTitle(c), why: c.gate ? ("rejected" as const) : ("unpatched" as const) }))
    .reverse();
}

/**
 * "blocks 3 of 3 known attacks" from a run's end-of-run measurement: attacks that still land on the final
 * version, subtracted from the suite. "not measured" when the run has no `vulnerability` (today only the
 * golden tape and API-started runs since Block 5 have one); "…" while the run's state has not arrived
 * (`undefined`), so a card never says "not measured" about a run it has not read yet.
 */
function blocksLine(v: State["vulnerability"] | undefined, finalVersion: number | null): string {
  if (v === undefined) return "…";
  if (!v || finalVersion === null || v.suite_size <= 0) return "not measured";
  const landed = v.landed[`v${finalVersion}`];
  if (landed === undefined) return "not measured";
  const n = v.suite_size;
  return `blocks ${Math.max(0, n - landed)} of ${n} known ${n === 1 ? "attack" : "attacks"}`;
}

// --- Agents (docs/plans/00-overview.md Block 3) ------------------------------------------------------

/** `just now` / `4 min ago` / `3 h ago` / `2 d ago`, for a ping's `at`. */
function fmtAgo(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

/** `1.2 s` / `340 ms`. */
function fmtLatency(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${ms} ms`;
}

/**
 * The last-ping cell: `ok · 1.2 s · 2 min ago`, `failed · 2 min ago`, or `—` when the row has never been
 * pinged (synthetic rows never store one, so they read `—` until pinged in this session).
 */
export function pingLabel(ping: AgentPing | null, now = Date.now()): string {
  if (!ping) return "—";
  return ping.ok ? `ok · ${fmtLatency(ping.latency_ms)} · ${fmtAgo(ping.at, now)}` : `failed · ${fmtAgo(ping.at, now)}`;
}

/** A ping result as a one-line sentence: `ok · 1.2 s · “Hi, I'm…”` or the API's exact error. */
export function pingResultLine(r: PingResult): string {
  if (!r.ok) return r.error;
  const quote = r.reply_preview ? ` · “${r.reply_preview.length > 80 ? `${r.reply_preview.slice(0, 80).trimEnd()}…` : r.reply_preview}”` : "";
  return `ok · ${fmtLatency(r.latency_ms)}${quote}`;
}

/**
 * Which of an agent's listed tools the sandbox storefront serves — the client-side twin of
 * `api.agents.tool_mapping`, for stored rows (which carry `tools` but not `mapping`). Null when the
 * agent lists no tools, or when the storefront's names are not known yet.
 */
export function toolMapping(tools: AgentTool[] | null, storefront: string[] | null): ToolMapping | null {
  if (!tools || !storefront) return null;
  const known = new Set(storefront);
  const names = tools.map((t) => t.name);
  return { known: names.filter((n) => known.has(n)), unknown: names.filter((n) => !known.has(n)) };
}

/** The tools column: `5/7` (mapped of listed), or `—` when the agent has not listed its tools. */
export function toolsMappedLabel(m: ToolMapping | null): string {
  if (!m) return "—";
  return `${m.known.length}/${m.known.length + m.unknown.length}`;
}

/**
 * The Tools step's sentence. `5 of 7 tools map to the sandbox storefront; send_sms, apply_coupon will be
 * unavailable during attacks`; `all 5 tools map to the sandbox storefront`; or, when the agent did not list
 * its tools, a line saying so (the loop still serves every storefront tool; Antibody just cannot check).
 */
export function mappingLine(m: ToolMapping | null): string {
  if (!m) return "This agent does not list its tools, so Antibody cannot check them against the sandbox storefront. Every storefront tool is served during attacks regardless.";
  const total = m.known.length + m.unknown.length;
  if (total === 0) return "This agent lists no tools. Every storefront tool is served during attacks regardless.";
  if (m.unknown.length === 0) return `All ${total} ${total === 1 ? "tool maps" : "tools map"} to the sandbox storefront.`;
  return `${m.known.length} of ${total} tools map to the sandbox storefront; ${m.unknown.join(", ")} will be unavailable during attacks.`;
}

/** The Tools step's rows: every listed tool with whether the sandbox storefront serves it, mapped ones first. */
export function mappingRows(m: ToolMapping): { name: string; served: boolean }[] {
  return [...m.known.map((name) => ({ name, served: true })), ...m.unknown.map((name) => ({ name, served: false }))];
}

export type ExampleState = "running" | "starting" | "stopped";

/** The example agent's state word from its probed row. */
export function exampleState(a: Pick<AgentRow, "running" | "starting">): ExampleState {
  if (a.running) return "running";
  if (a.starting) return "starting";
  return "stopped";
}

/**
 * The faint line under an agent's name: `demo agent · in-process`, `starting… · HTTP` / `running · HTTP` for
 * the example agent (`starting` covers the seconds between the click and the next poll), `HTTP` otherwise.
 */
export function agentSubline(a: Pick<AgentRow, "id" | "running" | "starting">, starting: boolean): string {
  if (a.id === "builtin") return "demo agent · in-process";
  if (a.id === "example") return `${starting ? "starting…" : exampleState(a)} · HTTP`;
  return "HTTP";
}

/** The rail switcher's one-word second line: what kind of thing the selected agent is; "loading agents" before the list lands. */
export function agentKindLine(a: Pick<AgentRow, "id" | "transport"> | null): string {
  if (!a) return "loading agents";
  if (a.id === "builtin") return "demo agent";
  return a.transport === "http" ? "http" : "in-process";
}

/**
 * The Agents grid's order: the agent that ran most recently first, then the rest that have run, then those
 * never attacked, by name; the demo agent last within its group so a person's own agents lead. The list is
 * newest-run first, so the first matching row is the latest.
 */
export function agentsSorted(agents: AgentRow[], runs: RunRow[]): AgentRow[] {
  const last = new Map<string, string>();
  for (const r of runs) if (r.agent && r.started_at && !last.has(r.agent.id)) last.set(r.agent.id, r.started_at);
  return [...agents].sort((a, b) => {
    const la = last.get(a.id);
    const lb = last.get(b.id);
    if (la && lb && la !== lb) return la < lb ? 1 : -1;
    if (!!la !== !!lb) return la ? -1 : 1;
    if ((a.id === "builtin") !== (b.id === "builtin")) return a.id === "builtin" ? 1 : -1;
    return a.name.localeCompare(b.name);
  });
}

/** Whether two typed URLs name the same agent: whitespace and trailing slashes aside. */
export function sameUrl(a: string, b: string): boolean {
  const norm = (u: string) => u.trim().replace(/\/+$/, "");
  return norm(a) === norm(b);
}

/** Whether an agent can be attacked right now: the example agent only answers while its process is up. */
export function selectable(a: AgentRow): boolean {
  return a.id !== "example" || exampleState(a) === "running";
}

/**
 * The agent the next run will attack: `settings.target` when the list still offers it, else the built-in
 * one — so a deleted agent or a stopped example agent is never shown as chosen or submitted. Null while the
 * list has not arrived.
 */
export function selectedAgent(agents: AgentRow[] | null, target: string | null): AgentRow | null {
  if (!agents) return null;
  const saved = target ?? "builtin";
  return agents.find((a) => a.id === saved && selectable(a)) ?? agents.find((a) => a.id === "builtin") ?? null;
}

/**
 * The first-run rule: nothing connected beyond the synthetic rows, no history beyond the demo tape, and no
 * run in flight → the app sends the person to onboarding (App.tsx, on every shell route). Any input still
 * loading (null) means "not yet known".
 */
export function isFirstRun(agents: AgentRow[] | null, runs: RunRow[] | null, loop: LoopState | null): boolean | null {
  if (!agents || !runs || !loop) return null;
  if (loop.running) return false;
  if (agents.some((a) => !a.synthetic)) return false;
  return runs.every((r) => r.id === "golden");
}
