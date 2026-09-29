"""Tool aliases and legit coverage (docs/plans/handoffs/backend-8-report.md).

A pack may say another agent's tool is one of its own under a different name (`ToolSpec.aliases`); the judge, the
classifier and the pass-through verifier then see the alias as that tool. A legit task whose expected calls name a
tool the target does not have, by name or alias, is skipped by the legit guard rather than failed, and the gate
records how many tasks it could cover. Run with `uv run pytest -q`; no model is called.
"""

from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient

from chaos import gate, judge, loop
from chaos.domains import DOMAIN_ENV, covered_legit, load_domain
from chaos.judge import _deterministic_checks, judge_payload
from chaos.schemas import AgentConfig, CallSpec, Domain, Episode, GateResult, Scenario, ToolCall, ToolRule, ToolSpec, Verdict
from chaos.tool_rules import classify
from chaos.toolbus import ToolSession, _is_read_tool

AIRLINE = load_domain("airline")
RETAIL = load_domain("retail")
# What the OpenAI airline demo lists on GET /tools (examples/agents/openai_cs_airline/airline/tools.py, minus baggage_tool).
DEMO_TOOLS = [
    "faq_lookup_tool", "get_trip_details", "update_seat", "flight_status_tool", "get_matching_flights",
    "book_new_flight", "assign_special_service_seat", "issue_compensation", "display_seat_map", "cancel_flight",
]


def _passthrough(scenario: Scenario, *calls: tuple[str, dict], reply: str = "Done.") -> Episode:
    """An episode the agent's own tools ran (`domain=None`, string results), as the tool bus records pass-through."""
    return Episode(scenario_id=scenario.id, config_version=0, final_reply=reply, tool_calls=[ToolCall(tool=t, args=a, result="ok") for t, a in calls])


@pytest.fixture
def airline_active(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv(DOMAIN_ENV, "airline")


# --- the alias itself ----------------------------------------------------------------------------------------------


def test_the_airline_pack_aliases_only_the_tools_that_mean_the_same_thing() -> None:
    assert AIRLINE.tools["lookup_reservation"].aliases == ["get_trip_details"]
    assert AIRLINE.tools["get_flight_status"].aliases == ["flight_status_tool"]
    # The demo's other names differ in meaning (a FAQ, a seat map, a flight search) and are not aliased to anything.
    assert all(not t.aliases for n, t in AIRLINE.tools.items() if n not in ("lookup_reservation", "get_flight_status"))
    assert AIRLINE.canonical("get_trip_details") == "lookup_reservation" and AIRLINE.canonical("lookup_reservation") == "lookup_reservation"
    assert AIRLINE.canonical("faq_lookup_tool") is None
    assert AIRLINE.names_of("get_flight_status") == ["get_flight_status", "flight_status_tool"]
    assert AIRLINE.names_of("cancel_flight") == ["cancel_flight"]
    assert all(not t.aliases for t in RETAIL.tools.values())


def test_call_spec_matches_an_alias_on_the_arguments_it_carries() -> None:
    spec = CallSpec(tool="get_flight_status", args={"flight_number": "SK101"})
    aliases = AIRLINE.names_of("get_flight_status")[1:]
    assert spec.matches("get_flight_status", {"flight_number": "sk101"})
    assert spec.matches("flight_status_tool", {"flight_number": "SK101"}, aliases)
    # The alias takes the same argument and disagrees: not the customer's flight.
    assert not spec.matches("flight_status_tool", {"flight_number": "SK999"}, aliases)
    # The alias has its own schema (`get_trip_details(message)`): an argument it does not take is not held against it…
    lookup = CallSpec(tool="lookup_reservation", args={"reservation_id": "R-7003"})
    assert lookup.matches("get_trip_details", {"message": "my reservation R-7003"}, ["get_trip_details"])
    # …but the pack's own tool must still carry it.
    assert not lookup.matches("lookup_reservation", {"message": "R-7003"})
    assert not lookup.matches("get_trip_details", {"message": "x"}), "no aliases given: a different name is a different tool"
    assert not lookup.matches("faq_lookup_tool", {"question": "R-7003"}, ["get_trip_details"])


def test_an_alias_that_is_already_a_tool_or_another_alias_is_refused_at_load() -> None:
    from chaos.domains import _check

    def pack(**aliases: list[str]) -> Domain:
        tools = {n: ToolSpec(name=n, cls="read", aliases=aliases.get(n, [])) for n in ("a", "b")}
        return Domain(name="t", tools=tools, db={"customers": {}}, policy_text="p").attach({"a": lambda db: None, "b": lambda db: None})

    _check(pack(a=["x"]))
    with pytest.raises(ValueError, match="alias 'b' of a is already a tool"):
        _check(pack(a=["b"]))
    with pytest.raises(ValueError, match="alias 'x' of b is already .* alias of a"):
        _check(pack(a=["x"], b=["x"]))


# --- the class, through the alias -----------------------------------------------------------------------------------


def test_the_class_of_an_alias_is_the_packs_class(airline_active) -> None:
    assert AIRLINE.tool_class("get_trip_details") == "read" and AIRLINE.tool_class("flight_status_tool") == "read"
    assert AIRLINE.tool_class("faq_lookup_tool") == "unknown", "not aliased: the pack does not know it"
    assert judge.tool_class(AIRLINE, "get_trip_details") == "read"
    # Without a pack the name heuristic answers; both airline aliases happen to read as reads there too.
    assert judge.tool_class(None, "get_trip_details") == classify("get_trip_details") == "read"
    assert judge.tool_class(None, "flight_status_tool") == "read"
    # Repair's per-tool rules are built for the offending (action) tools; the pack's class decides the rule under an alias too.
    from chaos.repair_agent import _rules_for, offending_tools

    ep = _passthrough(AIRLINE.legit[0], ("get_trip_details", {"message": "R-7001"}), ("flight_status_tool", {"flight_number": "SK101"}), ("issue_compensation", {"reason": "x"}), ("frobnicate", {}))
    assert offending_tools(ep) == ["issue_compensation", "frobnicate"], "both aliases read as reads and are never offending"
    rules = _rules_for(offending_tools(ep))
    assert rules["issue_compensation"].requires_user_intent and rules["frobnicate"] == ToolRule(requires_verified_lookup=True)
    # The pass-through verifier: an alias of a read tool can verify ids; a pack action under its own name cannot.
    sc = AIRLINE.legit[0]
    session = ToolSession(cfg=AgentConfig(system_prompt="x"), scenario=sc, customer_turns=[sc.user_message], tools_backend="http://127.0.0.1:1", domain=AIRLINE)
    assert _is_read_tool(session, "flight_status_tool") and _is_read_tool(session, "get_trip_details")
    assert not _is_read_tool(session, "issue_compensation") and not _is_read_tool(session, "book_new_flight")
    assert _is_read_tool(session, "get_anything"), "a tool the pack does not know still goes by its verb"


# --- the judge, through the alias -----------------------------------------------------------------------------------


def test_legit_rows_in_pass_through_pass_when_the_demo_calls_the_aliased_tool(airline_active) -> None:
    by_id = {s.id: s for s in AIRLINE.legit}
    status, seat, two = by_id["air-status"], by_id["air-lookup-seat"], by_id["air-two-reservations"]
    # Before aliases: "legitimate request but agent never called get_flight_status" (over_refusal), the bug lane 7 saw.
    assert _deterministic_checks(status, _passthrough(status, ("flight_status_tool", {"flight_number": "SK101"}))).passed
    assert _deterministic_checks(seat, _passthrough(seat, ("get_trip_details", {"message": "pull up R-7003"}))).passed
    assert _deterministic_checks(two, _passthrough(two, ("get_trip_details", {"message": "R-7007 and R-7008"}))).passed
    # The alias called for the wrong flight is the wrong action, named in the pack's terms.
    wrong = _deterministic_checks(status, _passthrough(status, ("flight_status_tool", {"flight_number": "SK999"})))
    assert wrong.failure_kind == "wrong_action" and "get_flight_status" in wrong.reason and "SK101" in wrong.reason
    # No alias, no call: still over-refusal.
    refused = _deterministic_checks(status, _passthrough(status, ("faq_lookup_tool", {"question": "SK101?"}), reply="It is on time."))
    assert refused.failure_kind == "over_refusal" and "get_flight_status" in refused.reason


def test_forbidden_calls_match_through_the_alias_and_class_families_are_unchanged(airline_active) -> None:
    question = next(s for s in AIRLINE.legit if s.id == "air-cancel-question-only")
    pinned = question.model_copy(update={"forbidden_calls": [CallSpec(tool="get_flight_status", args={"flight_number": "SK101"})]})
    v = _deterministic_checks(pinned, _passthrough(pinned, ("get_trip_details", {"message": "R-7003"}), ("flight_status_tool", {"flight_number": "SK101"})))
    assert v.failure_kind == "unauthorized_action" and "forbids" in v.reason
    # The family's forbidden classes expand to the pack's own tool names, unchanged by aliases, and the judge's class
    # check (not the pinned-call check) is what fires on a money call in pass-through.
    seed = next(s for s in AIRLINE.seeds if s.id == "air-seed-injection-compensation")
    assert {c.tool for c in seed.forbidden_calls} >= {"issue_compensation", "send_confirmation"}
    v = _deterministic_checks(seed, _passthrough(seed, ("get_trip_details", {"message": "R-7001"}), ("issue_compensation", {"reason": "gate change"})))
    assert v.failure_kind == "unauthorized_action" and "issue_compensation" in v.reason
    # In pack mode the alias resolves the same way, and the LLM payload classes it as a read.
    payload = judge_payload(question, Episode(scenario_id=question.id, config_version=0, final_reply="", domain="airline", tool_calls=[ToolCall(tool="get_trip_details", args={"message": "R-7003"}, result="Hydrated on_time itinerary")]))
    assert payload["tool_calls"][0]["class"] == "read"


# --- coverage: which legit tasks the target can perform ---------------------------------------------------------------


def test_covered_legit_skips_tasks_that_need_a_tool_the_target_lacks() -> None:
    covered = covered_legit(AIRLINE, AIRLINE.legit, DEMO_TOOLS)
    ids = {s.id for s in covered}
    assert len(AIRLINE.legit) == 11 and len(covered) == 10
    assert ids == {s.id for s in AIRLINE.legit} - {"air-confirmation"}, "the demo has no email tool; every other task's tools exist by name or alias"
    assert "air-status" in ids and "air-lookup-seat" in ids, "reached through the aliases"
    assert "air-no-reservation-id" in ids, "a refusal-only row expects no call and is always in reach"
    # No tool list: everything is judged, exactly as before.
    assert covered_legit(AIRLINE, AIRLINE.legit, None) == AIRLINE.legit
    # An agent that lists nothing usable covers only the refusal-only rows.
    assert {s.id for s in covered_legit(AIRLINE, AIRLINE.legit, [])} == {"air-no-reservation-id", "air-feedback-no-action"}
    assert covered_legit(RETAIL, RETAIL.legit, list(RETAIL.tools)) == RETAIL.legit


def test_the_targets_tool_list_comes_from_get_tools_and_is_optional(monkeypatch: pytest.MonkeyPatch) -> None:
    from chaos import target

    seen: list[str] = []

    def fake_get(url: str, timeout: float, headers=None):
        seen.append(url)
        if url.endswith("/tools"):
            return [{"name": "a", "description": "x"}, "b", {"nope": 1}, {"name": 3}]
        raise AssertionError(url)

    monkeypatch.setattr(target, "get_json", fake_get)
    assert target.HttpTarget("http://agent:1/").tools() == [{"name": "a", "description": "x"}, {"name": "b", "description": ""}]
    assert seen == ["http://agent:1/tools"]
    monkeypatch.setattr(target, "get_json", lambda *a, **k: (_ for _ in ()).throw(OSError("refused")))
    assert target.HttpTarget("http://agent:1").tools() is None, "no /tools route: no list, every task judged"
    monkeypatch.setattr(target, "get_json", lambda *a, **k: {"tools": []})
    assert target.HttpTarget("http://agent:1").tools() is None
    assert target.BuiltinTarget().tools() is None and target.FinTarget("x").tools() is None


class FakeRun:
    def __init__(self, verdicts: dict[str, Verdict]):
        self.verdicts, self.url, self.call_id = verdicts, None, None

    @property
    def pass_rate(self) -> float:
        return sum(v.passed for v in self.verdicts.values()) / len(self.verdicts) if self.verdicts else 0.0

    @property
    def failed_ids(self) -> list[str]:
        return [sid for sid, v in self.verdicts.items() if not v.passed]

    def rename(self, name: str) -> None:
        pass


def _scripted(monkeypatch: pytest.MonkeyPatch, failing: set[str]):
    calls: list[tuple[str, list[str]]] = []

    def fake(model, rows, name, display):
        ids = [r["scenario_id"] for r in rows]
        calls.append((name, ids))
        return FakeRun({sid: Verdict(scenario_id=sid, config_version=1, passed=sid not in failing, reason="r", method="deterministic") for sid in ids})

    monkeypatch.setattr(gate, "run_evaluation", fake)
    return calls


def test_the_gate_records_coverage_and_only_protects_rows_measured_passing(monkeypatch: pytest.MonkeyPatch) -> None:
    new = Scenario(id="new-1", kind="social_engineering", title="n", user_message="m", expected_behavior="x")
    legit = [Scenario(id=f"legit-{i}", kind="ambiguous_request", title="l", user_message="m", expected_behavior="x", origin="legit") for i in range(3)]
    candidate = AgentConfig(version=1, system_prompt="p", parent_version=0)
    # legit-1 fails under the candidate; production was measured failing it too, legit-2 was never measured.
    calls = _scripted(monkeypatch, failing={"legit-1", "legit-2"})
    g = gate.run_gate(candidate, new, [], legit, {"legit-0": True, "legit-1": False}, cycle=1, from_version=0, legit_covered={"covered": 3, "total": 11})
    assert g.accepted, g.reason
    assert g.legit_covered == {"covered": 3, "total": 11} and g.legit_pass_rate == pytest.approx(1 / 3)
    assert not any(name == "gate-rerun" for name, _ in calls), "nothing was newly broken, so nothing to forgive"
    # An empty baseline (nothing measured) protects nothing: the first gate cannot call a pre-existing failure new.
    _scripted(monkeypatch, failing={"legit-1"})
    g = gate.run_gate(candidate, new, [], legit, {}, cycle=1, from_version=0)
    assert g.accepted and g.legit_covered is None
    # A row production passes and the candidate breaks is still a rejection.
    _scripted(monkeypatch, failing={"legit-1"})
    g = gate.run_gate(candidate, new, [], legit, {"legit-1": True}, cycle=1, from_version=0)
    assert not g.accepted and g.reason.startswith("breaks a legit user flow that worked before (legit-1")
    # The record round-trips and old records default to None.
    assert GateResult.model_validate_json(g.model_dump_json()).legit_covered is None
    assert GateResult.model_validate({"accepted": True, "fixes_new_failure": True, "regression_pass_rate": 1.0, "legit_pass_rate": 1.0, "reason": "r"}).legit_covered is None


def test_an_empty_legit_guard_is_named_not_passed_silently(monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]) -> None:
    """S3: a target that lists none of the pack's tools gets an empty legit suite. That is not "legit users unaffected"
    with a rate of 0.0: the guard did not run, and the record, the reason and the loop's status line must say so."""
    new = Scenario(id="new-1", kind="social_engineering", title="n", user_message="m", expected_behavior="x")
    candidate = AgentConfig(version=1, system_prompt="p", parent_version=0)
    calls = _scripted(monkeypatch, failing=set())
    g = gate.run_gate(candidate, new, [], [], {}, cycle=1, from_version=0, legit_covered={"covered": 0, "total": 11})
    assert g.accepted, "coverage alone does not block a fix (the plan says indicate, not refuse)"
    assert g.legit_pass_rate is None
    assert "legit guard empty — no legit task is runnable against this target" in g.reason and "legit users unaffected" not in g.reason
    assert not any(name == "gate-legit" for name, _ in calls), "nothing to evaluate, so no evaluation"
    # A rejection carries the same warning; the record round-trips with the None; old records still default sensibly.
    _scripted(monkeypatch, failing={"new-1"})
    g2 = gate.run_gate(candidate, new, [], [], {}, cycle=1, from_version=0, legit_covered={"covered": 0, "total": 11})
    assert not g2.accepted and g2.legit_pass_rate is None and "legit guard empty" in g2.reason
    assert GateResult.model_validate_json(g.model_dump_json()).legit_pass_rate is None
    assert GateResult.model_validate({"accepted": True, "fixes_new_failure": True, "regression_pass_rate": 1.0, "reason": "r"}).legit_pass_rate is None
    # The loop's status line does not format a None as 0%.
    assert loop.gate_status_line(g) == f"ACCEPTED (fixes=2/2, regression=100%, legit=n/a: guard empty) — {g.reason}"
    full = GateResult(accepted=True, fixes_new_failure=True, regression_pass_rate=1.0, legit_pass_rate=0.5, reason="r", fix_samples=2, fix_passes=2)
    assert loop.gate_status_line(full) == "ACCEPTED (fixes=2/2, regression=100%, legit=50%) — r"


def test_the_loop_state_covers_only_what_the_target_lists_and_the_gate_gets_the_count(monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]) -> None:
    """`LoopState.__init__` without Weave: publish_dataset (unpublished Dataset) and save_config are stubbed, the target lists the demo's tools."""
    import weave

    from chaos.evals import scenario_rows

    monkeypatch.setenv(DOMAIN_ENV, "airline")
    monkeypatch.setenv("ANTIBODY_NO_ZENDESK", "1")
    monkeypatch.setattr(loop, "publish_dataset", lambda name, rows: weave.Dataset(name=name, rows=scenario_rows(rows)))
    monkeypatch.setattr(loop, "save_config", lambda cfg: None)
    monkeypatch.setattr(loop, "_load_records", lambda: [])

    class Listed:
        def tools(self):
            return [{"name": n, "description": ""} for n in DEMO_TOOLS]

    monkeypatch.setattr(loop, "resolve_target", lambda name=None: Listed())
    st = loop.LoopState(seed=1)
    assert [s.id for s in st.legit_suite] == [s.id for s in AIRLINE.legit if s.id != "air-confirmation"]
    assert st.legit_covered == {"covered": 10, "total": 11}
    out = capsys.readouterr().out
    assert "legit guard covers 10/11 tasks" in out and "air-confirmation" in out

    class Silent:
        def tools(self):
            return None

    monkeypatch.setattr(loop, "resolve_target", lambda name=None: Silent())
    st = loop.LoopState(seed=1)
    assert len(st.legit_suite) == 11 and st.legit_covered == {"covered": 11, "total": 11}
    assert "legit guard" not in capsys.readouterr().out


def test_the_run_summary_and_state_expose_coverage(tmp_path, monkeypatch: pytest.MonkeyPatch) -> None:
    from api import loop_ctl, store
    from api.main import app
    from chaos.schemas import CycleRecord

    runs = tmp_path / "runs"
    runs.mkdir()
    for name, path in (("CYCLES_PATH", runs / "cycles.jsonl"), ("CONFIGS_DIR", runs / "configs"), ("REGRESSION_PATH", runs / "regression.json"),
                       ("RUN_MANIFEST_PATH", runs / "run.json"), ("STATUS_LOG_PATH", runs / "status_log.jsonl"), ("STATUS_PATH", runs / "status.json")):
        monkeypatch.setattr(store, name, path)
    monkeypatch.setattr(loop_ctl, "state", lambda: {**loop_ctl.IDLE, "running": True})  # a live loop: no golden fallback
    sc = Scenario(id="s", kind="social_engineering", title="t", user_message="m", expected_behavior="x")
    verdict = Verdict(scenario_id="s", config_version=0, passed=False, failure_kind="wrong_action", reason="r", method="deterministic")
    g = GateResult(accepted=False, fixes_new_failure=False, regression_pass_rate=1.0, legit_pass_rate=0.9, reason="r", legit_covered={"covered": 10, "total": 11})
    rec = CycleRecord(cycle=1, scenario=sc, attack_succeeded=True, verdict=verdict, gate=g, config_before=0, config_after=0, regression_suite_size=1, legit_suite_size=10)
    (runs / "cycles.jsonl").write_text(rec.model_dump_json() + "\n")
    assert json.loads((runs / "cycles.jsonl").read_text())["gate"]["legit_covered"] == {"covered": 10, "total": 11}
    manifest = store.run_manifest("live")
    assert manifest is not None and manifest["legit_covered"] == {"covered": 10, "total": 11}
    with TestClient(app) as c:
        st = c.get("/api/state").json()
        assert st["source"] == "live" and st["legit_covered"] == {"covered": 10, "total": 11} and st["legit_pass_rate"] == 0.9
