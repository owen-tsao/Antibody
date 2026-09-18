"""The tool bus: the one place a target agent's tool call actually runs.

Antibody sits between an agent and its tools. Everything it does to a call — enforce the accepted
policy, inject the scenario's fault, run the config's validators, keep the record the Judge scores —
happens in `call_tool`, against a `ToolSession` that holds one episode's state. The built-in agent
and (later) an external agent's tool server both go through here, so a policy that blocks a refund
blocks it for either.
"""

from __future__ import annotations

import contextvars
from contextlib import contextmanager
from dataclasses import dataclass, field
from typing import Any, Iterator

from chaos import zendesk
from chaos.schemas import AgentConfig, Scenario, ToolCall, ToolFault
from chaos.tools import TICKET_TOOL_FUNCS, TOOL_FUNCS, VALIDATORS, policy_blocks


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
    verified_orders: set[str] = field(default_factory=set)
    calls: list[ToolCall] = field(default_factory=list)


# The built-in agent binds its session here for the duration of an episode. asyncio.to_thread copies
# contextvars, so concurrent gate rows (one thread each) keep their sessions apart without a lock.
CURRENT_SESSION: contextvars.ContextVar[ToolSession | None] = contextvars.ContextVar("tool_session", default=None)


@contextmanager
def bind(session: ToolSession) -> Iterator[ToolSession]:
    token = CURRENT_SESSION.set(session)
    try:
        yield session
    finally:
        CURRENT_SESSION.reset(token)


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
    """policy_blocks → TOOL_FUNCS[name] → apply_fault → validators → record. The only way a tool runs."""
    if not isinstance(args, dict):
        args = {}
    cfg, scenario = session.cfg, session.scenario

    if name not in TOOL_FUNCS or (name in TICKET_TOOL_FUNCS and not session.ticket_mode):
        return _record(session, ToolCall(tool=name, args=args, result={"error": f"unknown tool {name}"}))

    try:
        block_reason = policy_blocks(
            name, args, cfg.tool_policy, scenario.customer_id,
            user_turns=session.customer_turns,
            assigned_ticket=scenario.ticket_id if session.ticket_mode else None,
            verified_orders=session.verified_orders,
        )
    except Exception as e:  # noqa: BLE001 - a policy check that cannot run must block, never allow
        block_reason = f"policy: check failed on malformed arguments ({type(e).__name__})"
    if block_reason:
        return _record(
            session,
            ToolCall(tool=name, args=args, result={"error": block_reason}, blocked_by_policy=True, blocked_by=block_reason),
        )

    fault = next((f for f in scenario.faults if f.tool == name), None)
    try:
        result = apply_fault(fault, TOOL_FUNCS[name](**args))
    except TimeoutError as e:
        result = {"error": str(e)}
    except Exception as e:  # noqa: BLE001
        result = {"error": f"tool crashed: {e}"}

    if name == "read_ticket":
        session.customer_turns.extend(zendesk.customer_turns(result if isinstance(result, dict) else None))
    for vname in cfg.tool_output_validators:
        result = VALIDATORS[vname](name, result, args)
    if (
        name == "lookup_order"
        and isinstance(result, dict)
        and "order_id" in result
        and not result.get("error")
        and str(result["order_id"]).strip() == str(args.get("order_id", "")).strip()
    ):
        # Only a record that survived every validator AND matches the order asked for counts as
        # verified; a wrong-record fault must not let the model act on someone else's order.
        session.verified_orders.add(str(result["order_id"]).strip())
    return _record(session, ToolCall(tool=name, args=args, result=result))


def _record(session: ToolSession, call: ToolCall) -> ToolCall:
    session.calls.append(call)
    return call
