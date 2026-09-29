# Backend lane 6 — domain packs: report

Brief: `backend-6-domain-packs.md`. Everything below is in the working tree, uncommitted. Tests: **390 → 430**
(`env -u WANDB_API_KEY uv run pytest -q`, 64 s on macOS, no model calls). Nothing under `web/` was touched.

## What changed, in one paragraph

Northwind is no longer wired into the loop. A run happens inside a **domain pack** (`chaos/domains/<name>/`): the
tools, the seed records, the policy text, the legit tasks and the attack families all come from the pack, and every
tool session works on its own copy of the pack's database. Two packs ship: `retail` (Northwind, unchanged in
behaviour — the v0 prompt is byte-identical and the golden tape still parses and replays) and `airline` (Skyward
Air: seven tools, six customers, ten reservations, eight flights, eleven legit tasks, five attack families including
exfiltration). The judge grades in tool-class terms fed by the pack, and its LLM branch never sees raw tool output.
Runs record their pack and seed; cycles record latency, tokens and an estimated cost; accepted fixes report pass^k.

## Files shipped

New

- `chaos/domains/__init__.py` — the loader (`list_domains`, `active_domain`, `load_domain`, `forbidden_calls_for`,
  `expected_state_for`) and load-time checks.
- `chaos/domains/retail/{__init__.py, tools.py, db.json, policy.md, tasks.json, attacks.json}` — Northwind moved here.
- `chaos/domains/airline/{__init__.py, tools.py, db.json, policy.md, tasks.json, attacks.json}` — the new pack.
- `docs/SMOKE.md` — the ten-minute manual checklist (Step 0).
- `tests/test_e2e_passthrough.py` — in-process end to end: fake agent + fake tool backend → deterministic failure →
  `tool_rules` patch → saved config → approved via the API → gateway blocks the same call (Step 0).
- `tests/test_domains.py`, `tests/test_domains_loop.py` — the pack loader, per-session db, class-level judge, typed
  facts, chaos/repair prompts from the pack, `GET /api/domains`, agent-row domain, run.json, pass^k, the cost meter,
  seeding.

Changed (backend)

- `chaos/schemas.py` — `CallSpec`, `ToolSpec`, `AttackFamily`, `Domain`, `TokenCount`; `Scenario.expected_calls`
  / `forbidden_calls` / `expected_state`; `Episode.domain` / `end_state`; `GateResult.pass_k`;
  `CycleRecord.latency_ms` / `tokens` / `cost_usd`.
- `chaos/tools.py` — now only world-agnostic plumbing (`tool_rule_blocks`, normalisers, `serialize_result`).
- `chaos/toolbus.py` — `ToolSession.domain` / `db` / `session_id`; dispatch through the pack; `X-Antibody-Session`
  forwarded on pass-through (`:178`, `:191`).
- `chaos/target.py` — `post_json(..., headers=)` (`:124`).
- `chaos/target_agent.py`, `chaos/toolserver.py`, `chaos/zendesk.py`, `chaos/scenarios.py`, `chaos/chaos_agent.py`,
  `chaos/judge.py`, `chaos/repair_agent.py`, `chaos/tool_rules.py`, `chaos/loop.py`, `chaos/config.py` — read the
  pack instead of Northwind; details under Decisions.
- `api/main.py` (`GET /api/domains` `:338`; `AgentBody.domain`; `ImportBody.customer_id` optional), `api/loop_ctl.py`
  (`LoopStartBody.domain` `:110`, `ANTIBODY_DOMAIN` passed to the child `:283-284`, validated in `preflight` `:393`),
  `api/agents.py` (agent rows carry `domain`), `api/manifest.py` (`domain`, `TARGET_NAMES`, `domains()`),
  `api/store.py` (`run.json` domain/seed, `pass_k`, `cost_usd`, `latency_ms`), `api/attack.py`, `api/incidents.py`.
- `scripts/probe_target.py`, `scripts/probe_injection.py`, `scripts/measure_noise.py` — use the active pack.
- Tests updated for the move: `test_toolbus_replay.py`, `test_toolserver.py`, `test_attack.py`, `test_check.py`,
  `test_gate.py`, `test_target.py`, `test_incidents.py`, `test_manifest.py`, `test_runs_api.py`,
  `test_passthrough.py`, `test_tool_rules.py`, `test_agents.py`. `tests/test_scenarios.py`'s
  `LEGIT_EXPECTED_TOOLS` coverage check is now the loader's (`chaos/domains/__init__.py:101-118`, `:138-160`).

## Decisions where the handoff was wrong or silent

1. **Step 1, `_canned("tighten_tool_policy")` keyed on "HTTP target with `tools_backend`".** Implemented instead on
   *what the pack offers*: when `active_domain().policy_help` is empty (airline, or any pack without the seven flags)
   the canned patch is per-tool rules; retail keeps the flags (`chaos/repair_agent.py:534-556`). A pass-through
   session still gets rules for the agent's own tool names. Reason: the flags are a property of the retail sandbox,
   not of the transport.
2. **Rules by class use the pack's class first.** `_rules_for` (`chaos/repair_agent.py:520-531`) asks the pack for
   the class of a tool it owns (`issue_compensation` is money because the pack says so) and falls back to
   `tool_rules.classify` (name heuristics) for a customer's unknown tool. The handoff only mentioned `classify`;
   `classify("issue_compensation")` is `unknown`, which would have denied it outright.
3. **`policy_blocks` is a pack hook, not a `name == "retail"` branch.** The seven flags stay on `ToolPolicy` with
   "retail-only" docstrings (Q18) but the tool bus calls `session.domain.policy_blocks(...)`
   (`chaos/schemas.py:318`), which the retail loader attaches (`chaos/domains/__init__.py`, `_policy_hook`) and
   airline leaves as None. Same for validators. Fewer branches, and a third pack can bring its own.
4. **`tasks.json` rows carry `title` and `expected_behavior`, not `customer_email`.** The email is the customer
   record's (`Domain.customer_email`, `schemas.py:348`); duplicating it per task would let the two drift. Every
   `Scenario` field the judge and UI already used stays populated.
5. **`Scenario.forbidden_tool_calls` deleted, not translated.** Golden records that carried it now load with
   `forbidden_calls == []` (`tests/test_domains_loop.py::test_golden_records_parse_with_the_new_fields_defaulted`).
   The old field was never read by the judge (handoff fact confirmed), so replay behaviour is unchanged.
6. **`expected_state` only when every expected call is exact and non-read.** A read-only task leaves the seed db,
   so comparing states would double-count any stray action; an open amount (`ANY_ARG`) cannot be replayed. Retail's
   refund rows therefore have no `expected_state`, exactly like before (`chaos/domains/__init__.py:82-98`).
7. **Judge state check is a second gate, not a replacement.** Calls are checked first (they give a precise
   `failure_kind`); the end state is compared only when the calls pass and the row has an `expected_state`
   (`chaos/judge.py:254`). The handoff said "compares end state when present, else calls"; that would have turned
   every wrong-record failure into a bare "state differs".
8. **The judge payload drops attacker text everywhere, not only in `result`.** Faults are sent as `{tool, mode}`
   (no payload) and the planted note as a boolean (`chaos/judge.py:282-283`). A test asserts the injection string
   cannot appear anywhere in the payload.
9. **Cost comes from the response `usage`, not Weave call summaries.** `chaos/config.py:44-130`: a process-wide
   `Meter` wraps the OpenAI client; the loop snapshots it around each cycle (`chaos/loop.py:322`). Weave summaries
   are per call and asynchronous; reading them back inside the loop would have added a network round-trip per cycle.
   `PRICE_PER_MILLION_USD` is labelled an estimate; unpriced models count tokens but add no cost.
10. **`_is_read_tool` excludes ticket reads from verification.** A `read_ticket` echoes an `id` and would have
    marked the ticket number as a verified order (`chaos/toolbus.py`, `ToolSpec.ticket_only`). Caught by the
    golden replay test during the move.
11. **Run manifest `target` is left as the canonical target string** (`builtin` or the `ANTIBODY_TARGET` value),
    which `GET /api/runs` already exposed; the two-valued `"builtin" | "http"` in the contract was not adopted so
    the runs list keeps its existing shape. Frontend lane: flag if you want the enum as well.
12. **Handoff facts corrected while verifying:** `repair_agent.py` line numbers for the menu were already stale
    (the file had grown); `chaos/toolbus.py:156` no longer existed as described (pass-through had moved). The
    substance of every fact held: no header was sent, `tool_rules` was never mentioned to the model,
    `forbidden_tool_calls` was never read.

## What is not tested

- Anything that needs a key: the LLM judge branch, the chaos and repair models producing usable JSON against the
  airline prompt, real cost figures. The tests stop at "the prompt/payload the model would receive".
- The airline pack has never been run end to end with a model (`ANTIBODY_DOMAIN=airline uv run python -m chaos.loop
  run --cycles 2`). The tools, tasks and judge are exercised in-process only.
- The Zendesk ticket path with a non-retail pack: `has_ticket_tools` is False for airline so ticket mode is
  refused, but that is asserted, not run.
- `docs/SMOKE.md` itself is a manual checklist; nothing runs it.
- macOS only. Nothing here is platform-sensitive, but the Linux run has not happened.

## Shapes lane 7 will import (`chaos/schemas.py`)

```python
ANY_ARG = "..."                     # in CallSpec.args: key must be present, any value

class CallSpec(BaseModel):          # :122
    tool: str
    args: dict[str, Any] = {}       # declared subset only; amounts by value, ids stripped, case-folded
    def matches(self, tool, args) -> bool
    def exact(self) -> bool         # no ANY_ARG: replayable on a fresh db

class Scenario(BaseModel):          # :158
    id: str; kind: ScenarioKind; title: str; user_message: str
    customer_id: str = "cust_owen"
    faults: list[ToolFault] = []
    expected_behavior: str
    expected_calls: list[CallSpec] = []
    forbidden_calls: list[CallSpec] = []       # replaces forbidden_tool_calls
    expected_state: str | None = None          # Domain.end_state after replaying exact expected_calls
    attacker_goal: str = ""
    origin: Literal["seed", "chaos_agent", "legit", "imported"] = "chaos_agent"
    ticket_id: int | None = None; planted_note: str | None = None

class ToolSpec(BaseModel):          # :239
    name: str; description: str = ""; parameters: dict = {"type": "object", "properties": {}}
    cls: ToolClass = "unknown"      # read | money | message | mutate | unknown
    owner_key: str | None = None    # read: result field naming the owner
    intent_words: list[str] = []    # action: words the customer must have said
    contact_arg: str | None = None  # message: argument carrying the destination
    ticket_only: bool = False

class AttackFamily(BaseModel):      # :255
    name: ScenarioKind; expected_behavior: str
    faults: list[str] = []; forbidden_calls_by_class: list[ToolClass] = []
    default: dict = {}              # {title, user_message, faults, attacker_goal}

class Domain(BaseModel):            # :269  (data only; functions attached by the loader)
    name: str; tools: dict[str, ToolSpec]; db: dict; policy_text: str
    legit: list[Scenario] = []; families: list[AttackFamily] = []; seeds: list[Scenario] = []
    policy_help: str = ""; validators_help: str = ""
    def fresh_db(self) -> dict                    # per-session copy
    def call(self, db, name, args) -> Any
    def validators(self) -> dict[str, Callable]
    def policy_blocks(self, tool, args, policy, customer_id, db, **ctx) -> str | None
    def end_state(self, db) -> str                # canonical JSON
    def specs(self, ticket_mode=False) -> list[dict]   # OpenAI tool schemas
    has_ticket_tools: bool
    def tool_class(self, name) -> ToolClass
    def tools_of_class(self, cls) -> list[str]
    def family(self, kind) -> AttackFamily        # KeyError when the pack lacks it
    def customer_email(self, customer_id) -> str  # "unknown" when absent
    def owner_of(self, key, value) -> str | None
    def record_exists(self, key, value) -> bool | None

class Episode:   + domain: str | None; end_state: str | None
class GateResult: + fix_samples, fix_passes (defaults 0) ; pass_k -> {"k": int, "passed": int}   (computed, serialised)
class TokenCount(BaseModel): input: int = 0; output: int = 0
class CycleRecord: + latency_ms: int | None; tokens: TokenCount | None; cost_usd: float | None
```

Loader (`chaos/domains/__init__.py`): `DOMAIN_ENV = "ANTIBODY_DOMAIN"`, `DEFAULT_DOMAIN = "retail"`,
`list_domains() -> ["airline", "retail"]`, `active_domain()`, `load_domain(name)` (cached; `ValueError` for an
unknown name), `forbidden_calls_for(domain, kind)`, `expected_state_for(domain, calls)`.

API: `GET /api/domains → [{name, tools: [{name, class}], families: [name], legit: int}]`; agent rows and
`POST /api/loop/start` accept `domain`; run manifests carry `domain`, `seed`, `pass_k`, `cost_usd`, `latency_ms`.
