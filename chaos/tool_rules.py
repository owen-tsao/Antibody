"""Tool classes and the starter rules for tools Antibody never wrote (docs/plans/09-roadmap-v1.md §4).

A connected agent lists its tools (`GET /tools` → `[{name, description}]`). From the names and descriptions
alone — no calls, no schema — each tool is put in one of four classes, and a class carries the rule a
support team would want on day one. Pure functions: the Tools panel shows the proposal, a person applies it.

  read      look something up            → no rule (reads are how the agent verifies anything)
  money     move money                    → needs customer intent, needs a verified lookup, at most one call
  message   send something to someone    → needs a verified lookup
  mutate    change a record              → needs customer intent, needs a verified lookup
  unknown   none of the words matched    → needs a verified lookup (the safe default for an action)

`tool_class` is the one classifier: the Tools panel, the repair agent's starter rules, the judge and the gateway's
fail-open/fail-closed decision all ask it, so the class a person saw at onboarding is the class that decides in
production. The words are English and product-agnostic. A wrong class costs one toggle in the panel; the rule text
is generic enough (`ToolRule`) that the enforcement gateway can run it in front of the real tool.
"""

from __future__ import annotations

import re

from chaos.schemas import Domain, ToolClass, ToolRule

_WORDS: dict[ToolClass, tuple[str, ...]] = {
    "money": ("refund", "charge", "payment", "pay", "credit", "debit", "invoice", "bill", "transfer", "payout", "wallet", "balance", "coupon", "discount", "gift", "compensation", "compensate", "voucher", "reimburse", "money", "funds"),
    "message": ("email", "mail", "sms", "text", "message", "notify", "notification", "send", "reply", "post", "slack", "whatsapp"),
    "mutate": ("update", "set", "change", "edit", "cancel", "delete", "remove", "create", "add", "reset", "close", "reopen", "assign", "escalate", "upgrade", "downgrade", "modify", "write", "reschedule", "ship", "return", "exchange"),
    "read": ("lookup", "look", "get", "read", "find", "fetch", "search", "check", "list", "retrieve", "show", "query", "view", "status", "track", "history", "describe", "load"),
    "unknown": (),
}

# A name whose first word is a read verb is a read (`get_refund_status` reads; it does not refund). Otherwise
# actions dominate, money first: a tool that both reads and moves money is treated as the dangerous one.
READ_VERBS = frozenset(_WORDS["read"])
_ORDER: tuple[ToolClass, ...] = ("money", "message", "mutate", "read")


def _tokens(*texts: str) -> set[str]:
    out: set[str] = set()
    for t in texts:
        out.update(w for w in re.split(r"[^a-z]+", (t or "").lower()) if w)
    return out


def classify(name: str, description: str = "") -> ToolClass:
    """The class a tool's name (first) or description (second) puts it in; `unknown` when nothing matches."""
    name_words = [w for w in re.split(r"[^a-z]+", name.lower()) if w]
    if name_words and name_words[0] in _WORDS["read"]:
        return "read"
    for source in (set(name_words), _tokens(description)):
        for cls in _ORDER:
            if source & set(_WORDS[cls]):
                return cls
    return "unknown"


def tool_class(domain: Domain | None, name: str, description: str = "") -> ToolClass:
    """The one class a tool has everywhere: the pack's when it knows the tool by name or alias (an `issue_compensation`
    is money because the pack says so), else `classify` on the name and whatever description the agent gave."""
    own = domain.canonical(name) if domain is not None else None
    return domain.tools[own].cls if own else classify(name, description)


def classes(tools: list[dict], domain: Domain | None = None) -> dict[str, ToolClass]:
    """`{name: class}` for a tool list as an agent reports it (`[{name, description}]`), pack override included."""
    return {t["name"]: tool_class(domain, t["name"], t.get("description") or "") for t in tools if isinstance(t, dict) and isinstance(t.get("name"), str)}


def starter_rule(cls: ToolClass, has_read: bool = True) -> ToolRule | None:
    """The day-one rule for a class; None for reads.

    `has_read` says whether the agent's tool list has at least one read-class tool. Without one
    `requires_verified_lookup` can never be satisfied — verification comes from a read tool returning a record
    that echoes an id (`chaos.toolbus._note_verified`) — so it would deny every call of the tool for good. In that
    case the rule keeps the intent and call-count parts and the lookup part is left out; an `unknown` tool with
    nothing else to say gets no rule rather than an unsatisfiable one.
    """
    if cls == "read":
        return None
    if cls == "money":
        return ToolRule(requires_user_intent=True, requires_verified_lookup=has_read, max_calls=1)
    if cls == "message":
        return ToolRule(requires_verified_lookup=True) if has_read else None
    if cls == "mutate":
        return ToolRule(requires_user_intent=True, requires_verified_lookup=has_read)
    return ToolRule(requires_verified_lookup=True) if has_read else None


def starter_rules(tools: list[dict], domain: Domain | None = None) -> dict[str, ToolRule]:
    """`{tool name: rule}` for every tool that gets one; reads are left out.

    The lookup requirement is only proposed when the list has a read tool to satisfy it (see `starter_rule`).
    """
    by_name = classes(tools, domain)
    has_read = "read" in by_name.values()
    out: dict[str, ToolRule] = {}
    for name, cls in by_name.items():
        if not name:
            continue
        rule = starter_rule(cls, has_read)
        if rule is not None:
            out[name] = rule
    return out


def fails_closed(cls: ToolClass) -> bool:
    """Whether a tool of this class is refused when the gateway cannot check it or reach it (plan 10 §5b).

    Money and record changes cannot be undone, so they fail closed; a lookup or a message the customer will see
    fails open (the agent gets whatever came back, or an error, and the call is logged `degraded`). A tool no
    word matched is an action until someone says otherwise, so it fails closed too — the customer overrides per
    tool with `ToolRule.on_failure`.
    """
    return cls not in ("read", "message")


def failure_mode(cls: ToolClass, rule: ToolRule | None) -> str:
    """`closed` | `open` for one call: the rule's own `on_failure` when set, else what the tool's class says.

    `cls` comes from `tool_class` — the gateway resolves it from the backend's own tool list (name and description,
    pack override) so the class that decides here is the one the Tools panel showed.
    """
    if rule is not None and rule.on_failure:
        return rule.on_failure
    return "closed" if fails_closed(cls) else "open"
