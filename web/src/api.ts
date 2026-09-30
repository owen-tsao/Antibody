// Types mirror docs/FRONTEND.md §2 / chaos/schemas.py exactly. Fetchers only; no caching.

export type ScenarioKind =
  | "prompt_injection_via_tool"
  | "tool_returns_garbage"
  | "social_engineering"
  | "ambiguous_request";

type FailureKind =
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

interface ToolFault {
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
  /** Calls a correct agent makes / never makes here (chaos/schemas.py `CallSpec`). Absent on records older than domain packs. */
  expected_calls?: { tool: string; args: Record<string, unknown> }[];
  forbidden_calls?: { tool: string; args: Record<string, unknown> }[];
  attacker_goal: string;
  origin: "seed" | "chaos_agent" | "legit" | "imported";
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
interface Episode {
  scenario_id: string;
  config_version: number;
  tool_calls: ToolCall[];
  final_reply: string;
  error: string | null;
  /** Zendesk state around the episode; null on the mock path. Absent on older records. */
  ticket_state?: Record<string, unknown> | null;
}

interface Verdict {
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
  /** Per-tool rules by tool name (plan 09 §4); the only part of the policy that applies to tools Antibody did not write. */
  tool_rules?: Record<string, ToolRule>;
}

/** One tool's world-agnostic rule (chaos/schemas.py `ToolRule`). Every field optional on the wire: the server defaults them. */
export interface ToolRule {
  deny?: boolean;
  requires_user_intent?: boolean;
  intent_words?: string[];
  requires_verified_lookup?: boolean;
  max_calls?: number | null;
}

export type ToolClass = "read" | "money" | "message" | "mutate" | "unknown";

/** GET /api/agents/:id/tools — the Tools panel. `tools` null until a ping has listed them. */
export interface ToolsProposal {
  tools: AgentTool[] | null;
  mapping: ToolMapping | null;
  classes: Record<string, ToolClass>;
  starter_rules: Record<string, ToolRule>;
}

/** One line of history/gateway.jsonl (chaos/gateway.py `log_line`). */
export interface GatewayEvent {
  at: string;
  session: string;
  customer: string;
  /** Which real tools the call went to; null on rows written before the gateway recorded it. */
  backend?: string | null;
  config_version: number;
  tool: string;
  args: Record<string, unknown>;
  decision: "allowed" | "would_block" | "blocked";
  reason: string | null;
  mode: "shadow" | "enforce";
}

export interface GatewayLog {
  events: GatewayEvent[];
  command: string;
}

/**
 * GET /api/gateway/replay?version=N — version N's `tool_rules` re-run over the real calls recorded in
 * history/gateway.jsonl (plan 10 §2 "approval as a real decision"). `calls === 0` means no traffic recorded.
 */
export interface GatewayReplay {
  version: number;
  calls: number;
  would_block: number;
  by_tool: Record<string, { calls: number; would_block: number }>;
  /** Up to 20 of the calls this version would block. */
  samples: { tool: string; args: Record<string, unknown>; reason: string; at: string }[];
}

// --- Schedules (docs/plans/09-roadmap-v1.md §6) ---------------------------------------------------------------------

export type ScheduleTrigger = { kind: "interval"; every_minutes: number } | { kind: "on_change" };

/** `LoopStartBody` without `target` (the schedule's agent), `resume` (decided when it fires) and `domain` (the agent's own); the API stores every field. */
export type ScheduleSettings = Required<Omit<LoopStartBody, "target" | "resume" | "domain">>;

interface ScheduleResult {
  kind: "started" | "skipped" | "failed";
  detail: string;
  at: string;
}

/** One row of GET /api/schedules (api/schedules.py). `agent_name` null when the agent has been deleted. */
export interface Schedule {
  id: string;
  name: string;
  agent: string;
  agent_name: string | null;
  trigger: ScheduleTrigger;
  settings: ScheduleSettings;
  enabled: boolean;
  created_at: string;
  last_run_at: string | null;
  last_result: ScheduleResult | null;
  next_at: string | null;
}

export interface ScheduleBody {
  name: string;
  agent: string;
  trigger: ScheduleTrigger;
  settings: ScheduleSettings;
  enabled: boolean;
}

export interface Patch {
  kind: PatchKind;
  rationale: string;
  guardrail_rule: string | null;
  system_prompt: string | null;
  validator_name: string | null;
  tool_policy: ToolPolicy | null;
}

/** How many of the pack's legit tasks the legit guard could run against this target (chaos/domains `covered_legit`). */
export interface LegitCovered {
  covered: number;
  total: number;
}

export interface GateResult {
  accepted: boolean;
  fixes_new_failure: boolean;
  regression_pass_rate: number;
  /** null when the legit guard did not run (no task covered); the backend is making this nullable. */
  legit_pass_rate: number | null;
  failed_scenario_ids: string[];
  reason: string;
  /** Weave evaluation URLs (gate-new, gate-regression, gate-legit). Absent on golden records. */
  weave_eval_urls?: string[];
  /** How many times the new failure was re-run against the candidate (GATE_FIX_SAMPLES); 1 on records gated before sampling. */
  fix_samples: number;
  /** How many of those samples the candidate fixed; `fixes_new_failure` is `fix_passes === fix_samples`. */
  fix_passes: number;
  /** pass^k (plan 10 §2): the fix held on `passed` of `k` independent trials. Absent on records gated before it existed. */
  pass_k?: { k: number; passed: number } | null;
  /** Legit tasks the target could perform, of the pack's total. Absent/null on records gated before coverage was measured. */
  legit_covered?: LegitCovered | null;
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
  /** Cost and latency per cycle (plan 10 C2). Absent on records written before the loop measured them. */
  latency_ms?: number | null;
  tokens?: { input: number; output: number } | null;
  cost_usd?: number | null;
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

type Source = "live" | "golden" | "replay";

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
  /** A pack name from GET /api/domains; null = the agent's own `domain`, else the API's default (400 for an unknown name). */
  domain?: string | null;
  /** Measure attacks that land on v0 and the final version when the run ends (writes `vulnerability.json`). Default true. */
  vulnerability?: boolean;
  /** `vulnerability` re-measures the live run's attacks against every saved version instead of running cycles (plan 11 §7). Absent = `run`. */
  mode?: "run" | "vulnerability";
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

interface LoopStarted {
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
  /** The domain pack this API process runs by default (`ANTIBODY_DOMAIN`); a start or an agent row can pick another. */
  domain?: string;
  /** The model behind each role as this API process resolved them (`ANTIBODY_*_MODEL`), for the Settings page. */
  models: { target: string; chaos: string; repair: string; judge: string; inference_url: string };
  tools: { name: string; description: string; side_effect: boolean; free_text_fields: string[] }[];
  families: { kind: ScenarioKind; title: string; seed_id: string | null }[];
  /** The run-settings defaults Settings › Run defaults begins from. */
  defaults: Required<LoopStartBody>;
}

/** One row of GET /api/runs (docs/plans/handoffs/ui-3-run-history.md). */
export interface RunRow {
  /** "live" | "golden" | a history folder name. */
  id: string;
  /** Only the golden run carries one ("reference run"). */
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
  /** The domain pack the run attacked in (plan 10 A1, e.g. `retail`, `airline`). Absent on runs made before packs. */
  domain?: string | null;
  /** The seed the loop's randomness was pinned to (plan 10 C2); null when the run was not seeded. Absent on older runs. */
  seed?: number | null;
  /** From the run's latest gate that measured it; null when no gate did (older runs). */
  legit_covered?: LegitCovered | null;
  /** The Weave leaderboard over this run's versions (plan 11 §7); null or absent until the loop publishes one. */
  weave_leaderboard_url?: string | null;
  /** Where `cost_usd` on the cycles came from: Weave's own accounting, or the local price table. Absent on older runs. */
  cost_source?: "weave" | "estimated";
  /** The live row only: a `vulnerability` measurement is running against this run's versions. */
  measuring?: boolean;
}

/** One row of GET /api/domains (api/manifest.py `domains`): a pack the loop can run in. */
export interface Domain {
  name: string;
  tools: { name: string; class: ToolClass }[];
  families: string[];
  /** How many legit tasks the pack's guard has. */
  legit: number;
}

interface RollbackBody {
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
  /** Where the agent's real tools live (`POST <tools_backend>/tools/{name}`); null = the sandbox. Absent on rows stored before plan 09. */
  tools_backend?: string | null;
  /** The domain pack whose world this agent speaks (GET /api/domains); null = the API's default. Absent on rows stored before packs. */
  domain?: string | null;
  synthetic: boolean;
  /** The `example` row only: a live probe of port 8790. `starting` = spawned, port not answering yet. */
  running?: boolean;
  starting?: boolean;
  pid?: number | null;
}

/** Which of the agent's tool names the sandbox serves; null when the agent listed none. */
export interface ToolMapping {
  known: string[];
  unknown: string[];
}

/** POST /api/agents/:id/ping — always 200 for a known agent; an unreachable agent is `ok: false`, not an error. */
export type PingResult =
  | { ok: true; latency_ms: number; reply_preview: string | null; tools: AgentTool[] | null; mapping: ToolMapping | null }
  | { ok: false; latency_ms: number; error: string; tools: AgentTool[] | null; mapping: ToolMapping | null };

/** The bundled examples `POST /api/agents/example/start` knows (api/example_agent.py `EXAMPLES`). */
export type ExampleName = "support" | "airline";

interface ExampleAgentState {
  running: boolean;
  url: string;
  pid: number | null;
  starting: boolean;
}

/** GET /api/health (plan 03 Step 1). Never carries the key itself, only whether one is set. */
export interface Health {
  ok: boolean;
  has_api_key: boolean;
  /** Every other /api route wants `Authorization: Bearer` (api/auth.py); the token itself is never reported. */
  auth_required?: boolean;
  version?: string;
  live_exists?: boolean;
  golden_exists?: boolean;
  weave?: unknown;
}

// Approval (api/main.py `/api/approvals`, chaos/state.py): a person's decision on one saved version.
type ReviewStatus = "pending" | "approved" | "rejected";

export interface Approval {
  version: number;
  status: ReviewStatus;
  at: string | null;
  note: string;
}

export interface Approvals {
  /** The certified config: the highest approved version, 0 when nothing has been approved. */
  certified: number;
  decisions: Approval[];
}

// --- Review inbox (docs/plans/11-results-review-weave.md §7) -----------------------------------------------------

/** One version awaiting (or past) a decision, as `GET /api/review/inbox` lists it under its agent. */
export interface InboxItem {
  /** A runs-list id: `live`, `golden` or a history folder. */
  run: string;
  run_started: string | null;
  /** The current run's versions are the only ones a decision can be recorded on (api/main.py review is live-only). */
  live: boolean;
  version: number;
  /** The cycle whose accepted patch made the version; null for a rollback copy or starter rules. */
  cycle: number | null;
  /** The attack that cycle ran, or the version's patch note. */
  title: string;
  gate: { fix_passes: number; fix_samples: number; legit_pass_rate: number | null; legit_covered: LegitCovered | null } | null;
  /** Set on `decided` items only, with `status`. */
  decided_at: string | null;
  status?: Exclude<ReviewStatus, "pending">;
  note?: string;
}

/**
 * One row of `GET /api/review/inbox`: an agent (null when its row was deleted but its runs remain), what can be
 * decided (`pending`: the current run's undecided versions), what is undecided on archived runs (`archived`: can be
 * looked at, not decided), and what has been decided.
 */
export interface InboxAgent {
  agent: Pick<Agent, "id" | "name"> | null;
  pending: InboxItem[];
  archived: InboxItem[];
  decided: InboxItem[];
}

export interface State {
  latest_version: number | null;
  suite_size: number;
  legit_pass_rate: number | null;
  /** The latest gate's coverage; absent/null before any gate ran or on runs recorded before it was measured. */
  legit_covered?: LegitCovered | null;
  last_gate: "accepted" | "rejected" | null;
  loop: LoopState;
  source: Source;
  /** Replay only: ISO time the recorded run started. */
  recorded_at?: string | null;
  /** How many of the final suite's attacks land on each config (`{ v0: 6, v3: 3 }`); null until measured. */
  vulnerability?: Vulnerability | null;
}

/**
 * `runs/vulnerability.json` as the API serves it (api/store.py `read_vulnerability`): per-version counts always;
 * `by_attack` (plan 11 §7) — `{"v0": {scenario_id: [landed per sample]}}`, read from the detail file — only on runs
 * measured since it was recorded. `samples` is how many episodes each list holds.
 */
export interface Vulnerability {
  landed: Record<string, number>;
  suite_size: number;
  world?: "mock" | "zendesk" | null;
  samples?: number;
  by_attack?: Record<string, Record<string, boolean[]>>;
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

// The API token (api/auth.py). Kept here because this is the one place that sends it; the Access section in
// Settings and the Shell's token panel both go through these two.
const TOKEN_KEY = "antibody.token.v1";

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // private mode: the token lives for this page only
  }
}

function headers(extra?: Record<string, string>): Record<string, string> | undefined {
  const token = getToken();
  const h = { ...(extra ?? {}), ...(token ? { authorization: `Bearer ${token}` } : {}) };
  return Object.keys(h).length ? h : undefined;
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path, { headers: headers() });
  if (!res.ok) throw new ApiError(res.status, await detailOf(res));
  return res.json() as Promise<T>;
}

async function post<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    headers: headers(body === undefined ? undefined : { "content-type": "application/json" }),
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  if (!res.ok) throw new ApiError(res.status, await detailOf(res));
  return res.json() as Promise<T>;
}

async function patch<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, { method: "PATCH", headers: headers({ "content-type": "application/json" }), body: JSON.stringify(body) });
  if (!res.ok) throw new ApiError(res.status, await detailOf(res));
  return res.json() as Promise<T>;
}

async function del(path: string): Promise<void> {
  const res = await fetch(path, { method: "DELETE", headers: headers() });
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
    get<(Pick<AgentConfig, "version" | "parent_version" | "patch_note"> & { review: ReviewStatus })[]>(withSource("/api/configs", source)),
  /** Which versions of a run a person approved or rejected (absent = pending) and the certified (highest approved) one. */
  approvals: (source?: ReadSource) => get<Approvals>(withSource("/api/approvals", source)),
  /** Approve or reject one live version. */
  review: (version: number, status: Exclude<ReviewStatus, "pending">, note = "") =>
    post<Approval & { certified: number }>(`/api/configs/${version}/review`, { status, note }),
  /** Every agent with its pending and decided versions, computed server-side in one pass (plan 11 §7); the Review index's one poll. */
  reviewInbox: () => get<InboxAgent[]>("/api/review/inbox"),
  manifest: () => get<Manifest>("/api/manifest"),
  /** Every domain pack the loop can run in; the Settings domain picker and the wizard's Connect step read it. */
  domains: () => get<Domain[]>("/api/domains"),
  health: () => get<Health>("/api/health"),
  /** Every run there is to open, newest first; the live run first (once it has a cycle), golden last. */
  runs: () => get<RunRow[]>("/api/runs"),
  /** One run plus its config versions. 404 for `live` until the run's first cycle lands. */
  run: (id: string) => get<RunRow>(`/api/runs/${id}`),
  /** Copy a past run's config in as the next live version (409 while a loop runs or on target mismatch). */
  rollback: (body: RollbackBody) => post<RollbackResult>("/api/rollback", body),
  /** The regression suite a run was gated against (live: the suite the next run will be). */
  regression: (source?: ReadSource) => get<Scenario[]>(withSource("/api/regression", source)),
  /** A pasted transcript → a live regression scenario (api/incidents.py). `created` is false when the same customer text was imported before. */
  importScenario: (body: { transcript: string; kind: ScenarioKind; title?: string; customer_id?: string }) =>
    post<{ scenario: Scenario; created: boolean }>("/api/scenarios/import", body),
  /** The enforcement gateway's shadow log (history/gateway.jsonl), oldest first, and the command that starts it. `backend` keeps only the rows written in front of that tools backend — the log is per install, the Agent page shows one agent's. */
  gateway: (tail = 200, backend?: string | null) => get<GatewayLog>(`/api/gateway?tail=${tail}${backend ? `&backend=${encodeURIComponent(backend)}` : ""}`),
  /** What one live version's rules would have said about the recorded real traffic; the Review page's shadow-replay drawer. `backend` keeps only the rows written in front of that tools backend (the log is per install). */
  gatewayReplay: (version: number | "approved", source: ReadSource = "live", backend?: string | null) =>
    get<GatewayReplay>(`/api/gateway/replay?version=${version}&source=${source}${backend ? `&backend=${encodeURIComponent(backend)}` : ""}`),
  schedules: () => get<Schedule[]>("/api/schedules"),
  scheduleCreate: (body: ScheduleBody) => post<Schedule>("/api/schedules", body),
  scheduleUpdate: (id: string, body: Partial<ScheduleBody>) => patch<Schedule>(`/api/schedules/${encodeURIComponent(id)}`, body),
  scheduleDelete: (id: string) => del(`/api/schedules/${encodeURIComponent(id)}`),
  /** Fire now; the outcome is the returned row's `last_result`. */
  scheduleRun: (id: string) => post<Schedule>(`/api/schedules/${encodeURIComponent(id)}/run`),
  loop: () => get<LoopState>("/api/loop"),
  loopStart: (body: LoopStartBody) => post<LoopStarted>("/api/loop/start", body),
  loopStop: () => post<LoopState>("/api/loop/stop"),
  /** Clear the current run: its files move to history/; `archived` is the new run id, or null if runs/ was empty. */
  runsArchive: () => post<{ archived: string | null }>("/api/runs/archive"),
  /** Where "open log" points: the last `tail` lines of runs/loop.log, as JSON. */
  loopLog: (tail = 500) => get<{ lines: string[] }>(`/api/loop/log?tail=${tail}`),
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
  /** `builtin`, `example`, then the connected agents. Each call probes port 8790 (1 s timeout), so poll at ≥ 3 s. */
  agents: () => get<Agent[]>("/api/agents"),
  /** 201 with the new row; 400 for a bad name, URL or domain, 409 when that URL is already connected. */
  agentCreate: (body: { name: string; url: string; tools_backend?: string | null; domain?: string | null }) => post<Agent>("/api/agents", body),
  /** Point a connected agent at its real tools, or back at the sandbox with null. 409 while a loop runs. */
  agentPatch: (id: string, body: { tools_backend: string | null }) => patch<Agent>(`/api/agents/${id}`, body),
  /** The Tools panel: listed tools, sandbox mapping, a class and a starter rule per tool. */
  agentTools: (id: string) => get<ToolsProposal>(`/api/agents/${id}/tools`),
  /** Save rules as the next live config version; 409 while a loop runs or when the live run is another agent's. */
  agentToolsApply: (id: string, rules: Record<string, ToolRule>) => post<AgentConfig>(`/api/agents/${id}/tools/apply`, { rules }),
  /** 204; 404 for a synthetic or unknown id, 409 while any loop runs. */
  agentDelete: (id: string) => del(`/api/agents/${id}`),
  /** A hello `POST /episode` plus `GET /tools`; up to ~12 s. Records `last_ping`/`tools` on stored rows. */
  agentPing: (id: string) => post<PingResult>(`/api/agents/${id}/ping`),
  /** The same ping for a URL nobody has saved yet; stores nothing. 400 for a URL `POST /api/agents` would reject. */
  agentPingUrl: (url: string) => post<PingResult>("/api/agents/ping", { url }),
  /** 202: spawned, `running` flips when its port answers (first start syncs a venv, up to a minute). 503 without a key,
   *  409 if the port is taken. `name` picks the bundled example (`support` on 8790, `airline` on 8792/8793). */
  exampleStart: (name: ExampleName = "support") => post<ExampleAgentState & { started_at: string }>("/api/agents/example/start", { name }),
  /** 404 when nothing runs; an agent on the port we did not spawn is left alone (`owned: false`). */
  exampleStop: (name: ExampleName = "support") => post<ExampleAgentState & { stopped: boolean; owned: boolean }>("/api/agents/example/stop", { name }),
  exampleLog: (tail = 200) => get<{ lines: string[] }>(`/api/agents/example/log?tail=${tail}`),
};
