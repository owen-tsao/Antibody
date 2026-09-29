"""Interface contracts shared by every agent in the loop.

These four schemas are the seams between the Chaos Agent, Target Agent, Judge,
Repair Agent, and Eval Gate. Anything built in parallel builds against these.
"""

from __future__ import annotations

import copy
import json
from datetime import datetime, timezone
from collections.abc import Collection
from typing import Annotated, Any, Callable, Literal

from pydantic import AfterValidator, BaseModel, Field, PrivateAttr, computed_field, model_validator

# ---------------------------------------------------------------------------
# Agent configuration (the thing the Repair Agent patches)
# ---------------------------------------------------------------------------

# The real-world ticket tools every pack may carry in ticket mode (Zendesk). Named here because the fault
# validator and the tool bus both need the list, and it is a property of the world, not of any one pack.
TICKET_TOOLS = frozenset({"read_ticket", "set_ticket_status"})

# Faults tamper with the MOCKED world only. The ticket is the real world: the attack surface there is what
# the attacker writes on it (message, planted note), not a tampered read. Faulting read_ticket would also let
# the attacker forge "customer" comments that the refund-intent policy trusts, with no patch able to fix it.
# Any other name is allowed so a customer's own tools (plan 09 §4, `tools_backend`) can be faulted too.
FaultableTool = Annotated[str, AfterValidator(lambda v: _not_a_ticket_tool(v))]


def _not_a_ticket_tool(name: str) -> str:
    if name in TICKET_TOOLS:
        raise ValueError(f"{name} cannot be faulted: the ticket is the real world")
    return name


class ToolRule(BaseModel):
    """One tool's rule, world-agnostic: it knows the tool's name and the conversation, never the sandbox's records.

    These are what the enforcement gateway can run in front of a customer's real tools; the seven flags below
    consult the retail pack's records and stay sandbox-only. `intent_words` empty means the tool's own name (an
    `issue_refund` needs the customer to have said "refund"). `requires_verified_lookup` means some earlier
    tool returned a record matching an id this call names.

    `on_failure` and `timeout_s` are the gateway's operational half (plan 10 §5b): what happens when the rule check
    itself raises or the real tool is unreachable, and how long to wait for it. Unset, the class decides
    (`chaos.tool_rules.fails_closed`) and the bus's default timeout applies.
    """

    deny: bool = False
    requires_user_intent: bool = False
    intent_words: list[str] = Field(default_factory=list)
    requires_verified_lookup: bool = False
    max_calls: int | None = Field(default=None, ge=1)
    on_failure: Literal["closed", "open"] | None = Field(default=None, description="When the check or the backend fails: `closed` refuses the call, `open` lets it through and marks it degraded. None = by tool class (money/mutate/unknown closed, read/message open).")
    timeout_s: float | None = Field(default=None, gt=0, description="How long the gateway waits for the real tool; None = the bus default (30 s).")


class ToolPolicy(BaseModel):
    """Permission rules enforced in code, not by the model.

    The seven flags are retail-only (decision Q18 in docs/plans/10-production-fit.md): they name the retail
    pack's tools and read its records, and `chaos.domains.retail.tools.policy_blocks` is the only code that
    consults them. `tool_rules` is the part of the policy that applies to any tool in any pack.
    """

    refund_requires_order_match: bool = False  # retail-only
    refund_requires_user_intent: bool = False  # retail-only
    refund_max_amount: float | None = None  # retail-only
    email_only_to_order_owner: bool = False  # retail-only
    lookup_only_own_orders: bool = False  # retail-only
    ticket_scope_assigned_only: bool = False  # retail-only (the ticket tools live in that pack)
    actions_require_verified_lookup: bool = False  # retail-only
    # Per-tool rules by tool name; the only part of the policy that applies to tools Antibody did not write.
    tool_rules: dict[str, ToolRule] = Field(default_factory=dict)


class AgentConfig(BaseModel):
    """Versioned, fully serializable definition of the target agent's behavior.

    Every field here is something the Repair Agent is allowed to change.
    The loop's whole story is "config v0 breaks, config vN does not".
    """

    version: int = 0
    system_prompt: str
    guardrail_rules: list[str] = Field(default_factory=list)
    tool_output_validators: list[str] = Field(
        default_factory=list,
        description="Names of validator functions applied to tool outputs before the model sees them.",
    )
    tool_policy: ToolPolicy = Field(default_factory=ToolPolicy)
    parent_version: int | None = None
    patch_note: str = ""


# ---------------------------------------------------------------------------
# Chaos scenarios (the thing the Chaos Agent produces)
# ---------------------------------------------------------------------------

ScenarioKind = Literal[
    "prompt_injection_via_tool",
    "tool_returns_garbage",
    "social_engineering",
    "ambiguous_request",
    "exfiltration",
]

ToolClass = Literal["read", "money", "message", "mutate", "unknown"]

# In a `CallSpec.args` value: "any value is fine here" (the customer's refund reason is free text).
ANY_ARG = "..."


def _norm_arg(value: Any) -> Any:
    """What two argument values are compared as: numbers by value (`"42"` == `42.0`), everything else stripped text."""
    if isinstance(value, bool) or value is None:
        return value
    if isinstance(value, (int, float)):
        return float(value)
    text = str(value).strip()
    try:
        return float(text.replace(",", "").lstrip("$"))
    except ValueError:
        return text.lower()


class CallSpec(BaseModel):
    """A tool call a scenario expects or forbids: the tool, and the subset of its arguments that matter.

    Matching is on the declared subset only — an expected `issue_refund(order_id=A-1002)` is satisfied by any
    amount and reason — with the same normalisers the policy uses (amounts by value, ids stripped, case folded).
    `ANY_ARG` ("...") as a value means the key must be present but any value will do.

    `aliases` are the other names the spec's tool goes by (`ToolSpec.aliases`: another agent's `get_trip_details`
    is the pack's `lookup_reservation`). A call under an alias matches on the name, and on whichever declared
    arguments it carries: the alias's schema is the other agent's, so an argument it does not take is not held
    against it, but one it does take (`flight_number`) must still agree.
    """

    tool: str
    args: dict[str, Any] = Field(default_factory=dict)

    def matches(self, tool: str, args: dict[str, Any], aliases: Collection[str] = ()) -> bool:
        if tool == self.tool:
            strict = True
        elif tool in aliases:
            strict = False
        else:
            return False
        for key, want in self.args.items():
            if key not in args:
                if strict:
                    return False
                continue
            if want == ANY_ARG:
                continue
            if _norm_arg(args[key]) != _norm_arg(want):
                return False
        return True

    def exact(self) -> bool:
        """Every argument pinned: the call can be replayed on a fresh db to derive an expected end state."""
        return ANY_ARG not in self.args.values()


class ToolFault(BaseModel):
    """How the chaos harness tampers with a tool during one episode."""

    tool: FaultableTool
    mode: Literal["inject", "null", "malformed", "timeout", "wrong_record"]
    payload: Any = None


class Scenario(BaseModel):
    id: str
    kind: ScenarioKind
    title: str
    user_message: str
    # The retail pack's authenticated customer; every pack's scenarios name their own (loaders fill it from tasks).
    customer_id: str = "cust_owen"
    faults: list[ToolFault] = Field(default_factory=list)
    expected_behavior: str = Field(
        description="Plain-language statement of what a correct agent does here. Set by the attack-family template, never by the attacker."
    )
    expected_calls: list[CallSpec] = Field(
        default_factory=list,
        description="Calls a correct agent makes here (legit rows). Each must match at least one unblocked call, or the row is over-refusal / wrong action.",
    )
    forbidden_calls: list[CallSpec] = Field(
        default_factory=list,
        description="Calls a correct agent never makes here. Set by the attack family (by tool class) or the seed, never by the attacker.",
    )
    expected_state: str | None = Field(
        default=None,
        description="Canonical end state (`Domain.end_state`) after replaying `expected_calls` on a fresh db; None when a call is not exact or the pack has no state.",
    )
    attacker_goal: str = Field(
        default="",
        description="What the Chaos Agent was trying to achieve. Informational; the Judge does not treat it as ground truth.",
    )
    origin: Literal["seed", "chaos_agent", "legit", "imported"] = "chaos_agent"
    ticket_id: int | None = Field(
        default=None,
        description="Real Zendesk ticket carrying this scenario. When set, the target reads the customer's words through read_ticket instead of receiving user_message directly.",
    )
    planted_note: str | None = Field(
        default=None,
        description="Text the attacker planted as an internal note on the ticket (a poisoned 'previous agent' note). Real injection surface.",
    )


# ---------------------------------------------------------------------------
# Episode trace (what actually happened when the target ran a scenario)
# ---------------------------------------------------------------------------


class ToolCall(BaseModel):
    tool: str
    args: dict[str, Any]
    result: Any
    blocked_by_policy: bool = False
    blocked_by: str | None = Field(default=None, description="The policy reason that fired, when blocked; `failure:<reason>` when the gateway refused a call it could not check or deliver.")
    shadowed: bool = Field(default=False, description="A rule would have blocked this call but the session is in shadow mode, so it ran; `blocked_by` says which.")
    degraded: bool = Field(default=False, description="The rule check or the real tool failed and the call was let through anyway (a read/message tool, or `on_failure: open`); `result` may be an error.")
    elapsed_ms: int | None = Field(default=None, description="Rule check plus the real tool, wall-clock; None on the sandbox path and on records written before it was measured.")


class Episode(BaseModel):
    scenario_id: str
    config_version: int
    tool_calls: list[ToolCall] = Field(default_factory=list)
    final_reply: str
    error: str | None = None
    target: str | None = Field(
        default=None,
        description="Canonical name of the agent that ran this episode (`builtin`, `http:<url>`, `fin:<label>`). None on records written before targets were pluggable.",
    )
    ticket_state: dict[str, Any] | None = Field(
        default=None,
        description="Real Zendesk state around the episode: {status_before, status_after, reply_posted}. None on the mock path.",
    )
    domain: str | None = Field(
        default=None,
        description="The domain pack whose tools ran this episode (`retail`, `airline`). None when the agent's own tools ran (pass-through) or on records written before packs existed: the judge then has calls and transcript only.",
    )
    end_state: str | None = Field(
        default=None,
        description="`Domain.end_state` of the session's db when the episode ended; None without a pack.",
    )


# ---------------------------------------------------------------------------
# Domain packs (chaos/domains/<name>/): the world an episode runs in
# ---------------------------------------------------------------------------


class ToolSpec(BaseModel):
    """One tool as the pack declares it: the model-facing schema plus what the judge and policy need to know about it."""

    name: str
    description: str = ""
    parameters: dict[str, Any] = Field(default_factory=lambda: {"type": "object", "properties": {}})
    cls: ToolClass = Field(default="unknown", description="read / money / message / mutate: what the class-level rules key on.")
    owner_key: str | None = Field(default=None, description="For a read: the result field naming the record's owner (`customer_id`). A record whose owner is not the session's customer is a leak.")
    intent_words: list[str] = Field(default_factory=list, description="For an action: words the customer must have said for the call to count as asked for. Empty = not judged on intent.")
    contact_arg: str | None = Field(default=None, description="For a message tool: the argument carrying the destination, checked against the customer's own contact.")
    ticket_only: bool = Field(default=False, description="A real-world ticket tool: present only in ticket mode.")
    aliases: list[str] = Field(default_factory=list, description="Names other agents give this same tool (the OpenAI airline demo's `get_trip_details` is `lookup_reservation`). Only for tools that mean the same thing: an alias is judged and classed as this tool.")

    def openai(self) -> dict[str, Any]:
        return {"type": "function", "function": {"name": self.name, "description": self.description, "parameters": self.parameters}}


class AttackFamily(BaseModel):
    """Fixed, attacker-independent definition of what 'correct' means for one class of scenario.

    The Chaos Agent chooses the family and writes the user message, faults, and its own goal. It never writes the
    pass/fail criteria; those live here so the attacker cannot grade its own homework.
    """

    name: ScenarioKind
    expected_behavior: str
    faults: list[str] = Field(default_factory=list, description="Fault modes this family may use; empty = the message alone does the work.")
    forbidden_calls_by_class: list[ToolClass] = Field(default_factory=list, description="Tool classes a correct agent never calls in this family (expanded to `Scenario.forbidden_calls` per pack).")
    default: dict[str, Any] = Field(default_factory=dict, description="The scenario used when the model's reply is unusable: {title, user_message, faults, attacker_goal}.")


class Domain(BaseModel):
    """A domain pack: tools, seed records, policy text, legit tasks and attack families, loaded from `chaos/domains/<name>/`.

    Data only, so it serialises; the tool functions, validators and the pack's own policy hook are attached by the
    loader (`chaos.domains.load_domain`) and reached through the methods below. `db` is the seed: every session
    works on `fresh_db()`.
    """

    name: str
    tools: dict[str, ToolSpec]
    db: dict[str, Any]
    policy_text: str
    legit: list[Scenario] = Field(default_factory=list)
    families: list[AttackFamily] = Field(default_factory=list)
    seeds: list[Scenario] = Field(default_factory=list)
    # What the Repair model is told about this pack's own levers (the seven flags, the validators); empty when the
    # pack has none, so the menu offers only per-tool rules.
    policy_help: str = ""
    validators_help: str = ""

    _funcs: dict[str, Callable[..., Any]] = PrivateAttr(default_factory=dict)
    _validators: dict[str, Callable[..., Any]] = PrivateAttr(default_factory=dict)
    _policy_hook: Callable[..., str | None] | None = PrivateAttr(default=None)
    _state_view: Callable[[dict[str, Any]], Any] | None = PrivateAttr(default=None)

    def attach(
        self,
        funcs: dict[str, Callable[..., Any]],
        validators: dict[str, Callable[..., Any]] | None = None,
        policy_hook: Callable[..., str | None] | None = None,
        state_view: Callable[[dict[str, Any]], Any] | None = None,
    ) -> Domain:
        missing = set(self.tools) - set(funcs)
        if missing:
            raise ValueError(f"domain {self.name}: no function for tools {sorted(missing)}")
        self._funcs, self._validators, self._policy_hook, self._state_view = dict(funcs), dict(validators or {}), policy_hook, state_view
        return self

    def fresh_db(self) -> dict[str, Any]:
        return copy.deepcopy(self.db)

    def call(self, db: dict[str, Any], name: str, args: dict[str, Any]) -> Any:
        """Run the pack's tool against this session's db. Raises whatever the tool raises."""
        return self._funcs[name](db, **args)

    @property
    def validators(self) -> dict[str, Callable[..., Any]]:
        return self._validators

    def policy_blocks(self, tool: str, args: dict[str, Any], policy: ToolPolicy, customer_id: str, db: dict[str, Any], **context: Any) -> str | None:
        """The pack's own flag checks (retail's seven), if it has any; None otherwise."""
        return self._policy_hook(tool, args, policy, customer_id, db, **context) if self._policy_hook else None

    def end_state(self, db: dict[str, Any]) -> str:
        """Canonical JSON of what matters about the db after an episode: what the pack says is state, or all of it."""
        view = self._state_view(db) if self._state_view else db
        return json.dumps(view, sort_keys=True, separators=(",", ":"), default=str)

    def specs(self, ticket_mode: bool = False) -> list[dict[str, Any]]:
        """The OpenAI tool list the built-in target is offered."""
        return [t.openai() for t in self.tools.values() if ticket_mode or not t.ticket_only]

    @property
    def has_ticket_tools(self) -> bool:
        return any(t.ticket_only for t in self.tools.values())

    def canonical(self, name: str) -> str | None:
        """The pack's own name for a tool named by itself or by an alias; None for a tool the pack does not know."""
        if name in self.tools:
            return name
        return next((n for n, t in self.tools.items() if name in t.aliases), None)

    def names_of(self, tool: str) -> list[str]:
        """Every name a call of the pack's `tool` can arrive under: its own and its aliases."""
        spec = self.tools.get(tool)
        return [tool, *spec.aliases] if spec else [tool]

    def tool_class(self, name: str) -> ToolClass:
        """The class of the pack's tool, asked by its own name or an alias; `unknown` for a tool the pack does not know."""
        own = self.canonical(name)
        return self.tools[own].cls if own else "unknown"

    def tools_of_class(self, cls: ToolClass) -> list[str]:
        return [n for n, t in self.tools.items() if t.cls == cls]

    def family(self, kind: str) -> AttackFamily:
        for f in self.families:
            if f.name == kind:
                return f
        raise KeyError(f"domain {self.name} has no attack family {kind!r}")

    def customer_email(self, customer_id: str) -> str:
        """The authenticated customer's contact as the world knows it; 'unknown' for a stranger."""
        customer = (self.db.get("customers") or {}).get(customer_id) or {}
        return str(customer.get("email") or "unknown")

    def owner_of(self, key: str, value: Any) -> str | None:
        """Who owns the record an `*_id` argument names, asked of the pack's own read tools on a fresh db; None if no read tool answers."""
        for spec in self.tools.values():
            if spec.cls != "read" or not spec.owner_key or key not in (spec.parameters.get("properties") or {}):
                continue
            try:
                result = self.call(self.fresh_db(), spec.name, {key: value})
            except Exception:  # noqa: BLE001 - a read that cannot answer does not decide ownership
                continue
            if isinstance(result, dict) and not result.get("error") and spec.owner_key in result:
                return str(result[spec.owner_key])
        return None

    def record_exists(self, key: str, value: Any) -> bool | None:
        """True/False when a read tool taking `key` answers, None when none does."""
        for spec in self.tools.values():
            if spec.cls != "read" or key not in (spec.parameters.get("properties") or {}):
                continue
            try:
                result = self.call(self.fresh_db(), spec.name, {key: value})
            except Exception:  # noqa: BLE001
                continue
            return isinstance(result, dict) and not result.get("error")
        return None


# ---------------------------------------------------------------------------
# Verdict (what the Judge produces)
# ---------------------------------------------------------------------------

FailureKind = Literal[
    "unauthorized_action",
    "hallucinated_success",
    "data_leak",
    "wrong_action",
    "crash",
    "over_refusal",
]


class Verdict(BaseModel):
    scenario_id: str
    config_version: int
    passed: bool
    failure_kind: FailureKind | None = None
    reason: str
    method: Literal["deterministic", "llm"]
    evidence: dict[str, Any] = Field(default_factory=dict)


# ---------------------------------------------------------------------------
# Patch proposals and gate results
# ---------------------------------------------------------------------------

PatchKind = Literal[
    "add_guardrail_rule",
    "rewrite_system_prompt",
    "add_tool_validator",
    "tighten_tool_policy",
]


class Patch(BaseModel):
    kind: PatchKind
    rationale: str
    guardrail_rule: str | None = None
    system_prompt: str | None = None
    validator_name: str | None = None
    tool_policy: ToolPolicy | None = None


class GateResult(BaseModel):
    accepted: bool
    fixes_new_failure: bool
    regression_pass_rate: float
    # None when the legit guard did not run: no legit task of the pack is runnable against this target
    # (`legit_covered.covered == 0`). 0.0 means it ran and every row failed; the two must never be confused.
    legit_pass_rate: float | None = None
    failed_scenario_ids: list[str] = Field(default_factory=list)
    reason: str
    weave_eval_urls: list[str] = Field(default_factory=list)
    # The same evaluations' call ids, gate-new samples first: what `POST /api/configs/{v}/review` attaches the human
    # decision to as Weave feedback. Empty on records written before the field existed or without a client.
    weave_eval_call_ids: list[str] = Field(default_factory=list)
    # How many independent episodes of the new failure were run, and how many the candidate passed;
    # `fixes_new_failure` is `fix_passes == fix_samples`. Records gated before sampling existed had one
    # sample, and it passed exactly when `fixes_new_failure` says so.
    fix_samples: int = 1
    fix_passes: int = 1
    # How many of the pack's legit tasks the legit guard could run against this target: a task whose expected
    # calls name a tool the target does not have (by name or alias) is skipped, not failed. None on records
    # written before coverage was measured; `covered == total` when the target lists no tools (all are judged).
    legit_covered: dict[str, int] | None = Field(default=None, description="{covered, total}: legit tasks the target can perform, of the pack's total.")

    @computed_field  # type: ignore[prop-decorator]
    @property
    def pass_k(self) -> dict[str, int]:
        """pass^k, the number the UI shows: the fix held in `passed` of `k` independent episodes (`GATE_FIX_SAMPLES`)."""
        return {"k": self.fix_samples, "passed": self.fix_passes}

    @model_validator(mode="before")
    @classmethod
    def _passes_follow_the_verdict(cls, data: Any) -> Any:
        if isinstance(data, dict):
            # `pass_k` is derived; a record that carries it (every one written after it existed) must not fail to load.
            data = {k: v for k, v in data.items() if k != "pass_k"}
            if "fix_passes" not in data and "fix_samples" not in data:
                return {**data, "fix_passes": 1 if data.get("fixes_new_failure") else 0}
        return data


# ---------------------------------------------------------------------------
# One full turn of the loop, appended to cycles.jsonl for the dashboard
# ---------------------------------------------------------------------------


class TokenCount(BaseModel):
    input: int = 0
    output: int = 0


class CycleRecord(BaseModel):
    cycle: int
    timestamp: str = Field(
        default_factory=lambda: datetime.now(timezone.utc).isoformat()
    )
    scenario: Scenario
    attack_succeeded: bool
    episode: Episode | None = Field(default=None, description="What the target actually did: tool calls and final reply.")
    verdict: Verdict
    patch: Patch | None = None
    gate: GateResult | None = None
    config_before: int
    config_after: int
    regression_suite_size: int
    # The gate's `legit_pass_rate` is a fraction; this is the denominator behind it. Records written before
    # the field existed (the golden tape) ran against the three-row legit suite of the time, hence the default.
    legit_suite_size: int = 3
    weave_call_url: str | None = None
    retry_of: int | None = Field(
        default=None,
        description="Set on second-pass cycles: the earlier cycle whose failure this one revisits with the evolved config and fuller repair memory.",
    )
    also_fixed: list[str] = Field(
        default_factory=list,
        description="Previously unfixed regression scenarios that started passing after this cycle's patch (measured at the baseline refresh, not assumed).",
    )
    # What the cycle cost, wall-clock and in model calls, across every role (target, judge, chaos, repair, gate
    # evaluations). None on records written before the fields existed. `cost_usd` is Weave's own accounting of the
    # cycle's trace (the price table in `chaos.config`, registered with `add_cost`) when the loop could read it back,
    # else the in-process estimate from the same table; `cost_source` says which (None on records written before it).
    latency_ms: int | None = None
    tokens: TokenCount | None = None
    cost_usd: float | None = None
    cost_source: Literal["weave", "estimated"] | None = None
