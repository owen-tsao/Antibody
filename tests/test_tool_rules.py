"""Per-tool rules (plan 09 §4): world-agnostic checks any tool name can carry, and how patches merge them."""

from __future__ import annotations

import pytest

from chaos.repair_agent import apply_patch, merge_tool_rules, rule_detail
from chaos.schemas import AgentConfig, Patch, ToolPolicy, ToolRule
from chaos.tool_rules import classify, starter_rules
from chaos.tools import intent_words_for, tool_rule_blocks


@pytest.mark.parametrize(
    "name, description, cls",
    [
        ("lookup_order", "", "read"),
        ("get_refund_status", "", "read"),
        ("issue_refund", "", "money"),
        ("apply_store_credit", "", "money"),
        ("send_email", "", "message"),
        ("notify_customer", "", "message"),
        ("cancel_subscription", "", "mutate"),
        ("update_shipping_address", "", "mutate"),
        ("frobnicate", "Refund the customer's last charge", "money"),
        ("frobnicate", "", "unknown"),
        ("escalate", "Reassign the ticket to a human", "mutate"),
    ],
)
def test_classify_from_name_then_description(name, description, cls):
    assert classify(name, description) == cls


def test_starter_rules_leave_reads_alone_and_cap_money():
    rules = starter_rules([{"name": "lookup_order"}, {"name": "issue_refund"}, {"name": "send_email"}, {"name": "frobnicate"}])
    assert "lookup_order" not in rules
    assert rules["issue_refund"] == ToolRule(requires_user_intent=True, requires_verified_lookup=True, max_calls=1)
    assert rules["send_email"] == ToolRule(requires_verified_lookup=True)
    assert rules["frobnicate"] == ToolRule(requires_verified_lookup=True)


def test_starter_rules_never_require_a_lookup_no_tool_can_provide():
    """Without a read-class tool nothing ever verifies an id, so `requires_verified_lookup` would deny the tool forever."""
    rules = starter_rules([{"name": "issue_refund"}, {"name": "send_email"}, {"name": "cancel_subscription"}, {"name": "frobnicate"}])
    assert rules["issue_refund"] == ToolRule(requires_user_intent=True, max_calls=1)
    assert rules["cancel_subscription"] == ToolRule(requires_user_intent=True)
    assert "send_email" not in rules and "frobnicate" not in rules, "a lookup-only rule with no lookup tool is no rule"
    assert not any(r.requires_verified_lookup for r in rules.values())
    # One read tool anywhere in the list brings the lookup requirement back for every action.
    with_read = starter_rules([{"name": "issue_refund"}, {"name": "get_account"}])
    assert with_read["issue_refund"].requires_verified_lookup is True


def test_intent_words_default_to_the_tool_name_minus_its_verb():
    assert intent_words_for("issue_refund", ToolRule()) == ["refund"]
    assert intent_words_for("cancel_subscription", ToolRule()) == ["subscription"]
    assert intent_words_for("send", ToolRule()) == ["send"]
    assert intent_words_for("issue_refund", ToolRule(intent_words=["Money back", "refund"])) == ["money back", "refund"]


def test_rule_checks():
    turns_yes = ["hi, I want a refund on B-2001"]
    turns_no = ["where is my order?"]
    assert tool_rule_blocks("issue_refund", {}, ToolRule(deny=True), turns_yes, set(), 0) == "policy: issue_refund is not allowed for this agent"
    assert tool_rule_blocks("issue_refund", {}, ToolRule(max_calls=1), turns_yes, set(), 1).startswith("policy: issue_refund may be called at most 1 time")
    assert tool_rule_blocks("issue_refund", {}, ToolRule(max_calls=1), turns_yes, set(), 0) is None
    assert tool_rule_blocks("issue_refund", {}, ToolRule(requires_user_intent=True), turns_no, set(), 0) == "policy: the customer never asked for refund in this conversation"
    assert tool_rule_blocks("issue_refund", {}, ToolRule(requires_user_intent=True), turns_yes, set(), 0) is None
    # Verified lookup: an id the call names must have been looked up; with no id named, anything verified will do.
    r = ToolRule(requires_verified_lookup=True)
    assert tool_rule_blocks("issue_refund", {"order_id": "B-2001"}, r, turns_yes, set(), 0) == "policy: issue_refund requires a successful lookup of B-2001 first"
    assert tool_rule_blocks("issue_refund", {"order_id": "B-2001"}, r, turns_yes, {"A-1001"}, 0) is not None
    assert tool_rule_blocks("issue_refund", {"order_id": "B-2001"}, r, turns_yes, {"B-2001"}, 0) is None
    assert tool_rule_blocks("send_email", {"to": "x@y.z"}, r, turns_yes, set(), 0).startswith("policy: send_email requires a successful lookup first")
    assert tool_rule_blocks("send_email", {"to": "x@y.z"}, r, turns_yes, {"A-1001"}, 0) is None


def test_the_tool_bus_runs_the_rule_before_the_packs_flags():
    """A rule on a tool fires first and on its own; the retail flags only speak when no rule blocked."""
    from chaos.domains import load_domain
    from chaos.toolbus import ToolSession, call_tool

    retail = load_domain("retail")
    policy = ToolPolicy(refund_requires_order_match=True, tool_rules={"issue_refund": ToolRule(max_calls=1)})
    cfg = AgentConfig(system_prompt="x", tool_policy=policy)
    scenario = retail.legit[0].model_copy(update={"user_message": "refund please"})
    session = ToolSession(cfg=cfg, scenario=scenario, customer_turns=["refund please"], domain=retail)
    first = call_tool(session, "issue_refund", {"order_id": "A-1001", "amount": 1, "reason": "r"})
    assert not first.blocked_by_policy and session.db["refunds"] == [{"order_id": "A-1001", "amount": 1, "reason": "r", "status": "refunded"}]
    second = call_tool(session, "issue_refund", {"order_id": "A-1001", "amount": 1, "reason": "r"})
    assert second.blocked_by == "policy: issue_refund may be called at most 1 time per conversation"
    # The flag speaks when the rule has nothing to say: a fresh session, another customer's order.
    fresh = ToolSession(cfg=cfg, scenario=scenario, customer_turns=["refund please"], domain=retail)
    other = call_tool(fresh, "issue_refund", {"order_id": "B-2001", "amount": 1, "reason": "r"})
    assert other.blocked_by == "policy: refund order does not belong to the authenticated customer"
    assert retail.db["refunds"] == [], "a session's refund never lands in the pack's seed db"


def test_merge_only_tightens():
    cur = ToolRule(requires_user_intent=True, intent_words=["refund"], max_calls=2)
    inc = ToolRule(requires_verified_lookup=True, intent_words=["money back"], max_calls=5)
    m = merge_tool_rules(cur, inc)
    # Disjoint intent words would leave nothing the customer could say; the words already in force stay.
    assert m == ToolRule(requires_user_intent=True, requires_verified_lookup=True, intent_words=["refund"], max_calls=2)
    assert merge_tool_rules(None, inc) == inc
    assert merge_tool_rules(ToolRule(deny=True), ToolRule()).deny is True


def test_merge_keeps_the_operational_half_field_by_field():
    """`on_failure` and `timeout_s` (plan 10 §5b): a patch that omits them leaves them alone; closed and shorter win."""
    cur = ToolRule(on_failure="open", timeout_s=20.0)
    assert merge_tool_rules(cur, ToolRule(max_calls=1)) == ToolRule(max_calls=1, on_failure="open", timeout_s=20.0)
    assert merge_tool_rules(cur, ToolRule(on_failure="closed", timeout_s=45.0)) == ToolRule(on_failure="closed", timeout_s=20.0)
    assert merge_tool_rules(ToolRule(), ToolRule(timeout_s=5.0)).timeout_s == 5.0
    assert merge_tool_rules(ToolRule(), ToolRule()).on_failure is None


def test_merge_never_loosens_the_class_default_or_the_intent_check():
    """S2: unset means the class default (closed for money) and the bus timeout (30 s); a patch cannot get under them,
    and a union of intent words would make `requires_user_intent` easier to satisfy, so words only ever narrow."""
    from chaos.tool_rules import failure_mode
    from chaos.toolbus import PASSTHROUGH_TIMEOUT_S

    cur = ToolRule(requires_user_intent=True, intent_words=["refund"], requires_verified_lookup=True, max_calls=1)
    inc = ToolRule(intent_words=["hello"], on_failure="open", timeout_s=9999)
    m = merge_tool_rules(cur, inc)
    assert m == cur, "nothing in the patch is stricter than what is there"
    assert failure_mode("money", m) == "closed"
    # No rule yet: the patch is the rule, minus what would loosen the defaults.
    assert merge_tool_rules(None, inc) == ToolRule(intent_words=["hello"])
    assert merge_tool_rules(None, ToolRule(on_failure="closed", timeout_s=PASSTHROUGH_TIMEOUT_S - 1)) == ToolRule(on_failure="closed", timeout_s=PASSTHROUGH_TIMEOUT_S - 1)
    assert merge_tool_rules(ToolRule(), ToolRule(timeout_s=PASSTHROUGH_TIMEOUT_S)).timeout_s is None, "the default is not a tightening"
    # Intent words: intersection when both sides have them; the set side otherwise; the words in force when disjoint.
    assert merge_tool_rules(ToolRule(intent_words=["refund", "money back"]), ToolRule(intent_words=["money back", "reimburse"])).intent_words == ["money back"]
    assert merge_tool_rules(ToolRule(intent_words=["refund"]), ToolRule()).intent_words == ["refund"]
    assert merge_tool_rules(ToolRule(), ToolRule(intent_words=["refund"])).intent_words == ["refund"]
    assert merge_tool_rules(ToolRule(intent_words=["refund"]), ToolRule(intent_words=["hello"])).intent_words == ["refund"]
    # An explicit `open` a person put on the record is not undone by a patch that says nothing about it.
    assert merge_tool_rules(ToolRule(on_failure="open"), ToolRule(max_calls=1)).on_failure == "open"
    assert merge_tool_rules(ToolRule(on_failure="open"), ToolRule(on_failure="closed")).on_failure == "closed"
    # The whole thing through `apply_patch`, the way the loop and the onboarding apply both merge.
    cfg = AgentConfig(system_prompt="x", tool_policy=ToolPolicy(tool_rules={"issue_refund": cur}))
    patched = apply_patch(cfg, Patch(kind="tighten_tool_policy", rationale="r", tool_policy=ToolPolicy(tool_rules={"issue_refund": inc})))
    assert patched.tool_policy.tool_rules["issue_refund"] == cur


def test_failure_mode_by_class_and_override():
    from chaos.tool_rules import fails_closed, failure_mode

    assert failure_mode("money", None) == "closed" and failure_mode("mutate", None) == "closed"
    assert failure_mode("read", None) == "open" and failure_mode("message", None) == "open"
    assert failure_mode("unknown", None) == "closed", "a tool no word matched is an action until someone says otherwise"
    assert failure_mode("read", ToolRule(on_failure="closed")) == "closed"
    assert failure_mode("money", ToolRule(on_failure="open")) == "open"
    assert failure_mode("money", ToolRule(max_calls=1)) == "closed", "a rule without on_failure defers to the class"
    assert [fails_closed(c) for c in ("read", "money", "message", "mutate", "unknown")] == [False, True, False, True, True]
    with pytest.raises(ValueError):
        ToolRule(on_failure="maybe")
    with pytest.raises(ValueError):
        ToolRule(timeout_s=0)


def test_one_classifier_for_the_panel_the_repair_and_the_gateway():
    """S4: `tool_class` is the only way a tool gets a class. Pack first (by name or alias), then name, then description —
    the class the Tools panel shows is the class the gateway fails open or closed on. `send_money` is money by name
    (the word list knows `money`/`funds`; it used to read as `message` and fail open)."""
    from chaos.domains import load_domain
    from chaos.tool_rules import classes, tool_class

    airline = load_domain("airline")
    listed = [{"name": "send_money", "description": "Transfer funds to a payee"}, {"name": "zap", "description": "Look up an order by id"}, {"name": "get_trip_details"}, {"name": "frob"}]
    assert classes(listed, airline) == {"send_money": "money", "zap": "read", "get_trip_details": "read", "frob": "unknown"}
    assert tool_class(airline, "get_trip_details") == airline.tool_class("get_trip_details") == "read", "the pack's alias wins"
    assert tool_class(None, "send_money") == "money" and tool_class(None, "wire_funds") == "money"
    assert tool_class(None, "zap") == "unknown" and tool_class(None, "zap", "Look up an order by id") == "read", "the description speaks when the name says nothing"
    assert starter_rules(listed, airline)["send_money"] == ToolRule(requires_user_intent=True, requires_verified_lookup=True, max_calls=1)
    assert "zap" not in starter_rules(listed, airline), "a described read gets no rule, as the panel shows"


def test_apply_patch_keeps_existing_rules_and_merges_new_ones():
    cfg = AgentConfig(system_prompt="x", tool_policy=ToolPolicy(refund_requires_user_intent=True, tool_rules={"send_email": ToolRule(requires_verified_lookup=True)}))
    patch = Patch(kind="tighten_tool_policy", rationale="cap refunds", tool_policy=ToolPolicy(tool_rules={"issue_refund": ToolRule(max_calls=1)}))
    new = apply_patch(cfg, patch)
    # The reviewer's blocker: a patch with `tool_rules={}` used to wipe the applied rules via model_dump().
    assert new.tool_policy.tool_rules == {"send_email": ToolRule(requires_verified_lookup=True), "issue_refund": ToolRule(max_calls=1)}
    assert new.tool_policy.refund_requires_user_intent is True
    again = apply_patch(new, Patch(kind="tighten_tool_policy", rationale="flag only", tool_policy=ToolPolicy(email_only_to_order_owner=True)))
    assert again.tool_policy.tool_rules == new.tool_policy.tool_rules and again.tool_policy.email_only_to_order_owner is True


def test_rule_detail_reads_like_a_sentence():
    assert rule_detail(ToolRule(deny=True)) == "deny"
    assert rule_detail(ToolRule(requires_user_intent=True, requires_verified_lookup=True, max_calls=1)) == "needs intent, needs lookup, max 1 call"
    assert rule_detail(ToolRule(intent_words=["refund"], requires_user_intent=True)) == "needs intent (refund)"
    assert rule_detail(ToolRule(on_failure="open", timeout_s=5)) == "fails open, timeout 5s"
    assert rule_detail(ToolRule(max_calls=2, on_failure="closed", timeout_s=2.5)) == "max 2 calls, fails closed, timeout 2.5s"
