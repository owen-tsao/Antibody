"""The enforcement gateway (plan 09 §5): approved rules in front of real tools, shadow first."""

from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Iterator

import pytest
from conftest import FakeToolBackend
from fastapi.testclient import TestClient

from chaos import gateway, state
from chaos.gateway import Gateway
from chaos.schemas import AgentConfig, ToolPolicy, ToolRule
from chaos.toolserver import SESSION_HEADER

RULES = ToolPolicy(tool_rules={"issue_refund": ToolRule(requires_user_intent=True, requires_verified_lookup=True, max_calls=1), "frobnicate": ToolRule(deny=True)})


@pytest.fixture
def backend() -> Iterator[FakeToolBackend]:
    b = FakeToolBackend({"lookup_order": {"order_id": "Z-9", "status": "shipped"}, "issue_refund": {"ok": True}, "frobnicate": {"did": "it"}})
    yield b
    b.close()


def _gw(backend: FakeToolBackend, tmp_path: Path, *, enforce: bool, version: int = 3) -> tuple[Gateway, TestClient]:
    gw = Gateway(backend.url, AgentConfig(version=version, system_prompt="x", tool_policy=RULES), enforce=enforce, log=tmp_path / "gateway.jsonl")
    return gw, TestClient(gw.app)


def _hdr(session: str, customer: str | None = None) -> dict:
    h = {SESSION_HEADER: session}
    if customer:
        h[gateway.CUSTOMER_HEADER] = customer
    return h


def test_forwards_to_the_backend_and_creates_sessions_on_first_sight(backend, tmp_path):
    gw, c = _gw(backend, tmp_path, enforce=True)
    r = c.post("/tools/lookup_order", json={"order_id": "Z-9"}, headers=_hdr("conv-1", "alice@example.com"))
    assert r.status_code == 200 and r.json()["status"] == "shipped"
    assert backend.received == [("lookup_order", {"order_id": "Z-9"})]
    assert backend.sessions == ["conv-1"], "the agent's session id goes on to the real tools (plan 10 §5 blocker 1)"
    assert gw.session_count() == 1
    assert c.post("/tools/lookup_order", json={}).status_code == 400  # no session header
    assert c.get("/health").json()["mode"] == "enforce"


def test_health_reports_the_live_policy_version(backend, tmp_path, monkeypatch):
    runs = tmp_path / "runs"
    monkeypatch.setattr(state, "RUNS_DIR", runs)
    monkeypatch.setattr(state, "CONFIGS_DIR", runs / "configs")
    # approvals.json lives beside regression.json: without this the reviews below land in the repo's real runs/.
    monkeypatch.setattr(state, "REGRESSION_PATH", runs / "regression.json")
    _, c = _gw(backend, tmp_path, enforce=False)
    doc = c.get("/health").json()
    assert {k: doc[k] for k in ("ok", "version", "approved_at", "rules", "mode", "sessions")} == {"ok": True, "version": 3, "approved_at": None, "rules": 2, "mode": "shadow", "sessions": 0}
    assert doc["backend"] == backend.url
    state.review(3, "approved", "ship it")
    assert c.get("/health").json()["approved_at"] == state.load_approvals()[3]["at"]
    state.review(3, "rejected")
    assert c.get("/health").json()["approved_at"] is None, "a rejected version has nobody's signature on it"


def test_shadow_logs_what_it_would_block_and_lets_the_call_through(backend, tmp_path):
    gw, c = _gw(backend, tmp_path, enforce=False)
    r = c.post("/tools/frobnicate", json={"x": 1}, headers=_hdr("conv-1", "alice@example.com"))
    assert r.status_code == 200 and r.json() == {"did": "it"}
    assert backend.received == [("frobnicate", {"x": 1})]
    lines = gateway.read_log(path=gw.log)
    assert len(lines) == 1
    line = lines[0]
    assert line["decision"] == "would_block" and line["mode"] == "shadow" and line["tool"] == "frobnicate"
    assert line["customer"] == "alice@example.com" and line["session"] == "conv-1" and line["config_version"] == 3
    assert "not allowed" in line["reason"]
    assert set(line) == {"at", "session", "customer", "backend", "config_version", "tool", "args", "decision", "reason", "mode", "degraded", "elapsed_ms"}
    assert line["backend"] == backend.url
    assert line["degraded"] is False and isinstance(line["elapsed_ms"], int) and line["elapsed_ms"] >= 0


def test_enforce_blocks_and_the_intent_rule_reads_customer_turns(backend, tmp_path):
    gw, c = _gw(backend, tmp_path, enforce=True)
    h = _hdr("conv-2")
    blocked = c.post("/tools/frobnicate", json={}, headers=h)
    assert blocked.status_code == 200 and "not allowed" in blocked.json()["error"]
    assert backend.received == []
    # Refund: needs the customer to have asked and the order to have been looked up.
    r = c.post("/tools/issue_refund", json={"order_id": "Z-9"}, headers=h)
    assert "never asked for refund" in r.json()["error"]
    assert c.post("/sessions/conv-2/turn", json={"text": "I want a refund for Z-9"}).json() == {"turns": 1}
    r = c.post("/tools/issue_refund", json={"order_id": "Z-9"}, headers=h)
    assert "lookup of Z-9" in r.json()["error"]
    c.post("/tools/lookup_order", json={"order_id": "Z-9"}, headers=h)
    assert c.post("/tools/issue_refund", json={"order_id": "Z-9"}, headers=h).json() == {"ok": True}
    assert "at most 1 time" in c.post("/tools/issue_refund", json={"order_id": "Z-9"}, headers=h).json()["error"]
    decisions = [l["decision"] for l in gateway.read_log(path=gw.log)]
    assert decisions == ["blocked", "blocked", "blocked", "allowed", "allowed", "blocked"]
    assert c.post("/sessions/conv-2/turn", json={"nope": 1}).status_code == 400


def test_turns_are_capped_per_session_in_length_and_in_body_size(backend, tmp_path, monkeypatch):
    """A customer conversation is a few hundred short messages: past the caps the route answers 429 (too many turns
    for this session) or 413 (message or body too large) with a plain `detail`, and remembers nothing of the request."""
    monkeypatch.setattr(gateway, "MAX_TURNS_PER_SESSION", 3)
    monkeypatch.setattr(gateway, "MAX_TURN_CHARS", 20)
    monkeypatch.setattr(gateway, "MAX_TURN_BODY_BYTES", 200)
    gw, c = _gw(backend, tmp_path, enforce=True)
    for i in range(3):
        assert c.post("/sessions/conv-9/turn", json={"text": f"turn {i}"}).json() == {"turns": i + 1}
    r = c.post("/sessions/conv-9/turn", json={"text": "one more"})
    assert r.status_code == 429 and r.json() == {"detail": "session conv-9 has reached 3 turns; start a new session"}
    assert c.post("/sessions/conv-9/turn", json={"text": "still no"}).status_code == 429, "the cap holds, it is not a one-off"
    assert len(gw._session_for("conv-9").customer_turns) == 3
    # Another session is not affected by the first one's count.
    assert c.post("/sessions/conv-10/turn", json={"text": "hello"}).json() == {"turns": 1}
    r = c.post("/sessions/conv-10/turn", json={"text": "x" * 21})
    assert r.status_code == 413 and r.json() == {"detail": "text is longer than 20 characters"}
    assert c.post("/sessions/conv-10/turn", json={"text": "x" * 20}).status_code == 200, "the cap is inclusive"
    # The body cap is checked before the JSON is parsed, so padding around a short text is refused too, as is junk.
    r = c.post("/sessions/conv-10/turn", content=b'{"text": "hi", "pad": "' + b"p" * 200 + b'"}', headers={"content-type": "application/json"})
    assert r.status_code == 413 and r.json() == {"detail": "body is larger than 200 bytes"}
    r = c.post("/sessions/conv-10/turn", content=b"\xff" * 201, headers={"content-type": "application/json"})
    assert r.status_code == 413
    assert c.post("/sessions/conv-10/turn", content=b"not json", headers={"content-type": "application/json"}).status_code == 400
    assert len(gw._session_for("conv-10").customer_turns) == 2, "refused turns are not remembered"
    assert [row["turn"] for row in gateway.read_log(path=gw.log, calls_only=False) if "turn" in row] == ["turn 0", "turn 1", "turn 2", "hello", "x" * 20], "and not logged"
    assert gw.session_count() == 2, "a refused body or text does not create a session either"
    assert c.post("/sessions/conv-11/turn", json={"text": "x" * 21}).status_code == 413 and gw.session_count() == 2

def test_tools_listing_proxies_the_backend_or_is_empty(backend, tmp_path):
    _, c = _gw(backend, tmp_path, enforce=False)
    assert c.get("/tools", headers=_hdr("s")).json() == []  # FakeToolBackend has no GET /tools


def test_idle_sessions_are_dropped(backend, tmp_path, monkeypatch):
    gw, c = _gw(backend, tmp_path, enforce=True)
    c.post("/tools/lookup_order", json={"order_id": "Z-9"}, headers=_hdr("old"))
    monkeypatch.setattr(gateway, "SESSION_IDLE_S", -1.0)
    c.post("/tools/lookup_order", json={"order_id": "Z-9"}, headers=_hdr("new"))
    assert gw.session_count() == 1


def test_health_never_creates_a_session(backend, tmp_path, monkeypatch):
    """S1: /health is the one route without the bearer; session and customer headers on it must leave no trace,
    or an unauthenticated caller can grow the session map for as long as it likes (the idle sweep only runs on
    authenticated calls). The sweep also runs on the path that records the customer name."""
    gw, c = _gw(backend, tmp_path, enforce=True)
    for i in range(50):
        assert c.get("/health", headers=_hdr(f"anon-{i}", "mallory@example.com")).status_code == 200
    assert gw.session_count() == 0
    monkeypatch.setenv(gateway.TOKEN_ENV, "gw-secret")
    for i in range(50):
        c.get("/health", headers={**_hdr(f"anon-{i}", "mallory@example.com"), "Authorization": "Bearer gw-secret"})
    assert gw.session_count() == 0, "even with the token, /health is not a conversation"
    # A real call with the customer header records it once, and the idle sweep runs on that path too.
    c.post("/tools/lookup_order", json={"order_id": "Z-9"}, headers={**_hdr("old", "alice@example.com"), "Authorization": "Bearer gw-secret"})
    assert gw.session_count() == 1 and gw._customer_of("old") == "alice@example.com"
    monkeypatch.setattr(gateway, "SESSION_IDLE_S", 0.2)
    time.sleep(0.3)
    c.post("/sessions/new/turn", json={"text": "hi"}, headers={**_hdr("new", "bob@example.com"), "Authorization": "Bearer gw-secret"})
    assert gw.session_count() == 1 and gw._customer_of("new") == "bob@example.com" and gw._customer_of("old") == ""


def test_approved_version_picks_the_certified_config(tmp_path, monkeypatch):
    runs = tmp_path / "runs"
    monkeypatch.setattr(state, "RUNS_DIR", runs)
    monkeypatch.setattr(state, "CONFIGS_DIR", runs / "configs")
    monkeypatch.setattr(state, "REGRESSION_PATH", runs / "regression.json")
    assert gateway.load_policy_config("approved").version == 0
    state.save_config(AgentConfig(version=1, system_prompt="a"))
    state.save_config(AgentConfig(version=2, system_prompt="b"))
    assert gateway.load_policy_config("approved").version == 0
    state.review(1, "approved")
    assert gateway.load_policy_config("approved").version == 1
    assert gateway.load_policy_config("2").version == 2


def test_api_reads_the_log(client, tmp_path, monkeypatch):
    monkeypatch.setattr(state, "HISTORY_DIR", tmp_path / "history")
    assert client.get("/api/gateway").json()["events"] == []
    (tmp_path / "history").mkdir()
    (tmp_path / "history" / "gateway.jsonl").write_text(json.dumps({"tool": "a", "decision": "allowed"}) + "\n{torn\n" + json.dumps({"tool": "b", "decision": "blocked"}) + "\n")
    doc = client.get("/api/gateway?tail=1").json()
    assert doc["events"] == [{"tool": "b", "decision": "blocked"}] and doc["command"].startswith("python -m chaos.gateway")
    assert len(client.get("/api/gateway").json()["events"]) == 2
    assert doc["command"].endswith("--shadow"), "the Settings string spells shadow out (plan 10 §5b)"


def test_api_log_is_scoped_to_one_backend_the_way_the_replay_is(client, tmp_path, monkeypatch):
    """The Agent page's Shadow log passes the agent's `tools_backend`: another backend's rows and the legacy rows
    with no `backend` stay out, the tail counts that backend's rows only, and the command names it. No filter, no scoping."""
    monkeypatch.setattr(state, "HISTORY_DIR", tmp_path / "history")
    (tmp_path / "history").mkdir()
    rows = [
        {"tool": "old", "decision": "allowed"},
        {"tool": "a1", "decision": "allowed", "backend": "http://airline:2"},
        {"tool": "r1", "decision": "would_block", "backend": "http://retail:1"},
        {"tool": "a2", "decision": "would_block", "backend": "http://airline:2/"},
        {"tool": "r2", "decision": "allowed", "backend": "http://retail:1"},
    ]
    (tmp_path / "history" / "gateway.jsonl").write_text("\n".join(json.dumps(r) for r in rows) + "\n")
    airline = client.get("/api/gateway?backend=http://airline:2").json()
    assert [e["tool"] for e in airline["events"]] == ["a1", "a2"], "a trailing slash is the same backend; legacy rows match no filter"
    assert airline["command"] == "python -m chaos.gateway --backend http://airline:2 --version approved --shadow"
    assert [e["tool"] for e in client.get("/api/gateway?backend=http://retail:1&tail=1").json()["events"]] == ["r2"], "the tail is taken after the filter"
    assert [e["tool"] for e in client.get("/api/gateway?tail=2").json()["events"]] == ["a2", "r2"]
    assert len(client.get("/api/gateway?backend=").json()["events"]) == 5, "an empty filter is no filter"
    assert client.get("/api/gateway?backend=http://nobody:9").json()["events"] == []
    # One filter for both views: what the log shows for a backend is exactly what the replay counts for it.
    assert gateway.for_backend(rows, "http://retail:1") == [rows[2], rows[4]] and gateway.for_backend(rows, None) == rows


# --- C2: the contract a customer runs the gateway under (plan 10 §5b loop 3) --------------------------------------


def test_bearer_required_when_configured_and_health_stays_open(backend, tmp_path, monkeypatch):
    monkeypatch.setenv(gateway.TOKEN_ENV, "gw-secret")
    gw, c = _gw(backend, tmp_path, enforce=True)
    h = _hdr("conv-1", "alice@example.com")
    r = c.post("/tools/lookup_order", json={"order_id": "Z-9"}, headers=h)
    assert r.status_code == 401 and r.json() == {"detail": "missing or wrong gateway token"} and r.headers["www-authenticate"] == "Bearer"
    assert c.post("/tools/lookup_order", json={}, headers={**h, "Authorization": "Bearer nope"}).status_code == 401
    assert c.post("/sessions/conv-1/turn", json={"text": "hi"}).status_code == 401
    assert c.get("/tools", headers=h).status_code == 401
    assert gw.session_count() == 0, "a caller without the token leaves no trace, not even a customer name"
    assert backend.received == []
    assert c.get("/health").status_code == 200
    ok = c.post("/tools/lookup_order", json={"order_id": "Z-9"}, headers={**h, "Authorization": "bearer gw-secret"})
    assert ok.status_code == 200 and ok.json()["status"] == "shipped"
    assert backend.auth == [None, None], "the agent's gateway token is never forwarded to the backend (tool-list fetch at start, then the call)"


def test_backend_authorization_is_forwarded_from_its_own_setting(tmp_path, monkeypatch):
    b = FakeToolBackend({"lookup_order": {"order_id": "Z-9"}}, tools=[{"name": "lookup_order", "description": "look"}])
    try:
        monkeypatch.setenv(gateway.TOKEN_ENV, "gw-secret")
        monkeypatch.setenv(gateway.BACKEND_AUTH_ENV, "Bearer backend-key")
        gw = Gateway(b.url, AgentConfig(version=1, system_prompt="x"), log=tmp_path / "g.jsonl")
        c = TestClient(gw.app)
        h = {**_hdr("s1"), "Authorization": "Bearer gw-secret"}
        assert c.post("/tools/lookup_order", json={"order_id": "Z-9"}, headers=h).status_code == 200
        assert c.get("/tools", headers=h).json() == [{"name": "lookup_order", "description": "look"}]
        assert b.auth == ["Bearer backend-key"] * 3 and b.sessions == ["s1"], "start-up tool-list fetch, the call, the proxied list: all with the backend's own auth"
    finally:
        b.close()


def test_backend_down_refuses_money_and_lets_reads_through_degraded(tmp_path):
    dead = FakeToolBackend({})
    dead.close()  # a URL nothing listens on
    gw = Gateway(dead.url, AgentConfig(version=1, system_prompt="x"), enforce=True, log=tmp_path / "g.jsonl")
    c = TestClient(gw.app)
    h = _hdr("s1")
    refund = c.post("/tools/issue_refund", json={"order_id": "Z-9"}, headers=h).json()
    assert refund["error"].startswith("gateway: refused — backend unreachable")
    read = c.post("/tools/lookup_order", json={"order_id": "Z-9"}, headers=h).json()
    assert read["error"].startswith("tool failed: backend unreachable")
    rows = gateway.read_log(path=gw.log)
    assert [(r["tool"], r["decision"], r["degraded"]) for r in rows] == [("issue_refund", "blocked", False), ("lookup_order", "allowed", True)]
    assert rows[0]["reason"].startswith("failure:backend unreachable") and rows[1]["reason"] is None


def test_on_failure_overrides_the_class_and_a_5xx_is_a_failure(tmp_path):
    b = FakeToolBackend({"lookup_order": {}, "issue_refund": {}}, status_for={"lookup_order": 503, "issue_refund": 500})
    try:
        rules = ToolPolicy(tool_rules={"lookup_order": ToolRule(on_failure="closed"), "issue_refund": ToolRule(on_failure="open")})
        gw = Gateway(b.url, AgentConfig(version=1, system_prompt="x", tool_policy=rules), enforce=True, log=tmp_path / "g.jsonl")
        c = TestClient(gw.app)
        h = _hdr("s1")
        assert c.post("/tools/lookup_order", json={"order_id": "Z-9"}, headers=h).json()["error"] == "gateway: refused — backend error: HTTP 503"
        assert c.post("/tools/issue_refund", json={"order_id": "Z-9"}, headers=h).json()["error"] == "tool failed: backend error: HTTP 500"
        assert [(r["decision"], r["degraded"]) for r in gateway.read_log(path=gw.log)] == [("blocked", False), ("allowed", True)]
    finally:
        b.close()


def test_a_4xx_from_the_backend_is_the_tools_own_answer(backend, tmp_path):
    """Unknown tool / bad arguments: the backend said no, the tool did not run, nothing to fail closed about."""
    gw, c = _gw(backend, tmp_path, enforce=True)
    r = c.post("/tools/charge_card", json={"amount": 1}, headers=_hdr("s1")).json()
    assert r["error"].startswith("tool failed: HTTPError") and "404" in r["error"]
    assert gateway.read_log(path=gw.log)[0]["decision"] == "allowed" and gateway.read_log(path=gw.log)[0]["degraded"] is False


def test_failure_semantics_use_the_class_the_tools_panel_showed(tmp_path):
    """S4: the backend's own tool list (name + description, pack override) decides the class, exactly as the Tools panel
    classifies it. `send_money` is money and fails closed (it used to be `message` by name and fail open); a tool
    whose name says nothing but whose description says "look up" is the read the panel showed, and fails open."""
    listed = [{"name": "send_money", "description": "Transfer funds to a payee"}, {"name": "zap", "description": "Look up an order by id"}, {"name": "frob", "description": ""}]
    b = FakeToolBackend({"send_money": {}, "zap": {}, "frob": {}}, tools=listed, status_for={"send_money": 503, "zap": 503, "frob": 503})
    try:
        gw = Gateway(b.url, AgentConfig(version=1, system_prompt="x"), enforce=True, log=tmp_path / "g.jsonl")
        assert gw.tool_classes == {"send_money": "money", "zap": "read", "frob": "unknown"}
        c = TestClient(gw.app)
        h = _hdr("s1")
        assert c.post("/tools/send_money", json={"to": "x", "amount": 5}, headers=h).json()["error"] == "gateway: refused — backend error: HTTP 503"
        assert c.post("/tools/zap", json={"order_id": "Z-9"}, headers=h).json()["error"] == "tool failed: backend error: HTTP 503"
        assert c.post("/tools/frob", json={}, headers=h).json()["error"].startswith("gateway: refused"), "unknown fails closed"
        assert [(r["tool"], r["decision"]) for r in gateway.read_log(path=gw.log)] == [("send_money", "blocked"), ("zap", "allowed"), ("frob", "blocked")]
        # A tool the backend adds later is classed on the next reload tick, for the sessions already open too.
        b.tools[2] = {"name": "frob", "description": "Look up a payee"}
        gw.refresh_tool_classes()
        assert gw.tool_classes["frob"] == "read" and gw._session_for("s1").tool_classes["frob"] == "read"
        assert c.post("/tools/frob", json={}, headers=h).json()["error"] == "tool failed: backend error: HTTP 503"
    finally:
        b.close()


def test_per_tool_timeout_and_elapsed_ms(tmp_path):
    slow = FakeToolBackend({"lookup_order": {"order_id": "Z-9"}, "issue_refund": {"ok": True}}, delay=0.4)
    try:
        rules = ToolPolicy(tool_rules={"issue_refund": ToolRule(timeout_s=0.1), "lookup_order": ToolRule(timeout_s=0.1, on_failure="open")})
        gw = Gateway(slow.url, AgentConfig(version=1, system_prompt="x", tool_policy=rules), enforce=True, log=tmp_path / "g.jsonl")
        c = TestClient(gw.app)
        h = _hdr("s1")
        assert c.post("/tools/issue_refund", json={"order_id": "Z-9"}, headers=h).json() == {"error": "gateway: refused — backend timed out"}
        assert c.post("/tools/lookup_order", json={"order_id": "Z-9"}, headers=h).json() == {"error": "tool failed: backend timed out"}
        rows = gateway.read_log(path=gw.log)
        assert all(50 <= r["elapsed_ms"] < 400 for r in rows), [r["elapsed_ms"] for r in rows]
        assert rows[0]["reason"] == "failure:backend timed out" and rows[1]["degraded"] is True
    finally:
        slow.close()


def test_the_rule_check_alone_stays_under_a_second_for_a_thousand_calls():
    from chaos.tools import tool_rule_blocks

    rule = ToolRule(requires_user_intent=True, requires_verified_lookup=True, max_calls=5, intent_words=["refund", "money back"])
    turns = ["hello, I would like my money back for order Z-9 please"] * 3
    verified = {"Z-9", "A-1"}
    t0 = time.perf_counter()
    for i in range(1000):
        tool_rule_blocks("issue_refund", {"order_id": "Z-9", "amount": i}, rule, turns, verified, i % 5)
    assert time.perf_counter() - t0 < 1.0


def test_reload_swaps_the_policy_for_open_sessions_too(backend, tmp_path, monkeypatch):
    runs = tmp_path / "runs"
    monkeypatch.setattr(state, "RUNS_DIR", runs)
    monkeypatch.setattr(state, "CONFIGS_DIR", runs / "configs")
    monkeypatch.setattr(state, "REGRESSION_PATH", runs / "regression.json")
    v1 = AgentConfig(version=1, system_prompt="x")
    state.save_config(v1)
    state.review(1, "approved")
    gw = Gateway(backend.url, gateway.load_policy_config("approved"), enforce=True, log=tmp_path / "g.jsonl", version="approved")
    c = TestClient(gw.app)
    h = _hdr("open-conv")
    assert c.post("/tools/frobnicate", json={}, headers=h).json() == {"did": "it"}
    assert gw.reload() is False, "nothing changed, nothing swapped"
    state.save_config(AgentConfig(version=2, system_prompt="x", tool_policy=ToolPolicy(tool_rules={"frobnicate": ToolRule(deny=True)})))
    assert gw.reload() is False, "saved is not approved"
    state.review(2, "approved")
    assert gw.reload() is True and gw.health()["version"] == 2 and gw.health()["rules"] == 1
    assert "not allowed" in c.post("/tools/frobnicate", json={}, headers=h).json()["error"], "the conversation that was already open is now under v2"
    assert gateway.read_log(path=gw.log)[-1]["config_version"] == 2
    # A pinned gateway follows nothing; a version whose file vanished keeps what it had rather than falling open.
    pinned = Gateway(backend.url, gateway.load_policy_config("2"), version="2", log=tmp_path / "p.jsonl")
    state.review(1, "approved")
    assert pinned.reload() is False and pinned.cfg.version == 2
    (runs / "configs" / "v2.json").unlink()
    assert pinned.reload() is False and pinned.cfg.version == 2


def test_reload_never_follows_an_archived_approval_down_to_v0(backend, tmp_path, monkeypatch, capsys):
    """B1: a new run (or `reset`) archives approvals.json, so `approved_version()` says 0. An `--enforce` gateway
    following `approved` must keep serving the policy it has, say so, and flag it stale on /health — never fall open."""
    runs = tmp_path / "runs"
    monkeypatch.setattr(state, "RUNS_DIR", runs)
    monkeypatch.setattr(state, "CONFIGS_DIR", runs / "configs")
    monkeypatch.setattr(state, "REGRESSION_PATH", runs / "regression.json")
    monkeypatch.setattr(state, "CYCLES_PATH", runs / "cycles.jsonl")
    monkeypatch.setattr(state, "RUN_MANIFEST_PATH", runs / "run.json")
    monkeypatch.setattr(state, "HISTORY_DIR", tmp_path / "history")
    state.save_config(AgentConfig(version=1, system_prompt="x", tool_policy=ToolPolicy(tool_rules={"frobnicate": ToolRule(deny=True)})))
    state.review(1, "approved")
    gw = Gateway(backend.url, gateway.load_policy_config("approved"), enforce=True, log=tmp_path / "g.jsonl", version="approved")
    c = TestClient(gw.app)
    assert gw.cfg.version == 1 and c.get("/health").json()["stale"] is False

    assert state.archive_previous_run() is not None
    assert gateway.load_policy_config("approved").version == 0, "the raw loader does say v0 now; reload must not believe it"
    capsys.readouterr()
    assert gw.reload() is False
    assert gw.cfg.version == 1 and len(gw.cfg.tool_policy.tool_rules) == 1
    assert "not allowed" in c.post("/tools/frobnicate", json={}, headers=_hdr("s")).json()["error"], "still enforcing v1"
    out = capsys.readouterr().out
    assert "refusing" in out and "v0" in out and "approvals.json is gone" in out
    health = c.get("/health").json()
    assert health["version"] == 1 and health["rules"] == 1 and health["stale"] is True and health["approved_at"] is None

    # The next run's approval of a higher version is followed; a same-numbered one (its v1 is not our v1) is not.
    state.save_config(AgentConfig(version=1, system_prompt="other run"))
    state.review(1, "approved")
    assert gw.reload() is False and gw.cfg.system_prompt == "x" and gw.health()["stale"] is True
    state.save_config(AgentConfig(version=2, system_prompt="y", tool_policy=ToolPolicy(tool_rules={"a": ToolRule(deny=True), "b": ToolRule(deny=True)})))
    state.review(2, "approved")
    assert gw.reload() is True and gw.cfg.version == 2 and c.get("/health").json()["stale"] is False


def test_replay_rebuilds_each_session_from_the_log(backend, tmp_path):
    """The log written by a rule-less gateway, replayed under RULES: intent from turn rows, lookups from `verified`."""
    gw, c = _gw(backend, tmp_path, enforce=False, version=0)
    gw.cfg = AgentConfig(version=0, system_prompt="x")
    a, b = _hdr("conv-a"), _hdr("conv-b")
    c.post("/tools/frobnicate", json={"x": 1}, headers=a)
    c.post("/sessions/conv-a/turn", json={"text": "I want a refund for Z-9"})
    c.post("/tools/lookup_order", json={"order_id": "Z-9"}, headers=a)
    c.post("/tools/issue_refund", json={"order_id": "Z-9"}, headers=a)
    c.post("/tools/issue_refund", json={"order_id": "Z-9"}, headers=a)  # second: over max_calls
    c.post("/tools/issue_refund", json={"order_id": "Z-9"}, headers=b)  # never asked, never looked up
    rows = gateway.read_log(path=gw.log, calls_only=False)
    assert [r.get("tool", "turn") for r in rows] == ["frobnicate", "turn", "lookup_order", "issue_refund", "issue_refund", "issue_refund"]
    assert rows[2]["verified"] == ["Z-9"] and "verified" not in rows[3]
    assert all(r["backend"] == backend.url for r in rows), "every row — the turn too — says which real tools it went to"
    assert gateway.read_log(path=gw.log) == [r for r in rows if "tool" in r], "the dashboard sees calls only"

    out = gateway.replay(AgentConfig(version=3, system_prompt="x", tool_policy=RULES), rows)
    assert out["version"] == 3 and out["calls"] == 5 and out["would_block"] == 3
    assert out["by_tool"] == {"frobnicate": {"calls": 1, "would_block": 1}, "lookup_order": {"calls": 1, "would_block": 0}, "issue_refund": {"calls": 3, "would_block": 2}}
    reasons = [s["reason"] for s in out["samples"]]
    assert "not allowed" in reasons[0] and "at most 1 time" in reasons[1] and "never asked for refund" in reasons[2]
    assert set(out["samples"][0]) == {"tool", "args", "reason", "at"}
    # Without rules nothing would be blocked; a torn or foreign row is ignored; the sample cap holds.
    assert gateway.replay(AgentConfig(version=0, system_prompt="x"), rows)["would_block"] == 0
    assert gateway.replay(AgentConfig(version=0, system_prompt="x"), [{"junk": 1}, {"tool": 5}])["calls"] == 0
    many = [{"session": "s", "tool": "frobnicate", "args": {}} for _ in range(30)]
    assert len(gateway.replay(AgentConfig(version=3, system_prompt="x", tool_policy=RULES), many)["samples"]) == gateway.REPLAY_SAMPLES


def test_replay_filters_the_shared_log_by_backend(client, tmp_path, monkeypatch):
    """One gateway.jsonl per install: two agents' gateways write to it, and the Review page must see only its agent's calls."""
    cfg = AgentConfig(version=3, system_prompt="x", tool_policy=RULES)
    retail = [
        {"session": "r1", "backend": "http://retail:1", "turn": "I want a refund for Z-9"},
        {"session": "r1", "backend": "http://retail:1", "tool": "lookup_order", "args": {"order_id": "Z-9"}, "verified": ["Z-9"]},
        {"session": "r1", "backend": "http://retail:1", "tool": "issue_refund", "args": {"order_id": "Z-9"}},
    ]
    airline = [
        {"session": "a1", "backend": "http://airline:2/", "tool": "frobnicate", "args": {}},
        {"session": "a1", "backend": "http://airline:2/", "tool": "issue_refund", "args": {"order_id": "Q-1"}},
    ]
    legacy = [{"session": "old", "tool": "frobnicate", "args": {}}]
    rows = retail + airline + legacy

    everything = gateway.replay(cfg, rows)
    assert everything["calls"] == 5 and everything["would_block"] == 3
    only_retail = gateway.replay(cfg, rows, backend="http://retail:1/")
    assert only_retail["calls"] == 2 and only_retail["would_block"] == 0, "the turn and the verified lookup travel with the retail rows"
    only_airline = gateway.replay(cfg, rows, backend="http://airline:2")
    assert only_airline["calls"] == 2 and only_airline["would_block"] == 2 and set(only_airline["by_tool"]) == {"frobnicate", "issue_refund"}
    assert gateway.replay(cfg, rows, backend="http://nobody:9")["calls"] == 0
    assert gateway.replay(cfg, legacy, backend="http://retail:1")["calls"] == 0, "a row from before the field cannot be attributed to any agent"

    runs = tmp_path / "runs"
    monkeypatch.setattr(state, "RUNS_DIR", runs)
    monkeypatch.setattr(state, "CONFIGS_DIR", runs / "configs")
    monkeypatch.setattr(state, "REGRESSION_PATH", runs / "regression.json")
    monkeypatch.setattr(state, "HISTORY_DIR", tmp_path / "history")
    state.save_config(cfg)
    (tmp_path / "history").mkdir()
    (tmp_path / "history" / "gateway.jsonl").write_text("\n".join(json.dumps(r) for r in rows) + "\n")
    assert client.get("/api/gateway/replay?version=3").json()["calls"] == 5
    assert client.get("/api/gateway/replay?version=3&backend=http://airline:2").json()["calls"] == 2
    assert client.get("/api/gateway/replay?version=3&backend=").json()["calls"] == 5, "an empty filter is no filter"


def test_api_replay_route(client, tmp_path, monkeypatch):
    runs = tmp_path / "runs"
    monkeypatch.setattr(state, "RUNS_DIR", runs)
    monkeypatch.setattr(state, "CONFIGS_DIR", runs / "configs")
    monkeypatch.setattr(state, "REGRESSION_PATH", runs / "regression.json")
    monkeypatch.setattr(state, "HISTORY_DIR", tmp_path / "history")
    empty = client.get("/api/gateway/replay").json()
    assert empty == {"version": 0, "calls": 0, "would_block": 0, "by_tool": {}, "samples": []}
    state.save_config(AgentConfig(version=1, system_prompt="x", tool_policy=RULES))
    (tmp_path / "history").mkdir()
    (tmp_path / "history" / "gateway.jsonl").write_text("\n".join(json.dumps(r) for r in [
        {"at": "t", "session": "s", "tool": "frobnicate", "args": {}, "decision": "allowed"},
        {"at": "t", "session": "s", "tool": "lookup_order", "args": {"order_id": "Z-9"}, "decision": "allowed", "verified": ["Z-9"]},
    ]) + "\n")
    doc = client.get("/api/gateway/replay?version=1&source=live").json()
    assert doc["version"] == 1 and doc["calls"] == 2 and doc["would_block"] == 1 and doc["samples"][0]["tool"] == "frobnicate"
    assert client.get("/api/gateway/replay?version=1&source=golden").json()["calls"] == 0, "golden has no real traffic"
    assert client.get("/api/gateway/replay?version=7").status_code == 404
    assert client.get("/api/gateway/replay?version=abc").status_code == 400
    assert client.get("/api/gateway/replay?version=1&source=run:nope").status_code == 404


def test_command_line_and_argparse_spell_out_shadow():
    assert gateway.command_line("http://t:1") == "python -m chaos.gateway --backend http://t:1 --version approved --shadow"
    assert gateway.command_line("http://t:1", enforce=True, version="4") == "python -m chaos.gateway --backend http://t:1 --version 4 --enforce"
    with pytest.raises(SystemExit):
        # `--shadow` and `--enforce` together is a contradiction the parser refuses.
        gateway._main(["--backend", "http://t:1", "--shadow", "--enforce"])
