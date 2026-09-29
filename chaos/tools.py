"""World-agnostic tool plumbing: the per-tool rule checks and the argument normalisers.

What a tool *does* lives in its domain pack (`chaos/domains/<name>/tools.py`); this module knows only tool names,
arguments and the conversation, which is why the enforcement gateway can run `tool_rule_blocks` in front of tools
Antibody never wrote.
"""

from __future__ import annotations

import json
import math
import re
from email.utils import parseaddr
from typing import Any

from chaos.schemas import ToolRule

# Verbs a tool name starts with that say nothing about what the customer would ask for: `issue_refund` → "refund".
_TOOL_NAME_VERBS = frozenset({"issue", "send", "create", "get", "do", "make", "set", "update", "delete", "cancel", "apply", "run", "call", "post", "put", "add", "remove", "list", "lookup", "look", "fetch", "read", "write"})


def intent_words_for(tool: str, rule: ToolRule) -> list[str]:
    """What a customer turn must mention for `requires_user_intent`: the rule's words, else the tool's name minus its verb."""
    if rule.intent_words:
        return [w.lower() for w in rule.intent_words if w.strip()]
    words = [w for w in re.split(r"[_\-\s]+", tool.lower()) if w and w not in _TOOL_NAME_VERBS]
    return words or [tool.lower()]


def said_any(words: list[str], user_turns: list[str]) -> bool:
    """True if some USER turn (never a tool result) mentions one of the words."""
    said = " ".join(t or "" for t in user_turns).lower()
    return any(w in said for w in words)


def tool_rule_blocks(
    tool: str,
    args: dict[str, Any],
    rule: ToolRule,
    user_turns: list[str],
    verified_ids: set[str],
    prior_calls: int,
) -> str | None:
    """The world-agnostic checks (`ToolRule`): the ones the gateway can run in front of tools Antibody never wrote.

    `verified_ids` are the ids some earlier tool returned a matching record for (`chaos.toolbus` collects them
    from any `*_id` argument echoed by a result); `prior_calls` counts this tool's earlier calls in the session.
    """
    if rule.deny:
        return f"policy: {tool} is not allowed for this agent"
    if rule.max_calls is not None and prior_calls >= rule.max_calls:
        return f"policy: {tool} may be called at most {rule.max_calls} time{'s' if rule.max_calls != 1 else ''} per conversation"
    if rule.requires_user_intent:
        words = intent_words_for(tool, rule)
        if not said_any(words, user_turns):
            return f"policy: the customer never asked for {' or '.join(words)} in this conversation"
    if rule.requires_verified_lookup:
        named = {str(v).strip() for k, v in args.items() if k.endswith("_id") and str(v).strip()}
        if named:
            missing = sorted(named - verified_ids)
            if missing:
                return f"policy: {tool} requires a successful lookup of {', '.join(missing)} first"
        elif not verified_ids:
            return f"policy: {tool} requires a successful lookup first; nothing has been verified in this conversation"
    return None


def normalize_email(value: Any) -> str:
    """'Maya <Maya@Example.com> ' -> 'maya@example.com'."""
    _, addr = parseaddr(str(value or ""))
    return addr.strip().lower()


def coerce_amount(value: Any) -> float | None:
    """Return a finite positive float, or None if the value is not a usable amount."""
    if isinstance(value, bool):
        return None
    try:
        amount = float(value)
    except (TypeError, ValueError):
        try:
            amount = float(re.sub(r"[^\d.]", "", str(value)))
        except ValueError:
            return None
    if math.isnan(amount) or math.isinf(amount) or amount <= 0:
        return None
    return amount


def serialize_result(result: Any) -> str:
    try:
        return json.dumps(result)
    except TypeError:
        return str(result)
