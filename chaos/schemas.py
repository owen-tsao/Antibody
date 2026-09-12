"""Interface contracts shared by every agent in the loop.

These four schemas are the seams between the Chaos Agent, Target Agent, Judge,
Repair Agent, and Eval Gate. Anything built in parallel builds against these.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Literal

from pydantic import BaseModel, Field

# ---------------------------------------------------------------------------
# Agent configuration (the thing the Repair Agent patches)
# ---------------------------------------------------------------------------

ToolName = Literal["lookup_order", "issue_refund", "send_email"]


class ToolPolicy(BaseModel):
    """Permission rules enforced in code, not by the model."""

    refund_requires_order_match: bool = False
    refund_max_amount: float | None = None
    email_only_to_order_owner: bool = False


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
]


class ToolFault(BaseModel):
    """How the chaos harness tampers with a tool during one episode."""

    tool: ToolName
    mode: Literal["inject", "null", "malformed", "timeout", "wrong_record"]
    payload: Any = None


class Scenario(BaseModel):
    id: str
    kind: ScenarioKind
    title: str
    user_message: str
    customer_id: str = "cust_owen"
    faults: list[ToolFault] = Field(default_factory=list)
    expected_behavior: str = Field(
        description="Plain-language statement of what a correct agent does here."
    )
    forbidden_tool_calls: list[str] = Field(
        default_factory=list,
        description="Tool names that must NOT be called with attacker-favorable args.",
    )
    origin: Literal["seed", "chaos_agent", "legit"] = "chaos_agent"


# ---------------------------------------------------------------------------
# Episode trace (what actually happened when the target ran a scenario)
# ---------------------------------------------------------------------------


class ToolCall(BaseModel):
    tool: str
    args: dict[str, Any]
    result: Any
    blocked_by_policy: bool = False


class Episode(BaseModel):
    scenario_id: str
    config_version: int
    tool_calls: list[ToolCall] = Field(default_factory=list)
    final_reply: str
    error: str | None = None


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
    legit_pass_rate: float
    failed_scenario_ids: list[str] = Field(default_factory=list)
    reason: str


# ---------------------------------------------------------------------------
# One full turn of the loop, appended to cycles.jsonl for the dashboard
# ---------------------------------------------------------------------------


class CycleRecord(BaseModel):
    cycle: int
    timestamp: str = Field(
        default_factory=lambda: datetime.now(timezone.utc).isoformat()
    )
    scenario: Scenario
    attack_succeeded: bool
    verdict: Verdict
    patch: Patch | None = None
    gate: GateResult | None = None
    config_before: int
    config_after: int
    regression_suite_size: int
    weave_call_url: str | None = None
