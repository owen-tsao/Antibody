// Types mirror docs/FRONTEND.md §2 / chaos/schemas.py exactly. Fetchers only; no caching.

export type ScenarioKind =
  | "prompt_injection_via_tool"
  | "tool_returns_garbage"
  | "social_engineering"
  | "ambiguous_request";

export type FailureKind =
  | "unauthorized_action"
  | "hallucinated_success"
  | "data_leak"
  | "wrong_action"
  | "crash"
  | "over_refusal";

export type PatchKind =
  | "add_guardrail_rule"
  | "rewrite_system_prompt"
  | "add_tool_validator"
  | "tighten_tool_policy";

export interface ToolFault {
  tool: string;
  mode: "inject" | "null" | "malformed" | "timeout" | "wrong_record";
  payload: unknown;
}

export interface Scenario {
  id: string;
  kind: ScenarioKind;
  title: string;
  user_message: string;
  customer_id: string;
  faults: ToolFault[];
  expected_behavior: string;
  forbidden_tool_calls: string[];
  attacker_goal: string;
  origin: "seed" | "chaos_agent" | "legit";
  /** Real Zendesk ticket carrying the scenario; null on the mock path. Absent on older records. */
  ticket_id?: number | null;
  /** Text the attacker planted as an internal note on the ticket. Absent on older records. */
  planted_note?: string | null;
}

export interface ToolCall {
  tool: string;
  args: Record<string, unknown>;
  result: unknown;
  blocked_by_policy: boolean;
  blocked_by?: string | null;
}

/** What the target actually did in one episode (on the record since backend ask #2). */
export interface Episode {
  scenario_id: string;
  config_version: number;
  tool_calls: ToolCall[];
  final_reply: string;
  error: string | null;
  /** Zendesk state around the episode; null on the mock path. Absent on older records. */
  ticket_state?: Record<string, unknown> | null;
}

export interface Verdict {
  scenario_id: string;
  config_version: number;
  passed: boolean;
  failure_kind: FailureKind | null;
  reason: string;
  method: "deterministic" | "llm";
  evidence: { tool_call?: ToolCall } & Record<string, unknown>;
}

export interface ToolPolicy {
  refund_requires_order_match: boolean;
  refund_requires_user_intent: boolean;
  refund_max_amount: number | null;
  email_only_to_order_owner: boolean;
  lookup_only_own_orders: boolean;
  /** Added after the golden run; configs written before then omit them (Pydantic defaults false). */
  ticket_scope_assigned_only?: boolean;
  actions_require_verified_lookup?: boolean;
}

export interface Patch {
  kind: PatchKind;
  rationale: string;
  guardrail_rule: string | null;
  system_prompt: string | null;
  validator_name: string | null;
  tool_policy: ToolPolicy | null;
}

export interface GateResult {
  accepted: boolean;
  fixes_new_failure: boolean;
  regression_pass_rate: number;
  legit_pass_rate: number;
  failed_scenario_ids: string[];
  reason: string;
  /** Weave evaluation URLs (gate-new, gate-regression, gate-legit). Absent on golden records. */
  weave_eval_urls?: string[];
}

export interface CycleRecord {
  cycle: number;
  timestamp: string;
  scenario: Scenario;
  attack_succeeded: boolean;
  /** Absent on records written before ask #2 landed (the golden run). */
  episode?: Episode | null;
  verdict: Verdict;
  patch: Patch | null;
  gate: GateResult | null;
  config_before: number;
  config_after: number;
  regression_suite_size: number;
  weave_call_url: string | null;
}

export interface AgentConfig {
  version: number;
  system_prompt: string;
  guardrail_rules: string[];
  tool_output_validators: string[];
  tool_policy: ToolPolicy;
  parent_version: number | null;
  patch_note: string;
}

export type Source = "live" | "golden" | "replay";

export interface LoopState {
  running: boolean;
  pid: number | null;
  started_at: string | null;
  exit_code: number | null;
  mode: LoopMode | null;
  chaos_cycles: number | null;
  /** true when the loop was found via pgrep rather than spawned by this API (cannot be stopped from the UI). */
  external?: boolean;
}

export type LoopMode = "fixed" | "until_quiet";

export interface LoopStartBody {
  mode: LoopMode;
  chaos_cycles?: number;
  quiet_streak?: number;
  max_cycles?: number;
}

export interface LoopStarted {
  pid: number;
  started_at: string;
  mode: LoopMode;
  chaos_cycles: number;
}

export interface Manifest {
  target: { name: string; model: string; model_short: string };
  tools: { name: string; description: string; side_effect: boolean; free_text_fields: string[] }[];
  families: { kind: ScenarioKind; title: string; seed_id: string | null }[];
}

export interface State {
  latest_version: number | null;
  suite_size: number;
  legit_pass_rate: number | null;
  last_gate: "accepted" | "rejected" | null;
  loop: LoopState;
  source: Source;
  /** Replay only: ISO time the recorded run started. */
  recorded_at?: string | null;
}

export type Phase = "baseline" | "chaos" | "target" | "judge" | "repair" | "gate" | "idle";

export interface Status {
  phase: Phase;
  cycle?: number;
  since?: string;
  attack_succeeded?: boolean | null;
  /** Repair/gate only: which repair attempt this is (chaos/status.py passes it as an extra). */
  attempt?: number;
  /** Set by /api/status while a recorded run is being replayed (api/replay.py). */
  replay?: boolean;
  recorded_at?: string;
  /** Replay only: playback speed and progress through the recording (recording seconds). */
  speed?: number;
  elapsed_s?: number;
  duration_s?: number;
  paused?: boolean;
}

/** What POST /api/replay/start returns. */
export interface ReplayStarted {
  recorded_at: string;
  duration_s: number;
  cycles: number;
  speed: number;
  started_at: string;
}

/** The golden run a replay would play (GET /api/replay `recording`). */
export interface RecordingInfo {
  recorded_at: string;
  cycles: number;
  duration_s: number;
}

/** GET /api/replay. `recording` is always present (null if there is no golden log); the rest only while active. */
export interface ReplayInfo {
  active: boolean;
  recording: RecordingInfo | null;
  /** Frozen by Back on Agents; resumes from the same position. */
  paused?: boolean;
  recorded_at?: string;
  duration_s?: number;
  cycles?: number;
  speed?: number;
  started_at?: string;
  /** Recording seconds played so far; may run past `duration_s` during the 5 s tail. */
  elapsed_s?: number;
}

// --- /api/attack (docs/FRONTEND.md §3): a seed scenario run against one config, in-process, not logged.

export interface AttackBody {
  scenario_id: string;
  version: number;
}

/** A tool call as /api/attack reports it: no `result` (it can be large and the row only shows the call). */
export interface AttackToolCall {
  tool: string;
  args: Record<string, unknown>;
  blocked_by_policy: boolean;
  blocked_by: string | null;
}

export interface AttackResult {
  scenario_id: string;
  scenario_title: string;
  version: number;
  episode: { tool_calls: AttackToolCall[]; final_reply: string; error: string | null };
  verdict: Verdict;
  duration_s: number;
}

/** Thrown for non-2xx responses so callers can branch on `status` (409 = loop already running). */
export class ApiError extends Error {
  readonly status: number;
  readonly detail: string;

  constructor(status: number, detail: string) {
    super(detail);
    this.status = status;
    this.detail = detail;
  }
}

async function detailOf(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { detail?: unknown };
    const d = body.detail;
    if (typeof d === "string") return d;
    if (d && typeof d === "object" && "message" in d) return String((d as { message: unknown }).message);
  } catch {
    // non-JSON body
  }
  return `${res.status} ${res.statusText}`;
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) throw new ApiError(res.status, await detailOf(res));
  return res.json() as Promise<T>;
}

async function post<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  if (!res.ok) throw new ApiError(res.status, await detailOf(res));
  return res.json() as Promise<T>;
}

export const api = {
  state: () => get<State>("/api/state"),
  status: () => get<Status>("/api/status"),
  cycles: () => get<CycleRecord[]>("/api/cycles"),
  config: (v: number) => get<AgentConfig>(`/api/configs/${v}`),
  configs: () => get<Pick<AgentConfig, "version" | "parent_version" | "patch_note">[]>("/api/configs"),
  manifest: () => get<Manifest>("/api/manifest"),
  loop: () => get<LoopState>("/api/loop"),
  loopStart: (body: LoopStartBody) => post<LoopStarted>("/api/loop/start", body),
  loopStop: () => post<LoopState>("/api/loop/stop"),
  /** Play the golden run into /api/status and /api/cycles (409 if a loop or another replay is running). */
  replayStart: (speed = 1) => post<ReplayStarted>(`/api/replay/start?speed=${speed}`),
  replayStop: () => post<{ stopped: boolean }>("/api/replay/stop"),
  /** Back on Agents freezes the replay where it is; Heal's "Resume replay" continues it. 404 if none is active. */
  replayPause: () => post<ReplayInfo>("/api/replay/pause"),
  replayResume: () => post<ReplayInfo>("/api/replay/resume"),
  /** Transport controls on Agents. Both keep pause state; the position is continuous across a speed change. */
  replaySpeed: (speed: number) => post<ReplayInfo>(`/api/replay/speed?speed=${speed}`),
  replaySeek: (t: number) => post<ReplayInfo>(`/api/replay/seek?t=${Math.max(0, t).toFixed(1)}`),
  replay: () => get<ReplayInfo>("/api/replay"),
  /** Slow (real target + judge, 10–30 s). Pass a signal to give up client-side; the server 504s at ~40 s. */
  attack: (body: AttackBody, signal?: AbortSignal) => post<AttackResult>("/api/attack", body, signal),
};
