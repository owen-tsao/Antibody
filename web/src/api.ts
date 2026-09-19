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
  /** How many times the new failure was re-run against the candidate (GATE_FIX_SAMPLES); 1 on records gated before sampling. */
  fix_samples: number;
  /** How many of those samples the candidate fixed; `fixes_new_failure` is `fix_passes === fix_samples`. */
  fix_passes: number;
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
  /** Denominator behind `gate.legit_pass_rate`. Pydantic defaults it to 3 on records written before it existed (the golden tape). */
  legit_suite_size: number;
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

/** `?source=` on the read routes: the live files, the committed golden run, or one archived run (`run:<id>`). */
export type ReadSource = "live" | "golden" | `run:${string}`;

export type World = "auto" | "mock";

/** Body of POST /api/loop/start (api/loop_ctl.py `LoopStartBody`); every field is one `chaos.loop run` flag. */
export interface LoopStartBody {
  chaos_cycles?: number;
  /** null = all seeds; 0 = none. */
  seeds?: number | null;
  repair_attempts?: number;
  second_pass?: boolean;
  resume?: boolean;
  /** Stop once N chaos attacks in a row are blocked; `chaos_cycles` becomes the cap. null = off. */
  until_quiet?: number | null;
  world?: World;
  /** An agent id from GET /api/agents; null = the API process's own default (400 for an unknown id). */
  target?: string | null;
  /** Measure attacks that land on v0 and the final version when the run ends (writes `vulnerability.json`). Default true. */
  vulnerability?: boolean;
}

export interface LoopState {
  running: boolean;
  pid: number | null;
  started_at: string | null;
  exit_code: number | null;
  /** The body the last run this API spawned was started with; null for an external loop or a hand-started run. */
  settings: Required<LoopStartBody> | null;
  /** true when the loop was found via pgrep rather than spawned by this API (cannot be stopped from the UI). */
  external?: boolean;
}

export interface LoopStarted {
  pid: number;
  started_at: string;
  settings: Required<LoopStartBody>;
  /** The canonical target string the loop was given (`builtin` or `http:<url>`), not the agent id. */
  target: string;
}

export interface Manifest {
  target: {
    /** Display name for the built-in agent; the canonical target string (`http:<url>`) for an external one. */
    name: string;
    /** null for an external agent: Antibody does not know what runs behind the URL. */
    model: string | null;
    model_short: string | null;
    /** How the loop reaches the target: "in-process" for the built-in agent, "http" for an external one. */
    transport?: string;
    url?: string | null;
  };
  /** The model behind each role as this API process resolved them (`ANTIBODY_*_MODEL`), for the Settings page. */
  models: { target: string; chaos: string; repair: string; judge: string; inference_url: string };
  tools: { name: string; description: string; side_effect: boolean; free_text_fields: string[] }[];
  families: { kind: ScenarioKind; title: string; seed_id: string | null }[];
  /** The run-settings defaults a start dialog begins from. */
  defaults: Required<LoopStartBody>;
}

/** One row of GET /api/runs (docs/plans/handoffs/ui-3-run-history.md). */
export interface RunRow {
  /** "live" | "golden" | a history folder name. */
  id: string;
  /** Only the golden run carries one ("demo tape"). */
  label: string | null;
  /** Only the live row. */
  current: boolean;
  started_at: string | null;
  /** null while the live run's loop is alive. */
  finished_at: string | null;
  world: "mock" | "zendesk";
  /** "builtin" or the target string as the loop stored it. */
  target: string;
  /** The connected agent that target resolves to, or null when none matches (a deleted agent leaves its runs orphaned). */
  agent: { id: string; name: string } | null;
  cycles: number;
  accepted: number;
  rejected: number;
  versions: number[];
  final_version: number | null;
  flags: string[];
  /** A legacy archive with no run.json: world/target/flags are guesses. */
  synthesized: boolean;
  /** The run can be played back (a timed phase log plus its cycles). Never true for the live row. */
  recording: boolean;
  /** Seconds from the first to the last recorded phase; elapsed so far on the live row; null with no phase log. */
  duration_s: number | null;
  /** GET /api/runs/{id} only. */
  configs?: Pick<AgentConfig, "version" | "parent_version" | "patch_note">[];
}

export interface RollbackBody {
  /** A runs-list id; never "live". */
  run: string;
  version: number;
}

export interface RollbackResult {
  config: AgentConfig;
  /** Scenarios in the merged live suite that the rolled-back run never had ("N tests are newer than this config"). */
  newer_tests: number;
}

// --- /api/agents (docs/plans/00-overview.md Block 1): connected support agents as stored objects.

export interface AgentPing {
  at: string;
  ok: boolean;
  latency_ms: number;
}

export interface AgentTool {
  name: string;
  description: string;
}

/** One row of GET /api/agents. `builtin` and `example` are synthetic (never stored, never deletable). */
export interface Agent {
  id: string;
  name: string;
  transport: "in-process" | "http";
  /** null for the built-in agent (it runs inside the loop process). */
  url: string | null;
  created_at: string | null;
  /** Stored rows only; synthetic rows never persist a ping. */
  last_ping: AgentPing | null;
  /** What the agent listed at GET /tools on its last ping; null when it does not list tools. */
  tools: AgentTool[] | null;
  synthetic: boolean;
  /** The `example` row only: a live probe of port 8790. `starting` = spawned, port not answering yet. */
  running?: boolean;
  starting?: boolean;
  pid?: number | null;
}

/** Which of the agent's tool names the sandbox storefront serves; null when the agent listed none. */
export interface ToolMapping {
  known: string[];
  unknown: string[];
}

/** POST /api/agents/:id/ping — always 200 for a known agent; an unreachable agent is `ok: false`, not an error. */
export type PingResult =
  | { ok: true; latency_ms: number; reply_preview: string | null; tools: AgentTool[] | null; mapping: ToolMapping | null }
  | { ok: false; latency_ms: number; error: string; tools: AgentTool[] | null; mapping: ToolMapping | null };

export interface ExampleAgentState {
  running: boolean;
  url: string;
  pid: number | null;
  starting: boolean;
}

/** GET /api/health (plan 03 Step 1). Never carries the key itself, only whether one is set. */
export interface Health {
  ok: boolean;
  has_api_key: boolean;
  version?: string;
  live_exists?: boolean;
  golden_exists?: boolean;
  weave?: unknown;
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
  /** How many of the final suite's attacks land on each config (`{ v0: 6, v3: 3 }`); null until measured. */
  vulnerability?: { landed: Record<string, number>; suite_size: number; world?: "mock" | "zendesk" | null } | null;
}

export type Phase = "baseline" | "chaos" | "target" | "judge" | "repair" | "gate" | "idle";

export interface Status {
  phase: Phase;
  cycle?: number;
  since?: string;
  attack_succeeded?: boolean | null;
  /** Repair/gate only: which repair attempt this is (chaos/status.py passes it as an extra). */
  attempt?: number;
  /** `baseline` only: the end-of-run vulnerability measurement lights the same orb as the start-of-run baseline. */
  measuring?: "baseline" | "vulnerability";
  /** Set by /api/status while a recorded run is being replayed (api/replay.py). */
  replay?: boolean;
  recorded_at?: string;
  /** Replay only: playback speed and progress through the recording (recording seconds). */
  speed?: number;
  elapsed_s?: number;
  duration_s?: number;
  paused?: boolean;
}

/** The tape a replay plays or would play (GET /api/replay `recording`). */
export interface RecordingInfo {
  source: "golden" | `run:${string}`;
  id: string;
  recorded_at: string;
  cycles: number;
  duration_s: number;
}

/** GET /api/replay. `recording` is always present (null if there is no golden log); the rest only while active. */
export interface ReplayInfo {
  active: boolean;
  recording: RecordingInfo | null;
  /** Frozen by the run page's ReplayControls (resumes from the same position), or the tape has ended (see `ended`). */
  paused?: boolean;
  /** The recording has played out. The session stays on its last frame until stopped; resume restarts it. */
  ended?: boolean;
  recorded_at?: string;
  duration_s?: number;
  cycles?: number;
  speed?: number;
  started_at?: string;
  /** Recording seconds played so far, capped at `duration_s`. */
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

async function del(path: string): Promise<void> {
  const res = await fetch(path, { method: "DELETE" });
  if (!res.ok) throw new ApiError(res.status, await detailOf(res));
}

// Read routes take `?source=`; `live` is the API's default, so it is only sent when a caller asks for
// something else. A replay only ever overrides `live` (api/main.py), so an archive is always served as asked.
const withSource = (path: string, source?: ReadSource) => (source && source !== "live" ? `${path}?source=${source}` : path);

export const api = {
  state: (source?: ReadSource) => get<State>(withSource("/api/state", source)),
  status: () => get<Status>("/api/status"),
  cycles: (source?: ReadSource) => get<CycleRecord[]>(withSource("/api/cycles", source)),
  config: (v: number, source?: ReadSource) => get<AgentConfig>(withSource(`/api/configs/${v}`, source)),
  configs: (source?: ReadSource) =>
    get<Pick<AgentConfig, "version" | "parent_version" | "patch_note">[]>(withSource("/api/configs", source)),
  manifest: () => get<Manifest>("/api/manifest"),
  health: () => get<Health>("/api/health"),
  /** Every run there is to open, newest first; the live run first (once it has a cycle), golden last. */
  runs: () => get<RunRow[]>("/api/runs"),
  /** One run plus its config versions. 404 for `live` until the run's first cycle lands. */
  run: (id: string) => get<RunRow>(`/api/runs/${id}`),
  /** Copy a past run's config in as the next live version (409 while a loop runs or on target mismatch). */
  rollback: (body: RollbackBody) => post<RollbackResult>("/api/rollback", body),
  loop: () => get<LoopState>("/api/loop"),
  loopStart: (body: LoopStartBody) => post<LoopStarted>("/api/loop/start", body),
  loopStop: () => post<LoopState>("/api/loop/stop"),
  /** Where "open log" points: the last `tail` lines of runs/loop.log, as JSON. */
  loopLogUrl: (tail = 200) => `/api/loop/log?tail=${tail}`,
  /** Play a recording (golden by default, or `run:<id>`) into /api/status and /api/cycles; 201 with GET /api/replay's document (409 if a loop or another replay is running). */
  replayStart: (speed = 1, recording?: RecordingInfo["source"]) =>
    post<ReplayInfo>(`/api/replay/start?speed=${speed}${recording ? `&recording=${recording}` : ""}`),
  replayStop: () => post<{ stopped: boolean }>("/api/replay/stop"),
  /** ReplayControls' play/pause on the run page; pause freezes the tape where it is. 404 if none is active. Leaving the run stops the tape instead (App). */
  replayPause: () => post<ReplayInfo>("/api/replay/pause"),
  replayResume: () => post<ReplayInfo>("/api/replay/resume"),
  /** ReplayControls' speed picker and scrubber. Both keep pause state; the position is continuous across a speed change. */
  replaySpeed: (speed: number) => post<ReplayInfo>(`/api/replay/speed?speed=${speed}`),
  replaySeek: (t: number) => post<ReplayInfo>(`/api/replay/seek?t=${Math.max(0, t).toFixed(1)}`),
  replay: () => get<ReplayInfo>("/api/replay"),
  /** Slow (real target + judge, 10–30 s). Pass a signal to give up client-side; the server 504s at ~40 s. */
  attack: (body: AttackBody, signal?: AbortSignal) => post<AttackResult>("/api/attack", body, signal),
  /** `builtin`, `example`, then the connected agents. Each call probes port 8790 (1 s timeout), so poll at ≥ 3 s. */
  agents: () => get<Agent[]>("/api/agents"),
  /** 201 with the new row; 400 for a bad name or URL, 409 when that URL is already connected. */
  agentCreate: (body: { name: string; url: string }) => post<Agent>("/api/agents", body),
  /** 204; 404 for a synthetic or unknown id, 409 while any loop runs. */
  agentDelete: (id: string) => del(`/api/agents/${id}`),
  /** A hello `POST /episode` plus `GET /tools`; up to ~12 s. Records `last_ping`/`tools` on stored rows. */
  agentPing: (id: string) => post<PingResult>(`/api/agents/${id}/ping`),
  /** The same ping for a URL nobody has saved yet; stores nothing. 400 for a URL `POST /api/agents` would reject. */
  agentPingUrl: (url: string) => post<PingResult>("/api/agents/ping", { url }),
  /** 202: spawned, `running` flips when 8790 answers (first start syncs a venv, up to a minute). 503 without a key, 409 if 8790 is taken. */
  exampleStart: () => post<ExampleAgentState & { started_at: string }>("/api/agents/example/start"),
  /** 404 when nothing runs; an agent on 8790 we did not spawn is left alone (`owned: false`). */
  exampleStop: () => post<ExampleAgentState & { stopped: boolean; owned: boolean }>("/api/agents/example/stop"),
  exampleLog: (tail = 200) => get<{ lines: string[] }>(`/api/agents/example/log?tail=${tail}`),
};
