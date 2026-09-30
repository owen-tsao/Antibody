"""Plan 11 §4: what the loop hands Weave and reads back, exercised with a fake client so nothing leaves the machine.

`weave.get_client()` is None in the keyless suite; every optional Weave call must be a no-op then, and every call
that does run must fail soft. Run with `uv run pytest -q`.
"""

from __future__ import annotations

import threading
import time
from types import SimpleNamespace

import pytest

from chaos import config, loop


class FakeClient:
    """Only what `register_costs` and `_weave_cost` touch."""

    def __init__(self, costs: dict | None = None, existing: list | None = None, fail: str | None = None):
        self.costs = costs
        self.existing = existing or []
        self.fail = fail
        self.added: list[tuple] = []
        self.flushed = 0
        self.fetched: list[tuple] = []

    def query_costs(self, llm_ids=None):
        if self.fail == "query":
            raise ConnectionError("down")
        return [SimpleNamespace(llm_id=llm, prompt_token_cost=p, completion_token_cost=c) for llm, p, c in self.existing]

    def add_cost(self, llm_id, prompt_token_cost, completion_token_cost):
        if self.fail == "add":
            raise ConnectionError("down")
        self.added.append((llm_id, prompt_token_cost, completion_token_cost))

    def flush(self):
        self.flushed += 1

    def get_call(self, call_id, include_costs=False, **_):
        if self.fail == "get":
            raise TimeoutError("slow")
        self.fetched.append((call_id, include_costs))
        return SimpleNamespace(summary={"weave": {"costs": self.costs}} if self.costs is not None else {})


@pytest.fixture
def fake(monkeypatch: pytest.MonkeyPatch):
    def install(**kw) -> FakeClient:
        client = FakeClient(**kw)
        monkeypatch.setattr(loop.weave, "get_client", lambda: client)
        return client

    return install


# --- §4.1 cost ---------------------------------------------------------------------------------------------------


def test_register_costs_hands_weave_the_table_per_token_and_only_what_is_missing(fake) -> None:
    llama = "meta-llama/Llama-3.1-8B-Instruct"
    client = fake(existing=[(llama, 0.22 / 1e6, 0.22 / 1e6), ("openai/gpt-oss-20b", 0.05 / 1e6, 999.0)])
    loop.register_costs()
    added = {llm: (p, c) for llm, p, c in client.added}
    assert llama not in added, "already registered at the same price"
    assert added["openai/gpt-oss-20b"] == tuple(x / 1e6 for x in config.PRICE_PER_MILLION_USD["openai/gpt-oss-20b"]), "a stale price is re-registered"
    assert set(added) == set(config.PRICE_PER_MILLION_USD) - {llama}
    for llm, (p, c) in added.items():
        assert (p, c) == (config.PRICE_PER_MILLION_USD[llm][0] / 1e6, config.PRICE_PER_MILLION_USD[llm][1] / 1e6)
        assert p < 1e-5 and c < 1e-5, "per token, not per million"


def test_register_costs_is_a_no_op_without_a_client_and_fails_soft(fake, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]) -> None:
    monkeypatch.setattr(loop.weave, "get_client", lambda: None)
    loop.register_costs()
    for where in ("query", "add"):
        client = fake(fail=where)
        loop.register_costs()
        assert client.added == []
    assert capsys.readouterr().out.count("could not register model prices") == 2


def test_weave_costs_total_sums_every_model_and_every_cost_kind() -> None:
    summary = {
        "usage": {"x": {}},
        "weave": {
            "costs": {
                "openai/gpt-oss-120b": {"prompt_tokens_total_cost": 0.001, "completion_tokens_total_cost": 0.002, "prompt_tokens": 100},
                "meta-llama/Llama-3.1-8B-Instruct": {"prompt_tokens_total_cost": 0.0005, "cache_read_input_tokens_total_cost": 0.0001, "requests": 3},
                "junk": "not a row",
            }
        },
    }
    assert loop.weave_costs_total(summary) == pytest.approx(0.0036)
    assert loop.weave_costs_total({"weave": {"costs": {}}}) is None
    assert loop.weave_costs_total({"weave": {}}) is None and loop.weave_costs_total(None) is None
    assert loop.weave_costs_total({"weave": {"costs": {"m": {"prompt_tokens_total_cost": True}}}}) is None, "a boolean is not a price"


def test_weave_cost_reads_the_finished_call_back_after_a_flush(fake) -> None:
    client = fake(costs={"openai/gpt-oss-120b": {"prompt_tokens_total_cost": 0.01, "completion_tokens_total_cost": 0.02}})
    assert loop._weave_cost(SimpleNamespace(id="call-1")) == pytest.approx(0.03)
    assert client.flushed == 1 and client.fetched == [("call-1", True)]


def test_weave_cost_is_none_without_a_client_a_call_id_or_a_reachable_server(fake, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]) -> None:
    monkeypatch.setattr(loop.weave, "get_client", lambda: None)
    assert loop._weave_cost(SimpleNamespace(id="call-1")) is None
    client = fake(costs={"m": {"prompt_tokens_total_cost": 1.0}})
    assert loop._weave_cost(SimpleNamespace(id=None)) is None and client.fetched == [], "a NoOpCall has no id and is not looked up"
    fake(fail="get")
    assert loop._weave_cost(SimpleNamespace(id="call-1")) is None
    assert "could not read the cycle's cost" in capsys.readouterr().out
    fake(costs=None)
    assert loop._weave_cost(SimpleNamespace(id="call-1")) is None, "a call without cost rows keeps the estimate"


def _blocked_cycle_state(monkeypatch: pytest.MonkeyPatch, tmp_path) -> loop.LoopState:
    """A LoopState without its constructor, with a target that answers and a judge that passes: a blocked attack."""
    from chaos.domains import load_domain
    from chaos.schemas import Episode, Verdict
    from chaos.target_agent import V0_CONFIG

    monkeypatch.setenv("ANTIBODY_NO_ZENDESK", "1")
    monkeypatch.setattr(loop, "CYCLES_PATH", tmp_path / "cycles.jsonl")
    monkeypatch.setattr(loop, "set_phase", lambda *a, **kw: None)
    monkeypatch.setattr(loop, "run_target_agent", lambda cfg, sc: Episode(scenario_id=sc.id, config_version=cfg.version, final_reply="ok"))
    monkeypatch.setattr(loop, "judge_episode", lambda sc, ep: Verdict(scenario_id=sc.id, config_version=ep.config_version, passed=True, reason="fine", method="deterministic"))
    st = loop.LoopState.__new__(loop.LoopState)
    st.cfg = V0_CONFIG
    st.regression_suite = []
    st.legit_suite = list(load_domain("retail").legit)
    st.cycle = 0
    st.records = []
    st.baseline = {}
    return st


def test_run_cycle_prices_the_record_from_weave_when_it_can_and_labels_the_estimate_otherwise(fake, monkeypatch: pytest.MonkeyPatch, tmp_path) -> None:
    from chaos.domains import load_domain
    from chaos.schemas import CycleRecord

    st = _blocked_cycle_state(monkeypatch, tmp_path)
    seed = load_domain("retail").seeds[0]
    # No client (the keyless default): the local estimate, and no model call happened, so no bill at all.
    monkeypatch.setattr(loop.weave, "get_client", lambda: None)
    rec = loop.run_cycle(st, seed)
    assert rec.cost_usd is None and rec.cost_source is None
    # A local estimate with a client that cannot price the call: labelled estimated.
    monkeypatch.setattr(loop, "_cycle_cost", lambda started, usage_before: {"latency_ms": 1, "tokens": None, "cost_usd": 0.5})
    fake(costs=None)
    rec = loop.run_cycle(st, seed)
    assert (rec.cost_usd, rec.cost_source) == (0.5, "estimated")
    # Weave priced it: its number wins and the record says so; the call id is what was looked up.
    monkeypatch.setattr(loop._cycle, "call", lambda *a, **kw: (loop._cycle(*a, **{k: v for k, v in kw.items() if not k.startswith("__")}), SimpleNamespace(id="c-9")))
    client = fake(costs={"openai/gpt-oss-120b": {"prompt_tokens_total_cost": 0.1, "completion_tokens_total_cost": 0.2}})
    rec = loop.run_cycle(st, seed)
    assert (rec.cost_usd, rec.cost_source) == (pytest.approx(0.3), "weave") and client.fetched == [("c-9", True)]
    written = [CycleRecord.model_validate_json(line) for line in (tmp_path / "cycles.jsonl").read_text().splitlines()]
    assert [(r.cycle, r.cost_source) for r in written] == [(1, None), (2, "estimated"), (3, "weave")]
    assert [r.cycle for r in st.records] == [1, 2, 3]


def test_run_manifest_labels_the_runs_cost_source(tmp_path, monkeypatch: pytest.MonkeyPatch) -> None:
    from api import store
    from chaos.state import GOLDEN_DIR

    runs = tmp_path / "runs"
    runs.mkdir()
    monkeypatch.setattr(store, "CYCLES_PATH", runs / "cycles.jsonl")
    monkeypatch.setattr(store, "CONFIGS_DIR", runs / "configs")
    monkeypatch.setattr(store, "RUN_MANIFEST_PATH", runs / "run.json")
    monkeypatch.setattr(store, "STATUS_LOG_PATH", runs / "status_log.jsonl")
    rows = [line for line in (GOLDEN_DIR / "cycles.jsonl").read_text().splitlines() if line.strip()]

    def write(sources: list[str | None]) -> None:
        import json

        out = []
        for line, source in zip(rows, sources):
            doc = json.loads(line)
            doc["cost_usd"] = 0.01 if source else None
            doc["cost_source"] = source
            out.append(json.dumps(doc))
        (runs / "cycles.jsonl").write_text("\n".join(out) + "\n")

    write([None] * len(rows))
    assert "cost_source" not in store.run_manifest("live"), "no priced cycle: the key is absent, as the UI's type says"
    write(["weave"] * len(rows))
    assert store.run_manifest("live")["cost_source"] == "weave"
    write(["weave"] * (len(rows) - 1) + ["estimated"])
    assert store.run_manifest("live")["cost_source"] == "estimated", "one estimate makes the sum an estimate"
    write(["weave"] * (len(rows) - 1) + [None])
    assert store.run_manifest("live")["cost_source"] == "weave", "an unpriced cycle does not dilute the label"


# --- §4.2 threads ------------------------------------------------------------------------------------------------


def _thread_id() -> str | None:
    from weave.trace.context import call_context

    return call_context.get_thread_id()


def test_an_episode_runs_inside_a_weave_thread_named_by_its_session(monkeypatch: pytest.MonkeyPatch) -> None:
    from chaos import target, target_agent
    from chaos.domains import load_domain
    from chaos.schemas import Episode
    from chaos.target_agent import V0_CONFIG

    seen: dict = {}

    class Recorder:
        name, transport = "recorder", "test"

        def run_episode(self, session, opening):
            seen["thread"] = _thread_id()
            seen["session_id"] = session.session_id
            return Episode(scenario_id=session.scenario.id, config_version=session.cfg.version, final_reply="ok")

    monkeypatch.setenv("ANTIBODY_NO_ZENDESK", "1")
    monkeypatch.setattr(target_agent, "resolve_target", lambda name=None: Recorder())
    target_agent.run_target_agent(V0_CONFIG, load_domain("retail").seeds[0])
    assert seen["thread"] and seen["thread"] == seen["session_id"], "the session id is the thread id"
    assert _thread_id() is None, "the thread ends with the episode"

    # A session that already has an id (the gateway's, a standalone tool server's) keeps it as its thread.
    from chaos.toolbus import ToolSession

    s = ToolSession(cfg=V0_CONFIG, scenario=load_domain("retail").seeds[0], customer_turns=[], session_id="conv-42")
    with target.episode_thread(s):
        assert _thread_id() == "conv-42" and s.session_id == "conv-42"


def test_the_tool_server_keeps_the_episodes_session_id_so_tool_calls_join_its_thread() -> None:
    from chaos import toolserver
    from chaos.domains import load_domain
    from chaos.target_agent import V0_CONFIG
    from chaos.toolbus import ToolSession

    scenario = load_domain("retail").seeds[0]
    minted = ToolSession(cfg=V0_CONFIG, scenario=scenario, customer_turns=[], session_id="episode-thread-1")
    assert toolserver.register(minted) == "episode-thread-1"
    fresh = ToolSession(cfg=V0_CONFIG, scenario=scenario, customer_turns=[])
    sid = toolserver.register(fresh)
    assert sid and fresh.session_id == sid
    toolserver.drop("episode-thread-1")
    toolserver.drop(sid)


def test_tool_calls_are_threaded_only_when_this_process_traces(monkeypatch: pytest.MonkeyPatch) -> None:
    from chaos import toolserver

    seen: list = []

    def fake_call_tool(session, name, args):
        seen.append((name, _thread_id()))
        return "call"

    monkeypatch.setattr(toolserver, "call_tool", fake_call_tool)
    # No client (the gateway without ANTIBODY_GATEWAY_WEAVE, the keyless suite): no thread is entered.
    monkeypatch.setattr(toolserver.weave, "get_client", lambda: None)
    assert toolserver.traced_call_tool(object(), "lookup_order", {}, "sess-1") == "call"
    # A client, but the agent sent no session header: nothing to group by.
    monkeypatch.setattr(toolserver.weave, "get_client", lambda: object())
    toolserver.traced_call_tool(object(), "lookup_order", {}, None)
    # A client and a header: the call runs inside that thread, and the context is gone afterwards.
    toolserver.traced_call_tool(object(), "issue_refund", {"order_id": "o1"}, "sess-1")
    assert seen == [("lookup_order", None), ("lookup_order", None), ("issue_refund", "sess-1")]
    assert _thread_id() is None


# --- §4.3 leaderboard over the shared legit evaluation ---------------------------------------------------------


def test_the_legit_evaluation_is_one_object_reused_by_baseline_and_gate(monkeypatch: pytest.MonkeyPatch) -> None:
    from chaos import evals, gate
    from chaos.domains import load_domain

    legit = load_domain("retail").legit[:2]
    dataset = weave_dataset(legit)
    monkeypatch.setattr(evals.weave, "get_client", lambda: None)
    built: list = []
    real_evaluation = evals.weave.Evaluation

    class Spy(real_evaluation):
        def __init__(self, **kw):
            built.append(kw.get("evaluation_name"))
            super().__init__(**kw)

    monkeypatch.setattr(evals.weave, "Evaluation", Spy)
    evaluation, ref = evals.legit_evaluation(dataset)
    assert isinstance(evaluation, real_evaluation) and ref is None, "no client: an evaluation, no ref, no publish"
    assert evaluation.evaluation_name == evals.LEGIT_EVALUATION_NAME

    # `run_evaluation` runs a given Evaluation as is (rows come from its dataset) instead of building a new one.
    seen_rows: list = []

    async def fake_evaluate(_eval_self, model, __weave=None):
        seen_rows.append([r["scenario_id"] for r in _eval_self.dataset.rows])
        return {}, SimpleNamespace(id=None, ui_url=None)

    monkeypatch.setattr(real_evaluation.evaluate, "call", fake_evaluate)
    from chaos.evals import TargetAgent, scenario_rows
    from chaos.target_agent import V0_CONFIG

    model = TargetAgent(config=V0_CONFIG)
    evals.run_evaluation(model, evaluation, "gate-legit", "d1")
    evals.run_evaluation(model, scenario_rows(legit[:1]), "gate-new", "d2")
    assert built == [evals.LEGIT_EVALUATION_NAME, "gate-new"], "the shared object was built once and not rebuilt; the plain-rows call was"
    assert seen_rows == [[s.id for s in legit], [legit[0].id]]

    # The gate hands the shared object to its legit leg when it has one, and the dataset/rows otherwise.
    passed: list = []

    def fake_run_evaluation(model, rows, name, display):
        passed.append((name, rows if isinstance(rows, real_evaluation) else "rows"))
        ids = [r["scenario_id"] for r in (rows.dataset.rows if isinstance(rows, real_evaluation) else rows)]
        from chaos.schemas import Verdict

        return SimpleNamespace(verdicts={sid: Verdict(scenario_id=sid, config_version=1, passed=True, reason="ok", method="deterministic") for sid in ids}, pass_rate=1.0, failed_ids=[], url=None, call_id=None, rename=lambda *_: None)

    monkeypatch.setattr(gate, "run_evaluation", fake_run_evaluation)
    seeds = load_domain("retail").seeds
    cand = V0_CONFIG.model_copy(update={"version": 1})
    gate.run_gate(cand, seeds[0], [], legit, {s.id: True for s in legit}, cycle=1, from_version=0, legit_dataset=dataset, legit_evaluation=evaluation)
    gate.run_gate(cand, seeds[0], [], legit, {s.id: True for s in legit}, cycle=2, from_version=0, legit_dataset=dataset)
    legit_legs = [rows for name, rows in passed if name == "gate-legit"]
    assert legit_legs[0] is evaluation and legit_legs[1] == "rows"


def weave_dataset(scenarios):
    from chaos.evals import scenario_rows
    import weave

    return weave.Dataset(name="legit-users", rows=scenario_rows(scenarios))


def test_publish_leaderboard_is_one_column_over_the_legit_ref_and_fails_soft(monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]) -> None:
    from chaos import evals

    monkeypatch.setattr(evals.weave, "get_client", lambda: None)
    assert evals.publish_leaderboard("b", "weave:///e/p/object/legit-users:abc", "d") is None

    monkeypatch.setattr(evals.weave, "get_client", lambda: object())
    published: list = []

    def fake_publish(obj, name=None, **_):
        published.append((obj, name))
        return SimpleNamespace(entity="owentsao23-clad-labs", project="chaos-monkey", name=name)

    monkeypatch.setattr(evals.weave, "publish", fake_publish)
    url = evals.publish_leaderboard("antibody-retail-legit-x", "weave:///e/p/object/legit-users:abc", "desc")
    assert url == "https://wandb.ai/owentsao23-clad-labs/chaos-monkey/weave/leaderboards/antibody-retail-legit-x"
    board, name = published[0]
    assert name == "antibody-retail-legit-x" and board.description == "desc"
    assert [c.model_dump() for c in board.columns] == [
        {"evaluation_object_ref": "weave:///e/p/object/legit-users:abc", "scorer_name": "judge_scorer", "summary_metric_path": "passed.true_fraction", "should_minimize": None}
    ]

    def boom(*a, **k):
        raise ConnectionError("down")

    monkeypatch.setattr(evals.weave, "publish", boom)
    assert evals.publish_leaderboard("b", "ref", "d") is None
    assert "could not publish the leaderboard" in capsys.readouterr().out


def test_the_loop_writes_the_leaderboard_url_into_run_json_and_the_manifest_exposes_it(tmp_path, monkeypatch: pytest.MonkeyPatch) -> None:
    import json

    from api import store
    from chaos import state
    from chaos.domains import load_domain

    runs = tmp_path / "runs"
    runs.mkdir()
    monkeypatch.setattr(state, "RUNS_DIR", runs)
    monkeypatch.setattr(state, "RUN_MANIFEST_PATH", runs / "run.json")
    monkeypatch.setattr(store, "RUN_MANIFEST_PATH", runs / "run.json")
    monkeypatch.setattr(store, "CYCLES_PATH", runs / "cycles.jsonl")
    monkeypatch.setattr(store, "CONFIGS_DIR", runs / "configs")
    monkeypatch.setattr(store, "STATUS_LOG_PATH", runs / "status_log.jsonl")

    # No manifest yet: amending is a no-op rather than a fabricated run.json.
    state.amend_run_manifest(weave_leaderboard_url="https://x")
    assert not (runs / "run.json").exists()
    state.write_run_manifest(world="mock", target="builtin", flags=[], domain="retail", seed=7)
    assert store.run_manifest("live")["weave_leaderboard_url"] is None

    st = loop.LoopState.__new__(loop.LoopState)
    st.domain = load_domain("retail")
    st.legit_evaluation_ref = None
    loop._publish_leaderboard(st)
    assert "weave_leaderboard_url" not in json.loads((runs / "run.json").read_text()), "no ref (no client): nothing published"

    st.legit_evaluation_ref = "weave:///e/p/object/legit-users:abc"
    monkeypatch.setattr(loop, "publish_leaderboard", lambda name, evaluation_ref, description: f"https://wandb.ai/e/p/weave/leaderboards/{name}")
    loop._publish_leaderboard(st)
    doc = json.loads((runs / "run.json").read_text())
    assert doc["weave_leaderboard_url"].startswith("https://wandb.ai/e/p/weave/leaderboards/antibody-retail-legit-") and doc["seed"] == 7
    assert store.run_manifest("live")["weave_leaderboard_url"] == doc["weave_leaderboard_url"]
    (runs / "run.json").write_text(json.dumps({**doc, "weave_leaderboard_url": "javascript:alert(1)"}))
    assert store.run_manifest("live")["weave_leaderboard_url"] is None, "only an https link is handed to the UI"


# --- §4.4 gateway, opt-in and leak-guarded ------------------------------------------------------------------------


def _gateway_secrets(monkeypatch: pytest.MonkeyPatch) -> dict[str, str]:
    """Every value a header or the environment carries into the gateway, each one distinctive enough to grep for."""
    secrets = {"gateway_token": "gw-tok-3f9a1c", "backend_auth": "Bearer backend-sec-77bd", "customer": "alice-tenant-9e2@example.com"}
    monkeypatch.setenv("ANTIBODY_GATEWAY_TOKEN", secrets["gateway_token"])
    monkeypatch.setenv("ANTIBODY_BACKEND_AUTH", secrets["backend_auth"])
    return secrets


def test_gateway_trace_never_carries_secrets(monkeypatch: pytest.MonkeyPatch, tmp_path) -> None:
    """The review's exact guard (review-plan-11 H2): with a fake bearer in the env, a customer header and a
    credential-looking tool argument, the op's captured inputs contain none of them; the backend still gets the
    argument (redaction is for the trace only) and the trace joins the session's thread."""
    import json

    from conftest import FakeToolBackend
    from fastapi.testclient import TestClient

    from chaos import gateway
    from chaos.schemas import AgentConfig, ToolPolicy, ToolRule

    secrets = _gateway_secrets(monkeypatch)
    seen: list[dict] = []
    scored: list = []

    class Spy:
        def call(self, **kw):
            seen.append({**kw, "_thread": _thread_id()})
            return None, SimpleNamespace(id="traced-1")

    monkeypatch.setattr(gateway, "tracing", lambda: True)
    monkeypatch.setattr(gateway, "_traced_tool_call", Spy())
    monkeypatch.setattr(gateway, "_score_call", lambda traced, scorer: scored.append((traced, scorer)))
    rules = ToolPolicy(tool_rules={"issue_refund": ToolRule(requires_user_intent=True, max_calls=1), "frobnicate": ToolRule(deny=True)})
    b = FakeToolBackend({"lookup_order": {"status": "shipped"}, "issue_refund": {"ok": True}})
    try:
        gw = gateway.Gateway(b.url, AgentConfig(version=3, system_prompt="x", tool_policy=rules), enforce=False, log=tmp_path / "g.jsonl")
        c = TestClient(gw.app)
        headers = {"Authorization": f"Bearer {secrets['gateway_token']}", gateway.SESSION_HEADER: "conv-7", gateway.CUSTOMER_HEADER: secrets["customer"]}
        assert c.post("/sessions/conv-7/turn", json={"text": "refund please, my password is hunter2"}, headers=headers).status_code == 200
        r = c.post("/tools/issue_refund", json={"order_id": "Z-9", "api_token": "cust-tok-51ce", "note": "x" * 900}, headers=headers)
        assert r.status_code == 200 and r.json() == {"ok": True}
        assert b.received == [("issue_refund", {"order_id": "Z-9", "api_token": "cust-tok-51ce", "note": "x" * 900})], "the real tool gets the real arguments"
        assert secrets["backend_auth"] in b.auth, "the backend bearer went to the backend"
    finally:
        b.close()

    assert len(seen) == 1
    kw = seen[0]
    blob = json.dumps(kw, default=str)
    for name, value in {**secrets, "customer_token": "cust-tok-51ce", "session_header_name": gateway.SESSION_HEADER}.items():
        assert value not in blob, f"{name} reached the trace"
    assert "api_token" not in kw["args"] and kw["args"]["order_id"] == "Z-9"
    assert len(kw["args"]["note"]) == gateway.MAX_TRACED_CHARS + 1, "long strings are cut, not dropped"
    assert kw["turns"] == ["refund please, my password is hunter2"], "customer turns are what the rule reads; they are not a header"
    assert (kw["tool"], kw["decision"], kw["verified"], kw["ran"]) == ("issue_refund", "allowed", [], 0)
    assert kw["_thread"] == "conv-7", "the op runs inside the session's thread"
    assert set(kw) - {"_thread"} == {"tool", "args", "result", "decision", "elapsed_ms", "turns", "verified", "ran"}, "the op's signature is the guard; widen it deliberately"
    traced, scorer = scored[0]
    assert traced.id == "traced-1" and isinstance(scorer, gateway.ToolRuleScorer) and set(scorer.rules) == {"issue_refund", "frobnicate"}


def test_gateway_trace_inputs_are_the_session_as_the_rule_saw_it(monkeypatch: pytest.MonkeyPatch, tmp_path) -> None:
    from conftest import FakeToolBackend
    from fastapi.testclient import TestClient

    from chaos import gateway
    from chaos.schemas import AgentConfig, ToolPolicy, ToolRule

    seen: list[dict] = []
    monkeypatch.setattr(gateway, "tracing", lambda: True)
    monkeypatch.setattr(gateway, "_traced_tool_call", SimpleNamespace(call=lambda **kw: (seen.append(kw), SimpleNamespace(id="t"))[1]))
    monkeypatch.setattr(gateway, "_score_call", lambda traced, scorer: None)
    rules = ToolPolicy(tool_rules={"issue_refund": ToolRule(requires_verified_lookup=True, max_calls=1), "frobnicate": ToolRule(deny=True)})
    b = FakeToolBackend({"lookup_order": {"order_id": "Z-9"}, "issue_refund": {"ok": True}, "frobnicate": {}})
    try:
        gw = gateway.Gateway(b.url, AgentConfig(version=1, system_prompt="x", tool_policy=rules), enforce=True, log=tmp_path / "g.jsonl")
        c = TestClient(gw.app)
        h = {gateway.SESSION_HEADER: "conv-1"}
        c.post("/tools/frobnicate", json={}, headers=h)
        c.post("/tools/lookup_order", json={"order_id": "Z-9"}, headers=h)
        c.post("/tools/issue_refund", json={"order_id": "Z-9"}, headers=h)
        c.post("/tools/issue_refund", json={"order_id": "Z-9"}, headers=h)
    finally:
        b.close()
    rows = [(k["tool"], k["decision"], k["verified"], k["ran"]) for k in seen]
    assert rows == [
        ("frobnicate", "blocked", [], 0),
        ("lookup_order", "allowed", [], 0),  # Z-9 became verified *by* this call, so it was not verified when the rule ran
        ("issue_refund", "allowed", ["Z-9"], 0),
        ("issue_refund", "blocked", ["Z-9"], 1),  # the second attempt saw one prior run; a blocked attempt is not a run
    ]
    assert "not allowed" in seen[0]["result"]["error"]


def test_tool_rule_scorer_reruns_the_rule_and_says_whether_the_gateway_agreed() -> None:
    from chaos.gateway import ToolRuleScorer
    from chaos.schemas import ToolRule

    scorer = ToolRuleScorer(rules={"issue_refund": ToolRule(requires_user_intent=True, max_calls=1), "frobnicate": ToolRule(deny=True)})
    blocked = scorer.score(output={"decision": "blocked"}, tool="frobnicate", args={}, turns=[], verified=[], ran=0)
    assert blocked["has_rule"] and blocked["blocks"] and blocked["agrees"] and "not allowed" in blocked["reason"]
    shadow = scorer.score(output={"decision": "would_block"}, tool="frobnicate", args={}, turns=[], verified=[], ran=0)
    assert shadow["blocks"] and shadow["agrees"], "shadow mode: the rule fired and the mode let it run"
    assert scorer.score(output={"decision": "allowed"}, tool="frobnicate", args={}, turns=[], verified=[], ran=0)["agrees"] is False
    no_rule = scorer.score(output={"decision": "allowed"}, tool="lookup_order", args={"order_id": "Z-9"}, turns=[], verified=[], ran=4)
    assert no_rule == {"has_rule": False, "blocks": False, "reason": None, "agrees": True}
    asked = scorer.score(output={"decision": "allowed"}, tool="issue_refund", args={"order_id": "Z-9"}, turns=["I want a refund"], verified=[], ran=0)
    assert asked == {"has_rule": True, "blocks": False, "reason": None, "agrees": True}
    again = scorer.score(output={"decision": "allowed"}, tool="issue_refund", args={"order_id": "Z-9"}, turns=["I want a refund"], verified=[], ran=1)
    assert again["blocks"] and again["agrees"] is False and "at most 1" in again["reason"]
    assert asked == scorer.score(output={"decision": "allowed"}, tool="issue_refund", args={"order_id": "Z-9"}, turns=["I want a refund"], verified=[], ran=0), "deterministic"


def test_gateway_weave_is_off_unless_asked_and_keyed_and_fails_soft(monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str], tmp_path) -> None:
    from chaos import gateway
    from chaos.schemas import AgentConfig, ToolCall
    from chaos.toolbus import ToolSession

    def never(*a, **k):
        raise AssertionError("weave.init must not run")

    monkeypatch.setattr(gateway.weave, "init", never)
    monkeypatch.delenv("ANTIBODY_GATEWAY_WEAVE", raising=False)
    monkeypatch.setenv("WANDB_API_KEY", "not-a-real-key")
    assert gateway.weave_enabled() is False and gateway.init_weave().startswith("off (")
    monkeypatch.setenv("ANTIBODY_GATEWAY_WEAVE", "1")
    monkeypatch.delenv("WANDB_API_KEY", raising=False)
    assert gateway.weave_enabled() is False and gateway.tracing() is False, "the flag without a key traces nothing"
    monkeypatch.setenv("WANDB_API_KEY", "not-a-real-key")
    assert gateway.weave_enabled() is True
    monkeypatch.setattr(gateway.weave, "get_client", lambda: None)
    assert gateway.tracing() is False, "opted in, but init did not happen or failed: no trace"

    def boom(*_a, **_k):
        raise ConnectionError("no network")

    monkeypatch.setattr(gateway.weave, "init", boom)
    assert gateway.init_weave().startswith("init failed, running untraced: ConnectionError")

    # A trace that raises is one stdout line; the call's log row was already written and the tool answer stands.
    cfg = AgentConfig(version=1, system_prompt="x")
    gw = gateway.Gateway("http://127.0.0.1:1", cfg, log=tmp_path / "g.jsonl")
    session = ToolSession(cfg=cfg, scenario=gateway.PRODUCTION, customer_turns=[], tools_backend="http://127.0.0.1:1", session_id="s1")
    monkeypatch.setattr(gateway, "tracing", lambda: True)
    monkeypatch.setattr(gateway, "trace_inputs", boom)
    gw._after_call("s1", session, ToolCall(tool="lookup_order", args={}, result={"ok": True}))
    assert len(gateway.read_log(path=gw.log)) == 1
    assert "weave trace skipped: ConnectionError" in capsys.readouterr().out


def test_redact_drops_credential_keys_at_every_depth_and_cuts_long_strings() -> None:
    from chaos.gateway import MAX_TRACED_CHARS, redact

    doc = {"order_id": "Z-9", "Authorization": "Bearer x", "meta": {"api-key": "k", "items": [{"secret_note": 1, "sku": "A" * 1000}]}, "n": 3, "ok": True}
    out = redact(doc)
    assert out == {"order_id": "Z-9", "meta": {"items": [{"sku": "A" * MAX_TRACED_CHARS + "…"}]}, "n": 3, "ok": True}
    assert redact("short") == "short" and redact(None) is None and redact([1, "x"]) == [1, "x"]
    assert doc["meta"]["items"][0]["sku"] == "A" * 1000, "a copy, not an edit"


def test_score_call_runs_the_coroutine_inline_or_off_the_event_loop() -> None:
    import asyncio
    import threading

    from chaos.gateway import ToolRuleScorer, _score_call

    applied: list = []

    class Traced:
        async def apply_scorer(self, scorer):
            applied.append((scorer, threading.current_thread().name))

    scorer = ToolRuleScorer(rules={})
    _score_call(Traced(), scorer)
    assert applied == [(scorer, "MainThread")], "no loop running (a test, a sync caller): run to completion inline"

    async def inside() -> None:
        _score_call(Traced(), scorer)
        # The route's loop goes away right after; the score must not depend on it.

    asyncio.run(inside())
    from chaos import gateway

    gateway._SCORING.submit(lambda: None).result()  # one worker, FIFO: this returns once the score before it ran
    assert len(applied) == 2 and applied[1][0] is scorer and applied[1][1].startswith("antibody-gateway-score"), "inside a loop (the FastAPI route): handed to the scoring thread, never parked on the request loop"


def test_score_call_drops_the_newest_score_once_the_backlog_is_full(monkeypatch: pytest.MonkeyPatch) -> None:
    """A Weave outage must not grow the scoring queue without bound: past SCORE_BACKLOG waiting scores the newest is
    closed unawaited, the semaphore is handed back when a score finishes, and the trace itself is untouched."""
    import asyncio
    import threading

    from chaos import gateway

    release = threading.Event()
    started: list[int] = []

    class Hanging:
        async def apply_scorer(self, scorer):
            started.append(1)
            await asyncio.get_running_loop().run_in_executor(None, release.wait)

    monkeypatch.setattr(gateway, "SCORE_BACKLOG", 2)
    monkeypatch.setattr(gateway, "_SCORE_SLOTS", threading.BoundedSemaphore(2))
    scorer = gateway.ToolRuleScorer(rules={})

    async def inside() -> None:
        for _ in range(5):
            gateway._score_call(Hanging(), scorer)

    asyncio.run(inside())
    assert gateway._SCORE_SLOTS._value == 0, "two slots taken; the other three were dropped, not queued"
    release.set()
    gateway._SCORING.submit(lambda: None).result()
    assert started == [1, 1], "only the admitted scores ever ran"
    for _ in range(50):
        if gateway._SCORE_SLOTS._value == 2:
            break
        time.sleep(0.01)
    assert gateway._SCORE_SLOTS._value == 2, "finished scores hand their slot back"


# --- §4.5 prompts as objects ---------------------------------------------------------------------------------------


def test_prompts_publish_as_string_prompts_and_the_model_references_its_own(monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]) -> None:
    import weave

    from chaos import evals
    from chaos.target_agent import V0_CONFIG

    monkeypatch.setattr(evals, "_prompt_refs", {})
    # No client (the API process, this suite): nothing published, nothing referenced.
    monkeypatch.setattr(evals.weave, "get_client", lambda: None)
    assert evals.publish_prompt(evals.SYSTEM_PROMPT_NAME, V0_CONFIG.system_prompt) is None
    assert evals.TargetAgent(config=V0_CONFIG).system_prompt_ref is None

    monkeypatch.setattr(evals.weave, "get_client", lambda: object())
    published: list = []

    def fake_publish(obj, name=None, **_):
        published.append((obj, name))
        return SimpleNamespace(uri=lambda: f"weave:///e/p/object/{name}:digest-{len(obj.content)}")

    monkeypatch.setattr(evals.weave, "publish", fake_publish)
    ref = evals.publish_prompt(evals.SYSTEM_PROMPT_NAME, V0_CONFIG.system_prompt)
    assert ref == f"weave:///e/p/object/system-prompt:digest-{len(V0_CONFIG.system_prompt)}"
    obj, name = published[0]
    assert isinstance(obj, weave.StringPrompt) and obj.content == V0_CONFIG.system_prompt and name == "system-prompt"
    # Every Model built for a config with that prompt carries the ref; a different prompt (an unpublished candidate) does not.
    assert evals.TargetAgent(config=V0_CONFIG).system_prompt_ref == ref
    candidate = V0_CONFIG.model_copy(update={"version": 1, "system_prompt": V0_CONFIG.system_prompt + "\nNever refund without a lookup."})
    assert evals.TargetAgent(config=candidate).system_prompt_ref is None
    assert evals.TargetAgent(config=candidate, system_prompt_ref="weave:///given").system_prompt_ref == "weave:///given", "an explicit ref is kept"

    def boom(*a, **k):
        raise ConnectionError("down")

    monkeypatch.setattr(evals.weave, "publish", boom)
    assert evals.publish_prompt(evals.JUDGE_PROMPT_NAME, "judge text") is None
    assert "could not publish prompt 'judge-system'" in capsys.readouterr().out


def test_the_loop_publishes_each_candidates_prompt_before_its_gate(monkeypatch: pytest.MonkeyPatch, tmp_path) -> None:
    from chaos.domains import load_domain
    from chaos.schemas import Patch, Verdict

    st = _blocked_cycle_state(monkeypatch, tmp_path)
    st.regression_dataset = None
    st.legit_dataset = None
    st.legit_evaluation = None
    st.domain = load_domain("retail")
    published: list[tuple[str, str]] = []
    order: list[str] = []
    monkeypatch.setattr(loop, "publish_prompt", lambda name, text: published.append((name, text)))
    monkeypatch.setattr(loop.weave, "get_client", lambda: None)
    monkeypatch.setattr(loop, "judge_episode", lambda sc, ep: Verdict(scenario_id=sc.id, config_version=ep.config_version, passed=False, reason="leaked", method="deterministic"))
    monkeypatch.setattr(loop, "propose_patch", lambda *a, **k: Patch(kind="rewrite_system_prompt", rationale="tighten", system_prompt="You are careful. Never leak."))
    monkeypatch.setattr(loop, "MAX_REPAIR_ATTEMPTS", 1)
    monkeypatch.setattr(loop, "save_regression", lambda *a, **k: None)
    monkeypatch.setattr(loop, "publish_dataset", lambda name, rows: None)

    def gate_crashes(candidate, *a, **k):
        order.append(("gate", candidate.system_prompt))
        raise RuntimeError("weave is down")  # the loop treats a crashed gate as a rejection; the prompt was published before it

    monkeypatch.setattr(loop, "run_gate", gate_crashes)
    loop.run_cycle(st, load_domain("retail").seeds[0])
    assert published == [(loop.SYSTEM_PROMPT_NAME, "You are careful. Never leak.")]
    assert order == [("gate", "You are careful. Never leak.")]
    assert loop.JUDGE_PROMPT_NAME == "judge-system" and loop.JUDGE_SYSTEM.startswith("You are a strict QA judge")


# --- §4.6 decisions as feedback -------------------------------------------------------------------------------------


def test_the_gate_records_each_evaluations_call_id_next_to_its_url() -> None:
    from chaos.evals import EvalRun
    from chaos.schemas import GateResult

    run = EvalRun({}, {}, SimpleNamespace(id="call-7", ui_url="https://w/r/call/call-7"))
    assert (run.call_id, run.url) == ("call-7", "https://w/r/call/call-7")
    assert EvalRun({}, {}, SimpleNamespace(id=None, ui_url=None)).call_id is None, "a NoOpCall (no client) has no id"
    assert EvalRun({}, {}, object()).call_id is None
    # Records written before the field existed load with an empty list.
    old = GateResult.model_validate({"accepted": True, "fixes_new_failure": True, "regression_pass_rate": 1.0, "reason": "ok", "weave_eval_urls": ["https://w/r/call/x"]})
    assert old.weave_eval_call_ids == []


def _cycles_with_gates(path, rows: list[tuple[int, int, int, bool, list[str]]]) -> None:
    """Write cycle records: (cycle, config_before, config_after, accepted, call_ids)."""
    import json

    from chaos.domains import load_domain
    from chaos.schemas import CycleRecord, GateResult, Verdict

    seed = load_domain("retail").seeds[0]
    lines = []
    for cycle, before, after, accepted, ids in rows:
        gate = GateResult(accepted=accepted, fixes_new_failure=accepted, regression_pass_rate=1.0, reason="r", weave_eval_urls=[f"https://w/r/call/{i}" for i in ids], weave_eval_call_ids=ids)
        rec = CycleRecord(cycle=cycle, scenario=seed, attack_succeeded=True, verdict=Verdict(scenario_id=seed.id, config_version=before, passed=False, reason="x", method="deterministic"), gate=gate, config_before=before, config_after=after, regression_suite_size=1)
        lines.append(rec.model_dump_json())
    path.write_text("\n".join(lines) + "\n")


def test_eval_call_id_finds_the_gate_new_call_that_admitted_a_version(tmp_path, monkeypatch: pytest.MonkeyPatch) -> None:
    from api import store

    runs = tmp_path / "runs"
    runs.mkdir()
    monkeypatch.setattr(store, "CYCLES_PATH", runs / "cycles.jsonl")
    assert store.eval_call_id("live", 1) is None, "no cycles yet"
    _cycles_with_gates(
        runs / "cycles.jsonl",
        [
            (1, 0, 1, True, ["new-1a", "new-1b", "reg-1", "legit-1"]),
            (2, 1, 1, False, ["new-2a", "new-2b", "reg-2", "legit-2"]),  # rejected: the config stayed at v1
            (3, 1, 2, True, []),  # promoted without a client: no ids stored
        ],
    )
    assert store.eval_call_id("live", 1) == "new-1a", "the first gate-new sample of the cycle that promoted to v1"
    assert store.eval_call_id("live", 0) is None, "v0 was never gated"
    assert store.eval_call_id("live", 2) is None, "promoted, but the run had nothing to store"
    assert store.eval_call_id("live", 9) is None


def test_record_decision_writes_a_reaction_and_a_note_only_with_a_ready_client(monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture) -> None:
    import weave

    from api import attack

    fetched: list[str] = []
    feedback: list[tuple[str, str]] = []

    class FakeFeedback:
        def add_reaction(self, emoji, creator=None):
            feedback.append(("reaction", emoji))
            return "fb-1"

        def add_note(self, note, creator=None):
            feedback.append(("note", note))
            return "fb-2"

    class FakeClient:
        def get_call(self, call_id, **_):
            fetched.append(call_id)
            if call_id == "gone":
                raise ValueError("no such call")
            return SimpleNamespace(feedback=FakeFeedback())

    monkeypatch.setattr(weave, "get_client", lambda: FakeClient())
    # Not warmed (keyless API, ANTIBODY_NO_WEAVE, warm-up failed): nothing is sent and the client is never touched.
    monkeypatch.setattr(attack, "_weave_ready", False)
    assert attack.record_decision("new-1a", "approved", "fine") is False and attack.record_decision_later("new-1a", "approved") is False
    assert fetched == []
    monkeypatch.setattr(attack, "_weave_ready", True)
    assert attack.record_decision(None, "approved") is False, "v0 or a run without ids: nothing to attach to"
    assert attack.record_decision("new-1a", "pending") is False, "only a decision is a reaction"
    assert attack.record_decision("new-1a", "approved", "  looked at the diff ") is True
    assert attack.record_decision("new-1b", "rejected", "   ") is True
    assert fetched == ["new-1a", "new-1b"]
    assert feedback == [("reaction", "👍"), ("note", "looked at the diff"), ("reaction", "👎")], "a blank note is not a note"
    with caplog.at_level("WARNING", logger="api.attack"):
        assert attack.record_decision("gone", "approved") is False
    assert "could not record the decision on Weave call gone (ValueError" in caplog.text
    monkeypatch.setattr(weave, "get_client", lambda: None)
    assert attack.record_decision("new-1a", "approved") is False, "ready flag but no client (a test double): skip"


def test_review_route_hands_the_decision_to_weave_off_the_request_and_never_fails_on_it(client, tmp_path, monkeypatch: pytest.MonkeyPatch) -> None:
    import shutil

    from api import attack, loop_ctl, store
    from chaos import state
    from chaos.state import GOLDEN_DIR

    runs = tmp_path / "runs"
    runs.mkdir()
    shutil.copytree(GOLDEN_DIR / "runs" / "configs", runs / "configs")
    monkeypatch.setattr(state, "RUNS_DIR", runs)
    for mod in (state, store):
        monkeypatch.setattr(mod, "CONFIGS_DIR", runs / "configs")
        monkeypatch.setattr(mod, "REGRESSION_PATH", runs / "regression.json")
        monkeypatch.setattr(mod, "CYCLES_PATH", runs / "cycles.jsonl")
    monkeypatch.setattr(loop_ctl, "state", lambda: {**loop_ctl.IDLE})
    _cycles_with_gates(runs / "cycles.jsonl", [(1, 0, 1, True, ["new-1a", "reg-1"]), (2, 1, 2, True, ["new-2a"])])
    handed: list[tuple] = []
    real_later = attack.record_decision_later
    monkeypatch.setattr(attack, "record_decision_later", lambda call_id, status, note="": handed.append((call_id, status, note)) or True)
    assert client.post("/api/configs/2/review", json={"status": "approved", "note": "ship"}).json()["status"] == "approved"
    assert client.post("/api/configs/1/review", json={"status": "rejected"}).status_code == 200
    assert client.post("/api/configs/0/review", json={"status": "approved"}).status_code == 200
    assert handed == [("new-2a", "approved", "ship"), ("new-1a", "rejected", ""), (None, "approved", "")]

    # The real hand-off with a ready client and a Weave that blows up: the decision is saved and the route answers 200,
    # because the Weave call runs on its own thread and its failure stays there.
    done = threading.Event()

    def boom(*a, **k):
        done.set()
        raise RuntimeError("weave exploded")

    monkeypatch.setattr(attack, "record_decision_later", real_later)
    monkeypatch.setattr(attack, "_weave_ready", True)
    monkeypatch.setattr(attack, "record_decision", boom)
    r = client.post("/api/configs/2/review", json={"status": "rejected", "note": "changed my mind"})
    assert r.status_code == 200 and state.load_approvals()[2]["status"] == "rejected"
    assert done.wait(2), "the hand-off did reach Weave's side"
