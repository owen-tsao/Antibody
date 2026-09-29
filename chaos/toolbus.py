"""The tool bus: the one place a target agent's tool call actually runs.

Antibody sits between an agent and its tools. Everything it does to a call — enforce the accepted
policy, inject the scenario's fault, run the config's validators, keep the record the Judge scores —
happens in `call_tool`, against a `ToolSession` that holds one episode's state. The built-in agent
and (later) an external agent's tool server both go through here, so a policy that blocks a refund
blocks it for either.
"""

from __future__ import annotations

import time
import urllib.error
from dataclasses import dataclass, field
from typing import Any

from chaos import zendesk
from chaos.domains import active_domain
from chaos.schemas import AgentConfig, Domain, Episode, Scenario, ToolCall, ToolClass, ToolFault, ToolRule
from chaos.tool_rules import READ_VERBS, failure_mode, tool_class
from chaos.tools import tool_rule_blocks


@dataclass
class ToolSession:
    """One episode's tool-side state. Owned by whoever runs the episode; read and written by `call_tool`."""

    cfg: AgentConfig
    scenario: Scenario
    # What the customer actually said, for policy checks. In ticket mode only public requester
    # comments count (fed from read_ticket results); the harness's opening line is not the customer.
    customer_turns: list[str]
    # Whether the ticket tools exist in this session and ticket scoping applies. A scenario can carry a
    # ticket id while Zendesk is off (mock world), so this is decided by the caller, not the scenario.
    ticket_mode: bool = False
    # The customer's own tool server (plan 09 §4): `POST {tools_backend}/tools/{name}`. When set it wins for
    # every name — their `lookup_order` is theirs, not the mock's — and only the world-agnostic checks run:
    # the per-tool rules and the scenario's faults; the pack's flags and validators know the pack's keys.
    tools_backend: str | None = None
    # Shadow mode (the gateway's first weeks): a rule that would block logs `shadowed` and the call still runs.
    shadow: bool = False
    # The id the agent sends in `X-Antibody-Session`: set by the tool server when it registers the session and by
    # the gateway on first sight, and forwarded to `tools_backend` so a customer's tools can key their own state by it.
    session_id: str | None = None
    # The `Authorization` header value the customer's own tools expect (`ANTIBODY_BACKEND_AUTH` on the gateway);
    # never the token the agent presented to the gateway. None sends no such header.
    backend_auth: str | None = None
    # Pass-through only: the classes the gateway resolved from the backend's own tool list (`chaos.tool_rules.classes`:
    # name and description, pack override) — what decides fail-open/fail-closed. A tool not in it is classed by the
    # pack and its name at call time, through the same `tool_class`.
    tool_classes: dict[str, ToolClass] = field(default_factory=dict)
    # The world this session's tools run in (`ANTIBODY_DOMAIN` unless the caller says), and this session's own
    # copy of its records: an airline tool that cancels a flight changes `db`, never the pack's seed.
    domain: Domain = field(default_factory=active_domain)
    db: dict[str, Any] | None = None
    verified_orders: set[str] = field(default_factory=set)
    calls: list[ToolCall] = field(default_factory=list)

    def __post_init__(self) -> None:
        if self.db is None:
            self.db = self.domain.fresh_db()

    @property
    def customer_id(self) -> str:
        return self.scenario.customer_id

    @property
    def customer_email(self) -> str:
        """Who the agent is talking to. The built-in prompt states it; an external agent is told in `/episode`."""
        return self.domain.customer_email(self.scenario.customer_id)

    def prior_calls(self, name: str) -> int:
        """How many times this tool has actually run in the session; attempts a rule blocked do not count."""
        return sum(1 for c in self.calls if c.tool == name and not c.blocked_by_policy)

    def episode(self, final_reply: str, error: str | None = None) -> Episode:
        """The episode record every target hands back: this session's calls plus whatever the agent said last.

        `domain`/`end_state` are set only when the pack's tools ran: a pass-through session's state lives in the
        customer's backend, and the judge then has calls and transcript only.
        """
        return Episode(
            scenario_id=self.scenario.id,
            config_version=self.cfg.version,
            tool_calls=self.calls,
            final_reply=final_reply,
            error=error,
            domain=None if self.tools_backend else self.domain.name,
            end_state=None if self.tools_backend else self.domain.end_state(self.db or {}),
        )


def apply_fault(fault: ToolFault | None, clean_result: Any) -> Any:
    """Tamper with a clean tool result the way the scenario asks. `timeout` raises like a real one would."""
    if fault is None:
        return clean_result
    if fault.mode == "null":
        return None
    if fault.mode == "malformed":
        return fault.payload if fault.payload is not None else "<html>502 Bad Gateway</html>"
    if fault.mode == "timeout":
        raise TimeoutError(f"{fault.tool} timed out after 30s")
    if fault.mode == "inject":
        if isinstance(clean_result, dict):
            tampered = dict(clean_result)
            tampered["notes"] = fault.payload
            return tampered
        return f"{clean_result}\n{fault.payload}"
    if fault.mode == "wrong_record":
        return fault.payload
    return clean_result


def call_tool(session: ToolSession, name: str, args: Any) -> ToolCall:
    """rule → pack flags → the pack's tool on this session's db → apply_fault → validators → record. The only way a tool runs."""
    if not isinstance(args, dict):
        args = {}
    if session.tools_backend:
        return _call_passthrough(session, name, args)
    cfg, scenario, domain = session.cfg, session.scenario, session.domain

    spec = domain.tools.get(name)
    if spec is None or (spec.ticket_only and not session.ticket_mode):
        return _record(session, ToolCall(tool=name, args=args, result={"error": f"unknown tool {name}"}))

    try:
        block_reason = None
        rule = cfg.tool_policy.tool_rules.get(name)
        if rule is not None:
            block_reason = tool_rule_blocks(name, args, rule, session.customer_turns, session.verified_orders, session.prior_calls(name))
        if block_reason is None:
            block_reason = domain.policy_blocks(
                name, args, cfg.tool_policy, scenario.customer_id, session.db or {},
                user_turns=session.customer_turns,
                assigned_ticket=scenario.ticket_id if session.ticket_mode else None,
                verified_ids=session.verified_orders,
            )
    except Exception as e:  # noqa: BLE001 - a policy check that cannot run must block, never allow
        block_reason = f"policy: check failed on malformed arguments ({type(e).__name__})"
    if block_reason:
        return _record(
            session,
            ToolCall(tool=name, args=args, result={"error": block_reason}, blocked_by_policy=True, blocked_by=block_reason),
        )

    # Last fault named for a tool wins: the Chaos Agent may emit two for one tool, and the thread-local
    # map this replaced was built in a loop, so the later one overwrote the earlier.
    fault = {f.tool: f for f in scenario.faults}.get(name)
    try:
        result = apply_fault(fault, domain.call(session.db or {}, name, args))
    except TimeoutError as e:
        result = {"error": str(e)}
    except Exception as e:  # noqa: BLE001
        result = {"error": f"tool crashed: {e}"}

    if name == "read_ticket":
        session.customer_turns.extend(zendesk.customer_turns(result if isinstance(result, dict) else None))
    try:
        for vname in cfg.tool_output_validators:
            result = domain.validators[vname](name, result, args)
    except Exception as e:  # noqa: BLE001 - a validator that dies must not lose the call from the record
        result = {"error": f"validator {vname} crashed: {e}"}
    _note_verified(session, name, args, result)
    return _record(session, ToolCall(tool=name, args=args, result=result))


def _call_passthrough(session: ToolSession, name: str, args: dict) -> ToolCall:
    """The customer's tool, fronted: per-tool rule → the scenario's fault → `POST {backend}/tools/{name}` → record.

    No storefront flag or validator runs here: they read Northwind's keys, and this is not Northwind. What a
    fault does still applies — an `inject` tampers with whatever the real tool returned — so the chaos agent
    can attack a real tool the way it attacks the mock.

    When the check itself raises or the real tool cannot be reached (refused, timed out, non-2xx), the tool's class
    decides (plan 10 §5b, `chaos.tool_rules.failure_mode` on `_class_of`): money/mutate/unknown are refused with
    `{"error": "gateway: refused — …"}` and `blocked_by="failure:…"`; read/message go through — the agent gets the
    error as tool output — and the call is recorded `degraded`. `elapsed_ms` covers the check and the tool together.
    """
    from chaos.target import is_timeout, post_json

    started = time.monotonic()
    rule = session.cfg.tool_policy.tool_rules.get(name)
    reason = None
    check_failed = None
    if rule is not None:
        try:
            reason = tool_rule_blocks(name, args, rule, session.customer_turns, session.verified_orders, session.prior_calls(name))
        except Exception as e:  # noqa: BLE001
            check_failed = f"check failed on malformed arguments ({type(e).__name__})"
    if check_failed and failure_mode(_class_of(session, name), rule) == "closed":
        return _refused(session, name, args, check_failed, started)
    if reason and not session.shadow:
        return _record(session, ToolCall(tool=name, args=args, result={"error": reason}, blocked_by_policy=True, blocked_by=reason, elapsed_ms=_ms(started)))

    fault = {f.tool: f for f in session.scenario.faults}.get(name)
    headers = _backend_headers(session)
    timeout = rule.timeout_s if rule is not None and rule.timeout_s else PASSTHROUGH_TIMEOUT_S
    try:
        raw = post_json(f"{session.tools_backend.rstrip('/')}/tools/{name}", args, timeout, headers)
    except urllib.error.HTTPError as e:
        if e.code >= 500:
            return _failed(session, name, args, rule, reason, f"backend error: HTTP {e.code}", started)
        # The backend answered "no" (unknown tool, bad arguments): its tool did not run, and it said so.
        raw = {"error": f"tool failed: {type(e).__name__}: {e}"}
    except Exception as e:  # noqa: BLE001 - refused, reset, DNS, timed out: the tool never answered
        return _failed(session, name, args, rule, reason, "backend timed out" if is_timeout(e) else f"backend unreachable: {type(e).__name__}: {e}", started)
    try:
        result = apply_fault(fault, raw)
    except TimeoutError as e:  # the scenario's own `timeout` fault: simulated, so the class semantics do not apply
        result = {"error": str(e)}
    _note_verified(session, name, args, result)
    return _record(session, ToolCall(tool=name, args=args, result=result, shadowed=bool(reason), blocked_by=reason, degraded=bool(check_failed), elapsed_ms=_ms(started)))


def _failed(session: ToolSession, name: str, args: dict, rule: ToolRule | None, reason: str | None, why: str, started: float) -> ToolCall:
    """The real tool did not answer: refused for a class that fails closed, else an error result marked `degraded`."""
    if failure_mode(_class_of(session, name), rule) == "closed":
        return _refused(session, name, args, why, started)
    return _record(session, ToolCall(tool=name, args=args, result={"error": f"tool failed: {why}"}, shadowed=bool(reason), blocked_by=reason, degraded=True, elapsed_ms=_ms(started)))


def _class_of(session: ToolSession, name: str) -> ToolClass:
    """The class that decides a pass-through call's failure semantics: the one the gateway resolved from the backend's
    tool list when it listed this tool, else the pack's or the name's — one classifier either way (`tool_class`)."""
    return session.tool_classes.get(name) or tool_class(session.domain, name)


def _refused(session: ToolSession, name: str, args: dict, why: str, started: float) -> ToolCall:
    """A call the gateway would not let run because it could not check or deliver it: refused, never forwarded."""
    return _record(session, ToolCall(tool=name, args=args, result={"error": f"gateway: refused — {why}"}, blocked_by_policy=True, blocked_by=f"failure:{why}", elapsed_ms=_ms(started)))


def _backend_headers(session: ToolSession) -> dict[str, str] | None:
    headers: dict[str, str] = {}
    if session.session_id:
        headers[SESSION_HEADER] = session.session_id
    if session.backend_auth:
        headers["Authorization"] = session.backend_auth
    return headers or None


def _ms(started: float) -> int:
    return int((time.monotonic() - started) * 1000)


def verified_by(session: ToolSession, call: ToolCall) -> list[str]:
    """The ids this call's result verified, for the gateway log: a read tool's `*_id` arguments that the session now
    holds as verified. What the replay needs to rebuild `requires_verified_lookup` without the result itself."""
    if call.blocked_by_policy or not _is_read_tool(session, call.tool) or not isinstance(call.result, dict) or call.result.get("error"):
        return []
    return sorted({str(v).strip() for k, v in call.args.items() if k.endswith("_id") and str(v).strip() in session.verified_orders})


PASSTHROUGH_TIMEOUT_S = 30.0
# The header an agent sends its session id in, on the loop's tool server and on the gateway alike.
SESSION_HEADER = "X-Antibody-Session"


def _is_read_tool(session: ToolSession, name: str) -> bool:
    """Whether a tool's echoed ids verify: the pack's class for its own tools (by name or alias); for a pass-through
    tool the pack does not know, a name that starts with a read verb (the same list the Tools panel classifies with,
    chaos.tool_rules), so a tool proposed as "read" also verifies what it returns. Action tools that echo an id back
    (`issue_refund` → `order_id`) must not, or a refund would "verify" the order for the email after it."""
    if not session.tools_backend:
        spec = session.domain.tools.get(name)
        # A ticket read is the real world, not the data world: knowing ticket #60 exists verifies no order.
        return spec is not None and spec.cls == "read" and not spec.ticket_only
    if session.domain.canonical(name) is not None:
        return session.domain.tool_class(name) == "read"
    head = name.lower().replace("-", "_").split("_", 1)[0]
    return head in READ_VERBS


def _note_verified(session: ToolSession, name: str, args: dict, result: Any) -> None:
    """A read tool's result that echoes an `*_id` argument is a verified record for that id (`lookup_order` → `order_id`).

    Only a record that survived every validator AND matches the id asked for counts; a wrong-record fault must
    not let the model act on someone else's order. Generic over the argument name so a customer's own lookup
    tools verify too.
    """
    if not _is_read_tool(session, name) or not isinstance(result, dict) or result.get("error"):
        return
    for key, value in args.items():
        if key.endswith("_id") and key in result and str(result[key]).strip() == str(value).strip() and str(value).strip():
            session.verified_orders.add(str(value).strip())


def _record(session: ToolSession, call: ToolCall) -> ToolCall:
    session.calls.append(call)
    return call
