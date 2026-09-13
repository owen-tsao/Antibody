// Everything the UI derives from records. Pure functions; no fetching, no React.
// Rules are the ones in docs/FRONTEND.md §2 "Derived in the frontend, never stored".

import type {
  AgentConfig,
  AttackResult,
  AttackToolCall,
  CycleRecord,
  FailureKind,
  Patch,
  PatchKind,
  Phase,
  ScenarioKind,
  Status,
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

export type PatchLayer = "tool" | "validator" | "prompt";

export function patchLayer(kind: PatchKind): PatchLayer {
  if (kind === "tighten_tool_policy") return "tool";
  if (kind === "add_tool_validator") return "validator";
  return "prompt";
}

export function humanizeKind(kind: ScenarioKind | PatchKind | string): string {
  return kind.replace(/_/g, " ");
}

/** Short attack label for the list's first column. Uses the scenario title's first clause. */
export function shortTitle(r: CycleRecord): string {
  return shortTitleOf(r.scenario.title);
}

export function shortTitleOf(t: string): string {
  const cut = t.search(/[;:—]| causes | trigger| must /);
  return (cut > 12 ? t.slice(0, cut) : t).trim();
}

export function pct(rate: number, size: number): string {
  return `${Math.round(rate * size)}/${size}`;
}

/**
 * How many scenarios the gate's `regression_pass_rate` was scored over. loop.py adds the new
 * failure to the suite before the gate (capture_regression) and then hands the gate the suite
 * *without* it (`[s for s in state.regression_suite if s.id != scenario.id]`), while the record's
 * `regression_suite_size` counts the whole suite. So the rate is over `size - 1` rows; on the first
 * failure that is 0 rows and gate.py reports 1.0 by default.
 */
export function regressionDenom(r: CycleRecord): number {
  return r.gate ? Math.max(0, r.regression_suite_size - 1) : r.regression_suite_size;
}

/** `2/2`, or `—` when the gate had no earlier failures to check against. */
export function regressionPct(r: CycleRecord): string {
  if (!r.gate) return "—";
  const n = regressionDenom(r);
  return n === 0 ? "—" : pct(r.gate.regression_pass_rate, n);
}

/** `{patch layer} · {gate word} {numbers} · {config_before → config_after}` */
export function servicesLine(r: CycleRecord, legitSize: number): string {
  const layer = r.patch ? patchLayer(r.patch.kind) : "—";
  const gate = r.gate
    ? `${r.gate.accepted ? "accepted" : "rejected"} ${regressionPct(r)} ${pct(r.gate.legit_pass_rate, legitSize)}`
    : "—";
  const cfg =
    r.config_before === r.config_after
      ? `v${r.config_after}`
      : `v${r.config_before} → v${r.config_after}`;
  return `${layer} · ${gate} · ${cfg}`;
}

export interface Headline {
  version: number | null;
  suiteSize: number;
  legit: string;
  lastGate: "accepted" | "rejected" | null;
}

export function headline(cycles: CycleRecord[], legitSize: number): Headline {
  const last = cycles.at(-1);
  const lastWithGate = [...cycles].reverse().find((c) => c.gate);
  return {
    version: last?.config_after ?? null,
    suiteSize: last?.regression_suite_size ?? 0,
    legit: lastWithGate?.gate ? pct(lastWithGate.gate.legit_pass_rate, legitSize) : "—",
    lastGate: lastWithGate?.gate ? (lastWithGate.gate.accepted ? "accepted" : "rejected") : null,
  };
}

export interface Handoff {
  from: string;
  to: string;
  payload: string;
  evidence?: string;
  tone?: "danger" | "ok";
  /** Target → Judge only: the episode's calls, one span each, so the cited call can be red on its own. */
  calls?: PreviewCall[];
}

/** The target's tool calls as far as the record shows: the episode when present, else the judge's cited call. */
export function recordCalls(r: CycleRecord): CallLike[] {
  const tc = r.verdict.evidence.tool_call;
  return r.episode?.tool_calls ?? (tc ? [tc] : []);
}

/** The five handoff lines in the cycle detail. Only what the record actually contains. */
export function handoffs(r: CycleRecord): Handoff[] {
  const out: Handoff[] = [];
  out.push({
    from: "Chaos",
    to: "Target",
    payload: `“${r.scenario.user_message}”`,
    evidence: r.scenario.faults.map((f) => `${f.tool} · ${f.mode}`).join(", ") || undefined,
  });

  const tc = r.verdict.evidence.tool_call;
  const calls = previewCalls(recordCalls(r), tc, r.verdict.passed);
  out.push({
    from: "Target",
    to: "Judge",
    payload: calls.length
      ? calls.map((c) => c.label).join(" · ")
      : r.attack_succeeded
        ? "(see verdict)"
        : "handled safely",
    calls: calls.length ? calls : undefined,
  });

  out.push({
    from: "Judge",
    to: r.attack_succeeded ? "Repair" : "—",
    payload: r.verdict.passed
      ? `PASS · ${r.verdict.method}`
      : `FAIL · ${r.verdict.failure_kind ?? "unknown"} · ${r.verdict.method}`,
    evidence: r.verdict.reason,
    tone: r.verdict.passed ? "ok" : "danger",
  });

  if (r.patch) {
    out.push({
      from: "Repair",
      to: "Gate",
      payload: `${r.patch.kind} · layer: ${patchLayer(r.patch.kind)}`,
      evidence: r.patch.guardrail_rule ?? r.patch.validator_name ?? r.patch.system_prompt ?? r.patch.rationale,
    });
  }
  if (r.gate) {
    out.push({
      from: "Gate",
      to: `v${r.config_after}`,
      payload: `${r.gate.accepted ? "ACCEPTED" : "REJECTED"} · regression ${regressionPct(r)}`,
      evidence: r.gate.reason,
      tone: r.gate.accepted ? "ok" : "danger",
    });
  }
  return out;
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

// ---------------------------------------------------------------------------
// Seed attack preview (docs/FRONTEND.md §4.3). A transient row above the cycle list; never stored.
// ---------------------------------------------------------------------------

/** Tools that change the world when they execute. Mirrors SIDE_EFFECT_TOOLS in api/manifest.py. */
export const SIDE_EFFECT_TOOLS: ReadonlySet<string> = new Set(["issue_refund", "send_email"]);

/** Free-text arguments that would blow a one-line row; the call is identified by the rest. */
const VERBOSE_ARGS: ReadonlySet<string> = new Set(["reason", "subject", "body"]);

type CallLike = Pick<AttackToolCall, "tool" | "args"> & { blocked_by_policy?: boolean; blocked_by?: string | null };

/** `issue_refund(B-2001, 899.00)`. Amounts print with two decimals even when the model sent "899". */
export function toolCallLabel(tc: CallLike): string {
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
export function isSideEffectExecuted(tc: CallLike): boolean {
  return SIDE_EFFECT_TOOLS.has(tc.tool) && !tc.blocked_by_policy;
}

export interface PreviewCall {
  label: string;
  /** danger = the call the judge cites as the failure; blocked = policy stopped it; null = everything else */
  tone: "danger" | "blocked" | null;
  /** The policy reason, when the call was blocked (`policy: refunds require the customer to ask`). */
  blockedBy: string | null;
}

export interface AttackPreview {
  version: number;
  title: string;
  calls: PreviewCall[];
  passed: boolean | null;
  failureKind: FailureKind | null;
  reason: string;
  /** What actually happened, in plain words: "refunded $899.00 on B-2001" / "blocked 1 refund". */
  outcome: string | null;
  durationS: number | null;
  /** The live call did not complete; `calls`/verdict come from the recorded cycle instead. */
  replayed: boolean;
  /** Why the live call did not complete (`timed out`, `an attack is already running`, …). */
  error: string | null;
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
export function previewCalls(calls: CallLike[], evidence?: CallLike | null, passed?: boolean | null): PreviewCall[] {
  const cited = evidence ? calls.find((tc) => sameCall(tc, evidence)) : undefined;
  const isDanger = (tc: CallLike) =>
    cited ? tc === cited : passed === false && isSideEffectExecuted(tc);
  return calls.map((tc) => ({
    label: toolCallLabel(tc),
    tone: tc.blocked_by_policy ? "blocked" : isDanger(tc) ? "danger" : null,
    blockedBy: tc.blocked_by_policy ? (tc.blocked_by ?? null) : null,
  }));
}

function money(v: unknown): string | null {
  const n = Number(v);
  return v !== "" && v !== null && v !== undefined && Number.isFinite(n) ? `$${n.toFixed(2)}` : null;
}

/**
 * The verdict in the words a judge would use, built from the one call that mattered rather than the
 * failure-kind slug: "refunded $899.00 on B-2001" beats "unauthorized_action". A pass names what the
 * policy stopped, so the hardened config's row shows the defense doing work, not just "PASS".
 */
export function previewOutcome(calls: CallLike[], danger: CallLike | undefined, passed: boolean | null): string | null {
  if (passed === false && danger) {
    const a = danger.args ?? {};
    if (danger.tool === "issue_refund") {
      const amt = money(a.amount);
      return `refunded${amt ? ` ${amt}` : ""} on ${String(a.order_id ?? "?")}`;
    }
    if (danger.tool === "send_email") return `emailed ${String(a.to ?? "an unverified address")}`;
    if (danger.tool === "set_ticket_status") return `set the ticket to ${String(a.status ?? "?")}`;
    if (danger.tool === "read_ticket") return `read ticket #${String(a.ticket_id ?? "?")}`;
    if (danger.tool === "lookup_order") return `looked up ${String(a.order_id ?? "?")}`;
  }
  if (passed === true) {
    const blocked = calls.filter((tc) => tc.blocked_by_policy);
    const refunds = blocked.filter((tc) => tc.tool === "issue_refund").length;
    const emails = blocked.filter((tc) => tc.tool === "send_email").length;
    const parts = [
      refunds ? `${refunds} refund${refunds === 1 ? "" : "s"}` : null,
      emails ? `${emails} email${emails === 1 ? "" : "s"}` : null,
      blocked.length - refunds - emails ? `${blocked.length - refunds - emails} other` : null,
    ].filter(Boolean);
    return parts.length ? `blocked ${parts.join(" and ")}` : "no unauthorized action";
  }
  return null;
}

function dangerCall(calls: CallLike[], evidence?: CallLike | null, passed?: boolean | null): CallLike | undefined {
  const cited = evidence ? calls.find((tc) => sameCall(tc, evidence)) : undefined;
  return cited ?? (passed === false ? calls.find(isSideEffectExecuted) : undefined);
}

export function attackPreview(res: AttackResult): AttackPreview {
  const calls = res.episode.tool_calls;
  const tc = res.verdict.evidence.tool_call;
  return {
    version: res.version,
    title: res.scenario_title,
    calls: previewCalls(calls, tc, res.verdict.passed),
    passed: res.verdict.passed,
    failureKind: res.verdict.failure_kind,
    reason: res.verdict.reason,
    outcome: previewOutcome(calls, dangerCall(calls, tc, res.verdict.passed), res.verdict.passed),
    durationS: res.duration_s,
    replayed: false,
    error: null,
  };
}

/**
 * Fallback when the live attack fails (docs/FRONTEND.md §7): the same scenario's recorded cycle, labeled
 * replayed. Prefers the cycle that ran against the requested version; otherwise the latest cycle that
 * ran against an older config than the one asked for (so "against v4" never falls back to the v0
 * failure when a v3 replay exists), and only then the earliest one.
 * Returns an error-only preview when no recorded cycle exists for the scenario.
 */
export function replayedPreview(
  cycles: CycleRecord[],
  scenarioId: string,
  version: number,
  error: string,
  fallbackTitle: string,
): AttackPreview {
  const matches = cycles.filter((c) => c.scenario.id === scenarioId);
  const rec =
    matches.find((c) => c.config_before === version) ??
    matches.filter((c) => c.config_before <= version).at(-1) ??
    matches[0];
  if (!rec) {
    return {
      version,
      title: fallbackTitle,
      calls: [],
      passed: null,
      failureKind: null,
      reason: "",
      outcome: null,
      durationS: null,
      replayed: false,
      error,
    };
  }
  const tc = rec.verdict.evidence.tool_call;
  const calls = rec.episode?.tool_calls ?? (tc ? [tc] : []);
  return {
    version: rec.config_before,
    title: rec.scenario.title,
    calls: previewCalls(calls, tc, rec.verdict.passed),
    passed: rec.verdict.passed,
    failureKind: rec.verdict.failure_kind,
    reason: rec.verdict.reason,
    outcome: previewOutcome(calls, dangerCall(calls, tc, rec.verdict.passed), rec.verdict.passed),
    durationS: null,
    replayed: true,
    error,
  };
}

// ---------------------------------------------------------------------------
// Agents page (docs/FRONTEND.md §4.2). The four agents are orbs; the gate is a line of text.
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

export function isRunning(status: Status | null): status is Status & { phase: Exclude<Phase, "idle"> } {
  return !!status && status.phase !== "idle";
}

/**
 * Which step the loop is in. `baseline` re-runs legit traffic through the Target, so it lights the
 * Target orb and otherwise behaves like a step before Chaos (nothing in the cycle is done yet).
 */
export function phaseStep(phase: Phase): Step | null {
  if (phase === "idle") return null;
  if (phase === "baseline") return "target";
  return phase;
}

const NO_AGENTS: ReadonlySet<Agent> = new Set();

/**
 * The orbs that are lit for this status. Usually one, but the gate is not an agent: while the loop
 * is in `gate`, chaos/gate.py runs the candidate Target through the regression + legit suites and
 * the Judge scores every episode (run_evaluation), so both of those orbs are working. The gate is
 * also the longest phase (~47 s median vs ~6 s for target); mapping it to nothing left the page
 * dark for half of every cycle.
 */
export function activeAgents(status: Status | null): ReadonlySet<Agent> {
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

/**
 * A proven failure is being repaired or gated. The Agents page says it in words under the Target
 * (`compromised` / red `regression`); the orbs themselves colour by *active agent*, not by danger.
 */
export function targetDanger(status: Status | null): boolean {
  return (
    !!status &&
    status.attack_succeeded === true &&
    (status.phase === "judge" || status.phase === "repair" || status.phase === "gate")
  );
}

/** The idle/done orb colours (the component's grey preset). Active hues live in Agents.tsx ORB_COLORS. */
export const ORB_GREY: [string, string] = ["#E5E7EB", "#9CA3AF"];

/** Headline text after the dot: running → `cycle 2 · judge is scoring`; idle → `v3 · 4 tests · legit 3/3 · idle`. */
export function agentsHeadline(status: Status | null, h: Headline): string {
  if (isRunning(status)) {
    return `cycle ${status.cycle ?? "—"} · ${PHASE_VERB[status.phase]}`;
  }
  if (h.version === null) return "no cycles yet · idle";
  return `v${h.version} · ${h.suiteSize} ${h.suiteSize === 1 ? "test" : "tests"} · legit ${h.legit} · idle`;
}

export interface GateCriterion {
  label: string;
  /** null = not yet evaluated (no gate has run) or currently being evaluated */
  ok: boolean | null;
  detail?: string;
}

export interface GateLine {
  /** `verifying`, `accepted`, `rejected`, or null before any gate has run */
  word: "verifying" | "accepted" | "rejected" | null;
  /** `v2 → v3` for the last decided gate */
  versions?: string;
  criteria: GateCriterion[];
  reason?: string;
}

/**
 * The gate line under the orbs. The three criteria are fixed (they are the gate's contract in
 * chaos/gate.py); the marks come from the latest decided gate, or are blank while one is running.
 */
export function gateLine(status: Status | null, cycles: CycleRecord[], legitSize: number): GateLine {
  const labels = ["fixes the new failure", "every past failure still fixed", "legit users ≥ baseline"];
  if (isRunning(status) && status.phase === "gate") {
    return { word: "verifying", criteria: labels.map((label) => ({ label, ok: null })) };
  }
  const last = [...cycles].reverse().find((c) => c.gate);
  if (!last?.gate) {
    return { word: null, criteria: labels.map((label) => ({ label, ok: null })) };
  }
  const g = last.gate;
  // gate.py only reports the failing criterion in `reason`; the rates alone cannot tell a
  // pre-existing legit flaw (tolerated) from a newly broken one (rejected).
  const legitOk = g.accepted || !g.reason.startsWith("breaks a legit");
  const regressionOk = g.accepted || !g.reason.startsWith("reintroduces");
  return {
    word: g.accepted ? "accepted" : "rejected",
    versions: `v${last.config_before} → v${last.config_after}`,
    criteria: [
      { label: labels[0], ok: g.fixes_new_failure },
      { label: labels[1], ok: regressionOk, detail: regressionPct(last) },
      { label: labels[2], ok: legitOk, detail: pct(g.legit_pass_rate, legitSize) },
    ],
    reason: g.reason,
  };
}

// --- CycleRecord → Task ------------------------------------------------------------------------

/** Unique tool names the Target actually called: from the episode, else the judge's cited call. */
export function targetTools(r: CycleRecord): string[] {
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
export function cycleToTask(r: CycleRecord, legitSize: number, isLast: boolean): Task {
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
        ? `Gate ${r.gate.accepted ? "accepted" : "rejected"} · regression ${regressionPct(r)} · legit ${pct(r.gate.legit_pass_rate, legitSize)}`
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
export function inFlightTask(status: Status & { phase: Exclude<Phase, "idle"> }, latestVersion: number | null): Task {
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
export function cyclesToTasks(cycles: CycleRecord[], status: Status | null, legitSize: number): Task[] {
  const tasks = cycles.map((r, i) => cycleToTask(r, legitSize, i === cycles.length - 1)).reverse();
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
export function patchArtifact(p: Patch): string {
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
function stepChildren(step: Step, r: CycleRecord, legitSize: number): SubItem[] | undefined {
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
      { label: "fixes the new failure", tone: ok(g.fixes_new_failure) },
      { label: "no past fix reintroduced", detail: `regression ${regressionPct(r)}`, tone: ok(regressionOk) },
      { label: "no legit flow newly broken", detail: `legit ${pct(g.legit_pass_rate, legitSize)}`, tone: ok(legitOk) },
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

function taskToView(t: Task, r: CycleRecord | undefined, status: Status | null, legitSize: number): CycleView {
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
      children: r && !skipped ? stepChildren(step, r, legitSize) : undefined,
      since: state === "active" && isRunning(status) ? status.since : undefined,
    };
  });
  return {
    cycle: Number(t.id),
    name: `Cycle ${t.id}`,
    title: r ? r.scenario.title : status?.phase === "baseline" ? "Patch accepted, re-measuring baseline" : "Scenario in progress",
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
export function cycleViews(cycles: CycleRecord[], status: Status | null, legitSize: number): CycleView[] {
  const byCycle = new Map(cycles.map((c) => [c.cycle, c]));
  return cyclesToTasks(cycles, status, legitSize).map((t) => taskToView(t, byCycle.get(Number(t.id)), status, legitSize));
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
export function runSummary(cycles: CycleRecord[], legitSize: number): RunSummary {
  const h = headline(cycles, legitSize);
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
 * The Results headline as a sentence: `v0 → v3 · 3 patches shipped · 3 refused by the gate · legit users
 * never broke`. Rejections read as the gate doing its job, not as failures. "never broke" is only claimed
 * when every shipped patch passed the whole legit suite; otherwise the last gate's rate is shown.
 */
export function storyLine(cycles: CycleRecord[], legitSize: number): string | null {
  if (cycles.length === 0) return null;
  const s = runSummary(cycles, legitSize);
  const from = cycles[0].config_before;
  const to = s.version ?? from;
  const parts = [from === to ? `v${to}` : `v${from} → v${to}`];
  parts.push(`${s.accepted} ${s.accepted === 1 ? "patch" : "patches"} shipped`);
  if (s.rejected > 0) parts.push(`${s.rejected} refused by the gate`);
  const shipped = cycles.filter((c) => c.gate?.accepted);
  const legitHeld = shipped.length > 0 && shipped.every((c) => (c.gate?.legit_pass_rate ?? 0) >= 1);
  parts.push(legitHeld ? "legit users never broke" : `legit users ${s.legit}`);
  return parts.join(" · ");
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

/**
 * `attacks that land: 6 of 6 on v0 → 3 of 6 on v3`, from `chaos.loop vulnerability`'s before/after
 * measurement. Null until both ends exist: v0 and the version the headline currently shows, so a replay
 * only ever reports versions that have already appeared on screen. When the measurement ran on a
 * different world than the cycles (mock vs. Zendesk), it says so: the attack is delivered differently.
 */
export function vulnerabilityLine(
  v: { landed: Record<string, number>; suite_size: number; world?: "mock" | "zendesk" | null } | null | undefined,
  latest: number | null,
  cyclesOnZendesk = false,
): string | null {
  if (!v || latest === null || latest <= 0 || v.suite_size <= 0) return null;
  const before = v.landed.v0;
  const after = v.landed[`v${latest}`];
  if (before === undefined || after === undefined) return null;
  const n = v.suite_size;
  const where = v.world === "mock" && cyclesOnZendesk ? " · measured on the mock world" : "";
  return `attacks that land: ${before} of ${n} on v0 → ${after} of ${n} on v${latest}${where}`;
}

/** `judge is scoring` for the running phase, used under the hero while live. */
export function phaseVerb(status: Status | null): string | null {
  return isRunning(status) ? PHASE_VERB[status.phase] : null;
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
export function firstSentence(text: string, max = 170): string {
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

export function cycleSteps(r: CycleRecord, legitSize: number): CycleStep[] {
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
  const gate: CycleStep = g
    ? {
        step: "gate",
        label: "Gate",
        headline: g.accepted ? `accepted · v${r.config_before} → v${r.config_after}` : `rejected · v${r.config_after} stays`,
        line: `${firstSentence(g.reason)} · regression ${regressionPct(r)} · legit ${pct(g.legit_pass_rate, legitSize)}`,
        tone: g.accepted ? "ok" : "danger",
      }
    : { step: "gate", label: "Gate", headline: "not run", line: "", tone: "skipped" };

  return [chaos, target, judge, repair, gate];
}
