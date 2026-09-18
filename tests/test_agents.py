"""Agents as objects (plan 00, Block 1): the store, the ping, the runs join, the target on the request body.

Run with `env -u WANDB_API_KEY uv run pytest -q`. The store lives in a temp history/, the spawn is a stand-in,
and the "agents" pinged are `FakeAgent`s from conftest on ephemeral ports. Nothing here needs a key or a model.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from conftest import FakeAgent, flat_run
from fastapi.testclient import TestClient

from api import agents, example_agent, loop_ctl, store
from chaos import state

FIVE_TOOLS = [
    {"name": n, "description": f"{n} does a thing"}
    for n in ("lookup_order", "issue_refund", "send_email", "read_ticket", "set_ticket_status")
]


class FakeProc:
    def __init__(self, cmd, **kwargs):
        self.cmd = cmd
        self.env = kwargs.get("env") or {}
        self.pid = 4242
        self.returncode = None

    def poll(self):
        return self.returncode


@pytest.fixture
def world(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> dict[str, Path]:
    """A temp history/ (so the agents store is ours), an empty runs/, an idle loop and a faked spawn."""
    runs = tmp_path / "runs"
    history = tmp_path / "history"
    monkeypatch.setattr(state, "HISTORY_DIR", history)
    monkeypatch.setattr(store, "HISTORY_DIR", history)
    monkeypatch.setattr(state, "RUNS_DIR", runs)
    monkeypatch.setattr(state, "LOOP_SETTINGS_PATH", runs / "loop_settings.json")
    monkeypatch.setattr(state, "RUN_MANIFEST_PATH", runs / "run.json")
    monkeypatch.setattr(loop_ctl, "RUNS_DIR", runs)
    monkeypatch.setattr(loop_ctl, "LOG_PATH", runs / "loop.log")
    monkeypatch.setattr(loop_ctl, "LOOP_SETTINGS_PATH", runs / "loop_settings.json")
    monkeypatch.setattr(loop_ctl, "RUN_MANIFEST_PATH", runs / "run.json")
    monkeypatch.setattr(loop_ctl, "_handle", None)
    monkeypatch.setattr(loop_ctl.subprocess, "Popen", FakeProc)
    for mod in (store,):
        monkeypatch.setattr(mod, "CYCLES_PATH", runs / "cycles.jsonl")
        monkeypatch.setattr(mod, "CONFIGS_DIR", runs / "configs")
        monkeypatch.setattr(mod, "REGRESSION_PATH", runs / "regression.json")
        monkeypatch.setattr(mod, "RUN_MANIFEST_PATH", runs / "run.json")
        monkeypatch.setattr(mod, "STATUS_LOG_PATH", runs / "status_log.jsonl")
        monkeypatch.setattr(mod, "STATUS_PATH", runs / "status.json")
    monkeypatch.setenv("ANTIBODY_IGNORE_EXTERNAL_LOOP", "1")
    monkeypatch.delenv("ANTIBODY_LOOP_CMD", raising=False)
    monkeypatch.delenv("ANTIBODY_TARGET", raising=False)
    # No socket probe of 8790 from the tests: whatever is on the developer's machine must not change a result.
    monkeypatch.setattr(example_agent, "port_answers", lambda: False)
    monkeypatch.setattr(example_agent, "_proc", None)
    monkeypatch.setattr(example_agent, "RUNS_DIR", runs)
    monkeypatch.setattr(example_agent, "LOG_PATH", runs / "example_agent.log")
    monkeypatch.setattr(example_agent, "PID_PATH", runs / "example_agent.pid")
    return {"runs": runs, "history": history}


@pytest.fixture
def client(world: dict[str, Path], monkeypatch: pytest.MonkeyPatch) -> TestClient:
    from api.main import app

    monkeypatch.delenv("WANDB_API_KEY", raising=False)
    return TestClient(app)


# --- the store --------------------------------------------------------------------------------------


def test_list_starts_with_the_two_synthetic_rows(world: dict[str, Path]) -> None:
    rows = agents.list_agents()
    assert [r["id"] for r in rows] == ["builtin", "example"]
    builtin, example = rows
    assert builtin["transport"] == "in-process" and builtin["url"] is None and builtin["synthetic"]
    assert [t["name"] for t in builtin["tools"]] == ["lookup_order", "issue_refund", "send_email", "read_ticket", "set_ticket_status"]
    assert example["url"] == "http://127.0.0.1:8790" and example["running"] is False and example["synthetic"]
    assert not (world["history"] / "agents.json").exists(), "synthetic rows are never stored"


def test_add_round_trips_through_the_file(world: dict[str, Path]) -> None:
    row = agents.add_agent("  My   agent ", "http://127.0.0.1:9999/")
    assert row["name"] == "My agent" and row["url"] == "http://127.0.0.1:9999"
    assert row["transport"] == "http" and row["last_ping"] is None and row["tools"] is None and row["synthetic"] is False
    assert len(row["id"]) >= 8 and row["id"] not in agents.RESERVED_IDS
    on_disk = json.loads((world["history"] / "agents.json").read_text())
    assert on_disk == [{k: v for k, v in row.items() if k != "synthetic"}]
    assert agents.list_agents()[2] == row
    assert agents.get_agent(row["id"]) == row
    assert not list(world["history"].glob(".agents-*")), "no temp file left behind"


@pytest.mark.parametrize(
    "url",
    ["ftp://x", "127.0.0.1:9999", "", "http://a b", "http://" + "x" * 2100, "http://", "https://", "http://h/x?y=1", "http://h/x#frag"],
)
def test_add_rejects_bad_urls(world: dict[str, Path], url: str) -> None:
    with pytest.raises(ValueError):
        agents.add_agent("x", url)


def test_bad_url_is_400_on_the_route(client: TestClient) -> None:
    for url in ("http://", "http://h/x?y=1"):
        assert client.post("/api/agents", json={"name": "x", "url": url}).status_code == 400


def test_add_rejects_empty_name(world: dict[str, Path]) -> None:
    with pytest.raises(ValueError):
        agents.add_agent("   ", "http://127.0.0.1:9999")


def test_dedupe_is_by_canonical_target_among_stored_rows(world: dict[str, Path]) -> None:
    agents.add_agent("a", "http://127.0.0.1:9999")
    with pytest.raises(agents.Duplicate):
        agents.add_agent("b", "http://127.0.0.1:9999/")
    # The example agent's URL may be connected under a name of your own; the join then prefers that row.
    mine = agents.add_agent("c", "http://127.0.0.1:8790")
    assert agents.agent_for_target("http://127.0.0.1:8790") == {"id": mine["id"], "name": "c"}


def test_delete_removes_only_stored_rows(world: dict[str, Path]) -> None:
    a = agents.add_agent("a", "http://127.0.0.1:9991")
    b = agents.add_agent("b", "http://127.0.0.1:9992")
    agents.delete_agent(a["id"])
    assert [r["id"] for r in agents.list_agents()] == ["builtin", "example", b["id"]]
    for bad in ("builtin", "example", a["id"], "nope"):
        with pytest.raises(LookupError):
            agents.delete_agent(bad)


def test_unreadable_store_reads_as_empty(world: dict[str, Path], client: TestClient) -> None:
    world["history"].mkdir()
    (world["history"] / "agents.json").write_text("{not json")
    assert [r["id"] for r in agents.list_agents()] == ["builtin", "example"]
    (world["history"] / "agents.json").write_text(json.dumps([{"id": 1}, "x", {"id": "ok", "url": "http://h", "name": "n"}]))
    assert [r["id"] for r in agents.list_agents()] == ["builtin", "example", "ok"]
    # A hand-edited row whose URL resolves to nothing is skipped, not raised: the runs list must not 500.
    (world["history"] / "agents.json").write_text(json.dumps([{"id": "bad", "url": "gopher://x", "name": "n"}]))
    assert [r["id"] for r in agents.list_agents()] == ["builtin", "example"]
    assert client.get("/api/runs").status_code == 200


# --- resolving and joining --------------------------------------------------------------------------


def test_resolve_agent_gives_the_canonical_target(world: dict[str, Path], monkeypatch: pytest.MonkeyPatch) -> None:
    row = agents.add_agent("a", "http://127.0.0.1:9999")
    assert agents.resolve_agent("builtin") == "builtin"
    assert agents.resolve_agent("example") == "http:http://127.0.0.1:8790"
    assert agents.resolve_agent(row["id"]) == "http:http://127.0.0.1:9999"
    # None is the API process's own default, whatever the env says, normalised.
    assert agents.resolve_agent(None) == "builtin"
    monkeypatch.setenv("ANTIBODY_TARGET", "http://127.0.0.1:9999")
    assert agents.resolve_agent(None) == "http:http://127.0.0.1:9999"
    with pytest.raises(ValueError):
        agents.resolve_agent("nope")


def test_agent_for_target_joins_bare_and_canonical_forms(world: dict[str, Path]) -> None:
    row = agents.add_agent("Mine", "http://127.0.0.1:9999")
    mine = {"id": row["id"], "name": "Mine"}
    assert agents.agent_for_target("http://127.0.0.1:9999") == mine
    assert agents.agent_for_target("http:http://127.0.0.1:9999") == mine
    assert agents.agent_for_target("http:127.0.0.1:9999") == mine
    assert agents.agent_for_target("http://127.0.0.1:9999/") == mine
    assert agents.agent_for_target("builtin")["id"] == "builtin"
    assert agents.agent_for_target(None)["id"] == "builtin"
    assert agents.agent_for_target("")["id"] == "builtin"
    assert agents.agent_for_target("http://127.0.0.1:8790")["id"] == "example"
    # Textual normalisation only: `localhost` and `127.0.0.1` are different agents to Antibody.
    assert agents.agent_for_target("http://localhost:8790") is None
    assert agents.agent_for_target("http://127.0.0.1:1") is None
    assert agents.agent_for_target("garbage") is None


def test_runs_rows_name_their_agent(world: dict[str, Path], client: TestClient) -> None:
    row = agents.add_agent("Mine", "http://127.0.0.1:9999")
    flat_run(world["history"] / "bare", manifest={"world": "mock", "target": "http://127.0.0.1:9999", "flags": []})
    flat_run(world["history"] / "canon", manifest={"world": "mock", "target": "http:http://127.0.0.1:9999", "flags": []})
    flat_run(world["history"] / "legacy")
    flat_run(world["history"] / "gone", manifest={"world": "mock", "target": "http://127.0.0.1:1", "flags": []})
    by_id = {r["id"]: r["agent"] for r in client.get("/api/runs").json()}
    assert by_id["bare"] == by_id["canon"] == {"id": row["id"], "name": "Mine"}
    assert by_id["legacy"]["id"] == "builtin" and by_id["golden"]["id"] == "builtin"
    assert by_id["gone"] is None
    assert client.get("/api/runs/bare").json()["agent"] == {"id": row["id"], "name": "Mine"}


# --- ping -------------------------------------------------------------------------------------------


def _stored(world: dict[str, Path], agent_id: str) -> dict:
    return next(r for r in json.loads((world["history"] / "agents.json").read_text()) if r["id"] == agent_id)


def test_ping_ok_with_tools_maps_them_and_records_nothing_but_the_ping(world: dict[str, Path]) -> None:
    fake = FakeAgent(tools=[*FIVE_TOOLS, {"name": "send_sms", "description": "texts"}])
    try:
        row = agents.add_agent("a", fake.url)
        out = agents.ping(row)
    finally:
        fake.close()
    assert out["ok"] is True and out["latency_ms"] >= 0
    assert out["reply_preview"].startswith("Hi owen@example.com, I could not reach my tools")
    assert [t["name"] for t in out["tools"]] == [t["name"] for t in FIVE_TOOLS] + ["send_sms"]
    assert out["mapping"] == {"known": [t["name"] for t in FIVE_TOOLS], "unknown": ["send_sms"]}
    # What the agent saw: the hello, a fresh session id, the demo customer, and a tools_url nobody serves.
    (seen,) = fake.received
    assert seen["message"] == agents.HELLO_MESSAGE and len(seen["session_id"]) >= 16
    assert (seen["customer_id"], seen["customer_email"]) == ("cust_owen", "owen@example.com")
    assert seen["tools_url"] == "http://127.0.0.1:8765"
    stored = _stored(world, row["id"])
    assert stored["last_ping"]["ok"] is True and "at" in stored["last_ping"] and stored["tools"] == out["tools"]
    assert not (world["runs"] / "cycles.jsonl").exists() and not world["runs"].exists()


def test_ping_ok_without_tools_route(world: dict[str, Path], fake_agent: FakeAgent) -> None:
    row = agents.add_agent("a", fake_agent.url)
    out = agents.ping(row)
    assert out["ok"] is True and out["tools"] is None and out["mapping"] is None
    assert _stored(world, row["id"])["tools"] is None


def test_ping_refused(world: dict[str, Path]) -> None:
    closed = FakeAgent()
    closed.close()
    row = agents.add_agent("a", closed.url)
    out = agents.ping(row)
    assert out["ok"] is False and out["error"].startswith("connection failed") and "reply_preview" not in out
    assert out["tools"] is None and out["mapping"] is None
    assert _stored(world, row["id"])["last_ping"]["ok"] is False


def test_ping_http_error_names_the_status(world: dict[str, Path]) -> None:
    broken = FakeAgent(status=500, tools=FIVE_TOOLS)
    try:
        out = agents.ping(agents.add_agent("a", broken.url))
    finally:
        broken.close()
    assert out["ok"] is False and out["error"].startswith("agent answered HTTP 500")
    # No tool listing after a failed hello, even though this agent would have answered it.
    assert out["tools"] is None


def test_ping_timeout(world: dict[str, Path], monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(agents, "PING_TIMEOUT_S", 0.3)
    slow = FakeAgent(delay=1.5)
    try:
        out = agents.ping(agents.add_agent("a", slow.url))
    finally:
        slow.close()
    assert out["ok"] is False and out["error"] == "timed out after 0s" and out["latency_ms"] < 1500


def test_ping_non_json_and_no_reply_field(world: dict[str, Path]) -> None:
    for raw, expected in ((b"<html>hi</html>", "did not answer with JSON"), (b'{"answer": "hi"}', "returned no reply")):
        fake = FakeAgent(raw_reply=raw)
        try:
            out = agents.ping(agents.add_agent(raw.decode()[:5], fake.url))
        finally:
            fake.close()
        assert out["ok"] is False and expected in out["error"]


def test_ping_builtin_is_always_ok(world: dict[str, Path]) -> None:
    out = agents.ping(agents.get_agent("builtin"))
    assert out["ok"] is True and out["mapping"]["unknown"] == [] and len(out["mapping"]["known"]) == 5


# --- routes -----------------------------------------------------------------------------------------


def test_agent_routes(client: TestClient, fake_agent: FakeAgent) -> None:
    assert [a["id"] for a in client.get("/api/agents").json()] == ["builtin", "example"]
    r = client.post("/api/agents", json={"name": "x", "url": fake_agent.url})
    assert r.status_code == 201, r.text
    row = r.json()
    assert client.post("/api/agents", json={"name": "y", "url": fake_agent.url + "/"}).status_code == 409
    assert client.post("/api/agents", json={"name": "y", "url": "nope"}).status_code == 400
    assert client.post("/api/agents", json={"name": "y"}).status_code == 422
    ping = client.post(f"/api/agents/{row['id']}/ping")
    assert ping.status_code == 200 and ping.json()["ok"] is True
    assert client.post("/api/agents/nope/ping").status_code == 404
    listed = {a["id"]: a for a in client.get("/api/agents").json()}
    assert listed[row["id"]]["last_ping"]["ok"] is True
    assert client.delete(f"/api/agents/{row['id']}").status_code == 204
    assert client.delete(f"/api/agents/{row['id']}").status_code == 404
    assert client.delete("/api/agents/builtin").status_code == 404
    assert client.delete("/api/agents/example").status_code == 404


def test_delete_is_409_while_a_loop_runs(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    row = client.post("/api/agents", json={"name": "x", "url": "http://127.0.0.1:9999"}).json()
    monkeypatch.setattr(loop_ctl, "state", lambda: {**loop_ctl.IDLE, "running": True, "pid": 1, "external": True})
    assert client.delete(f"/api/agents/{row['id']}").status_code == 409
    assert agents.get_agent(row["id"]) is not None


def test_example_start_is_503_without_a_key(client: TestClient) -> None:
    r = client.post("/api/agents/example/start")
    assert r.status_code == 503 and "WANDB_API_KEY" in r.json()["detail"]
    assert client.post("/api/agents/example/stop").status_code == 404


def test_example_start_spawns_in_its_folder_and_409s_when_bound(client: TestClient, world: dict[str, Path], monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("WANDB_API_KEY", "test-not-a-real-key")
    spawned: list[FakeProc] = []

    def spawn(cmd, **kwargs):
        proc = FakeProc(cmd, **kwargs)
        spawned.append(proc)
        return proc

    monkeypatch.setattr(example_agent.subprocess, "Popen", spawn)
    r = client.post("/api/agents/example/start")
    assert r.status_code == 202, r.text
    assert r.json()["running"] is False and r.json()["starting"] is True and r.json()["url"] == "http://127.0.0.1:8790"
    (proc,) = spawned
    assert proc.cmd[-1] == "agent.py" and proc.env["AGENT_PORT"] == "8790"
    assert (world["runs"] / "example_agent.pid").read_text() == "4242"
    assert (world["runs"] / "example_agent.log").read_text().startswith("$ (cd examples/agents/openai_agents_support")
    example = next(a for a in client.get("/api/agents").json() if a["id"] == "example")
    assert example["starting"] is True and example["pid"] == 4242
    # A second start while ours is still coming up, or while anything answers on the port, is a 409.
    assert client.post("/api/agents/example/start").status_code == 409
    monkeypatch.setattr(example_agent, "port_answers", lambda: True)
    monkeypatch.setattr(example_agent, "_proc", None)
    (world["runs"] / "example_agent.pid").unlink()
    assert client.post("/api/agents/example/start").status_code == 409
    stopped = client.post("/api/agents/example/stop")
    assert stopped.status_code == 200 and stopped.json()["owned"] is False and stopped.json()["running"] is True


def test_stale_pid_file_is_never_signalled(world: dict[str, Path], monkeypatch: pytest.MonkeyPatch) -> None:
    """After a reboot the pid in the file can belong to anything; only a session leader running agent.py is ours."""
    import os

    world["runs"].mkdir()
    (world["runs"] / "example_agent.pid").write_text(str(os.getpid()))  # alive, but this test process
    signalled: list[tuple[int, int]] = []
    monkeypatch.setattr(loop_ctl, "_killpg", lambda pid, sig: signalled.append((pid, sig)))
    assert example_agent._owned_pid() is None
    assert not (world["runs"] / "example_agent.pid").exists(), "a pid that is not our child is forgotten"
    with pytest.raises(LookupError):
        example_agent.stop()
    assert signalled == []
    # The check itself: our own pid is not a session leader whose command line names agent.py.
    assert example_agent._looks_like_our_child(os.getpid()) is False
    assert example_agent._looks_like_our_child(2**22) is False


# --- target from the request ------------------------------------------------------------------------


def test_start_sets_the_child_target_explicitly(world: dict[str, Path], monkeypatch: pytest.MonkeyPatch) -> None:
    # An .env naming an external agent must not leak into a run the user pointed at the built-in one.
    monkeypatch.setenv("ANTIBODY_TARGET", "http://127.0.0.1:1")
    out = loop_ctl.start(loop_ctl.LoopStartBody(target="builtin"))
    assert out["target"] == "builtin" and loop_ctl._handle.proc.env["ANTIBODY_TARGET"] == "builtin"
    doc = json.loads((world["runs"] / "loop_settings.json").read_text())
    assert doc["target"] == "builtin" and doc["body"]["target"] == "builtin"
    assert (world["runs"] / "loop.log").read_text().startswith("$ ANTIBODY_TARGET=builtin ")

    monkeypatch.setattr(loop_ctl, "_handle", None)
    row = agents.add_agent("a", "http://127.0.0.1:9999")
    out = loop_ctl.start(loop_ctl.LoopStartBody(target=row["id"]))
    assert out["target"] == loop_ctl._handle.proc.env["ANTIBODY_TARGET"] == "http:http://127.0.0.1:9999"
    assert loop_ctl.state()["settings"]["target"] == row["id"]

    # No target: the API's own default, still set explicitly in the child.
    monkeypatch.setattr(loop_ctl, "_handle", None)
    monkeypatch.delenv("ANTIBODY_TARGET")
    loop_ctl.start(loop_ctl.LoopStartBody())
    assert loop_ctl._handle.proc.env["ANTIBODY_TARGET"] == "builtin"

    with pytest.raises(ValueError):
        loop_ctl.start(loop_ctl.LoopStartBody(target="nope"))


def test_sidecar_is_outdated_by_a_run_against_another_target(world: dict[str, Path], monkeypatch: pytest.MonkeyPatch) -> None:
    body = loop_ctl.LoopStartBody(chaos_cycles=2, target="builtin")
    loop_ctl.start(body)
    loop_ctl._handle.proc.returncode = 0
    monkeypatch.setattr(loop_ctl, "_handle", None)  # the API restarted
    # Same flags, same target in the bare form the loop writes: still ours.
    (world["runs"] / "run.json").write_text(json.dumps({"flags": loop_ctl._flags(body), "target": "builtin"}))
    assert loop_ctl.state()["settings"] == body.model_dump()
    # Same flags, but a terminal run pointed at an external agent: not ours any more.
    (world["runs"] / "run.json").write_text(json.dumps({"flags": loop_ctl._flags(body), "target": "http://127.0.0.1:8790"}))
    assert loop_ctl.state()["settings"] is None
    # Older run.json without a target field: nothing to contradict the sidecar.
    (world["runs"] / "run.json").write_text(json.dumps({"flags": loop_ctl._flags(body)}))
    assert loop_ctl.state()["settings"] == body.model_dump()


def test_unknown_target_is_400_before_the_key_check(client: TestClient) -> None:
    r = client.post("/api/loop/start", json={"target": "nope"})
    assert r.status_code == 400 and r.json()["detail"] == "unknown agent 'nope'"
    assert client.post("/api/loop/start", json={"target": ""}).status_code == 422
    assert client.post("/api/loop/start", json={"target": "builtin"}).status_code == 503


def test_rollback_compares_targets_by_canonical_name(world: dict[str, Path], client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    from api import rollback

    monkeypatch.setattr(state, "CONFIGS_DIR", world["runs"] / "configs")
    monkeypatch.setattr(state, "REGRESSION_PATH", world["runs"] / "regression.json")
    monkeypatch.setattr(loop_ctl, "state", lambda: {**loop_ctl.IDLE})
    flat_run(world["history"] / "ext", manifest={"world": "mock", "target": "http://127.0.0.1:9999", "flags": []})
    assert rollback.same_target("http://127.0.0.1:9999", "http:http://127.0.0.1:9999")
    assert rollback.same_target("builtin", "builtin") and not rollback.same_target("garbage", "builtin")
    assert client.post("/api/rollback", json={"run": "ext", "version": 1}).status_code == 409
    # The API pointed at the same agent in canonical form accepts the run recorded in the bare form.
    monkeypatch.setenv("ANTIBODY_TARGET", "http:http://127.0.0.1:9999")
    assert client.post("/api/rollback", json={"run": "ext", "version": 1}).status_code == 200
