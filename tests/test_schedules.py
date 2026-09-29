"""Schedules (plan 09 §6): attack an agent on an interval or when it changes, through the same start path Heal uses."""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from api import agents, example_agent, loop_ctl, schedules, store
from chaos import state
from conftest import FakeAgent

T0 = datetime(2026, 9, 20, 12, 0, tzinfo=timezone.utc)


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
    runs, history = tmp_path / "runs", tmp_path / "history"
    for mod in (state, store):
        monkeypatch.setattr(mod, "HISTORY_DIR", history)
        monkeypatch.setattr(mod, "CONFIGS_DIR", runs / "configs")
        monkeypatch.setattr(mod, "REGRESSION_PATH", runs / "regression.json")
        monkeypatch.setattr(mod, "CYCLES_PATH", runs / "cycles.jsonl")
    monkeypatch.setattr(state, "RUNS_DIR", runs)
    monkeypatch.setattr(state, "LOOP_SETTINGS_PATH", runs / "loop_settings.json")
    monkeypatch.setattr(state, "RUN_MANIFEST_PATH", runs / "run.json")
    monkeypatch.setattr(store, "RUN_MANIFEST_PATH", runs / "run.json")
    monkeypatch.setattr(store, "STATUS_LOG_PATH", runs / "status_log.jsonl")
    monkeypatch.setattr(store, "STATUS_PATH", runs / "status.json")
    for name in ("RUNS_DIR", "LOG_PATH", "LOOP_SETTINGS_PATH", "RUN_MANIFEST_PATH"):
        monkeypatch.setattr(loop_ctl, name, {"RUNS_DIR": runs, "LOG_PATH": runs / "loop.log", "LOOP_SETTINGS_PATH": runs / "loop_settings.json", "RUN_MANIFEST_PATH": runs / "run.json"}[name])
    monkeypatch.setattr(loop_ctl, "_handle", None)
    monkeypatch.setattr(loop_ctl.subprocess, "Popen", FakeProc)
    monkeypatch.setenv("ANTIBODY_IGNORE_EXTERNAL_LOOP", "1")
    monkeypatch.setenv("ANTIBODY_NO_SCHEDULER", "1")
    monkeypatch.setenv("WANDB_API_KEY", "test-key")
    monkeypatch.delenv("ANTIBODY_LOOP_CMD", raising=False)
    monkeypatch.delenv("ANTIBODY_TARGET", raising=False)
    monkeypatch.setattr(example_agent, "port_answers", lambda ex: False)
    return {"runs": runs, "history": history}


@pytest.fixture
def client(world) -> TestClient:
    from api.main import app

    return TestClient(app)


def _interval(agent="builtin", **over) -> dict:
    return {"name": "nightly", "agent": agent, "trigger": {"kind": "interval", "every_minutes": 60}, **over}


def test_crud_and_validation(client: TestClient, world):
    assert client.get("/api/schedules").json() == []
    r = client.post("/api/schedules", json=_interval())
    assert r.status_code == 201, r.text
    row = r.json()
    assert row["agent_name"].startswith("Demo agent") and row["enabled"] is True and row["last_result"] is None
    assert row["next_at"] is not None and row["settings"]["chaos_cycles"] == 3
    sid = row["id"]
    assert json.loads((world["history"] / "schedules.json").read_text())[0]["id"] == sid

    assert client.post("/api/schedules", json=_interval(agent="nope")).status_code == 400
    assert client.post("/api/schedules", json={**_interval(), "trigger": {"kind": "on_change"}}).status_code == 400  # builtin never changes
    assert client.post("/api/schedules", json={**_interval(), "trigger": {"kind": "interval", "every_minutes": 1}}).status_code == 422
    assert client.post("/api/schedules", json={**_interval(), "settings": {"chaos_cycles": 0, "seeds": 0}}).status_code == 422

    r = client.patch(f"/api/schedules/{sid}", json={"name": "  weekly  sweep ", "enabled": False, "settings": {"chaos_cycles": 5}})
    assert r.status_code == 200 and r.json()["name"] == "weekly sweep" and r.json()["enabled"] is False and r.json()["settings"]["chaos_cycles"] == 5
    assert client.patch("/api/schedules/nope", json={"enabled": True}).status_code == 404
    assert client.delete(f"/api/schedules/{sid}").status_code == 204
    assert client.delete(f"/api/schedules/{sid}").status_code == 404
    assert client.get("/api/schedules").json() == []


def test_interval_fires_when_due_and_not_before(world):
    row = schedules.create(schedules.ScheduleBody(**_interval()), now=T0)
    assert schedules.tick(T0 + timedelta(minutes=59)) == []
    touched = schedules.tick(T0 + timedelta(minutes=61))
    assert [t["id"] for t in touched] == [row["id"]]
    after = schedules.get_schedule(row["id"])
    assert after["last_result"]["kind"] == "started" and after["last_run_at"] == (T0 + timedelta(minutes=61)).isoformat(timespec="seconds")
    assert datetime.fromisoformat(after["next_at"]) == T0 + timedelta(minutes=121)
    assert loop_ctl._handle.proc.env["ANTIBODY_TARGET"] == "builtin"
    assert loop_ctl._handle.settings["resume"] is False


def test_only_one_run_at_a_time_and_disabled_rows_are_ignored(world, monkeypatch):
    a = schedules.create(schedules.ScheduleBody(**_interval(name="a")), now=T0)
    b = schedules.create(schedules.ScheduleBody(**_interval(name="b")), now=T0)
    schedules.create(schedules.ScheduleBody(**_interval(name="off", enabled=False)), now=T0)
    later = T0 + timedelta(hours=2)
    touched = schedules.tick(later)
    kinds = {t["name"]: t["last_result"]["kind"] for t in touched}
    assert kinds == {"a": "started", "b": "skipped"}
    assert "already running" in schedules.get_schedule(b["id"])["last_result"]["detail"]
    assert schedules.get_schedule(a["id"])["last_run_at"] is not None and schedules.get_schedule(b["id"])["last_run_at"] is None
    # While the loop runs, nothing else fires; b's next_at is still in the past, so it is retried next tick.
    monkeypatch.setattr(loop_ctl, "_handle", None)
    touched = schedules.tick(later + timedelta(minutes=1))
    assert [t["name"] for t in touched] == ["b"] and touched[0]["last_result"]["kind"] == "started"


def test_keyless_install_records_skipped_not_a_child(world, monkeypatch):
    monkeypatch.delenv("WANDB_API_KEY")
    row = schedules.create(schedules.ScheduleBody(**_interval()), now=T0)
    fired = schedules.fire(row, now=T0)
    assert fired["last_result"]["kind"] == "skipped" and "WANDB_API_KEY" in fired["last_result"]["detail"]
    assert loop_ctl._handle is None and fired["last_run_at"] is None


def test_run_now_route_and_deleted_agent(client: TestClient, world):
    fake = FakeAgent()
    try:
        agent = client.post("/api/agents", json={"name": "Acme", "url": fake.url}).json()
        sid = client.post("/api/schedules", json=_interval(agent=agent["id"])).json()["id"]
        r = client.post(f"/api/schedules/{sid}/run")
        assert r.status_code == 200 and r.json()["last_result"]["kind"] == "started"
        assert loop_ctl._handle.settings["target"] == agent["id"]
        loop_ctl._handle = None
        client.delete(f"/api/agents/{agent['id']}")
        r = client.post(f"/api/schedules/{sid}/run")
        assert r.json()["last_result"]["kind"] == "skipped" and "unknown agent" in r.json()["last_result"]["detail"]
        assert r.json()["agent_name"] is None
        assert client.post("/api/schedules/nope/run").status_code == 404
    finally:
        fake.close()


def test_on_change_fires_only_when_the_fingerprint_moves(world):
    fake = FakeAgent(tools=[{"name": "lookup_order", "description": ""}])
    try:
        agent = agents.add_agent("Acme", fake.url)
        row = schedules.create(schedules.ScheduleBody(name="watch", agent=agent["id"], trigger={"kind": "on_change"}), now=T0)
        assert row["next_at"] is None
        # First tick: a baseline, not a run.
        touched = schedules.tick(T0)
        assert touched[0]["last_fingerprint"] is not None and touched[0]["last_result"]["detail"].startswith("baseline")
        assert loop_ctl._handle is None
        assert schedules.tick(T0 + timedelta(minutes=1)) == []  # unchanged: nothing to record
        fake.tools = [{"name": "lookup_order", "description": ""}, {"name": "issue_refund", "description": "new!"}]
        touched = schedules.tick(T0 + timedelta(minutes=2))
        assert touched[0]["last_result"]["kind"] == "started" and loop_ctl._handle is not None
        after = schedules.get_schedule(row["id"])
        assert after["last_fingerprint"] != row["last_fingerprint"] and after["next_at"] is None
    finally:
        fake.close()


def test_on_change_with_nothing_to_watch_is_skipped(world):
    fake = FakeAgent()  # no /tools, no /version
    try:
        agent = agents.add_agent("Mute", fake.url)
        schedules.create(schedules.ScheduleBody(name="watch", agent=agent["id"], trigger={"kind": "on_change"}), now=T0)
        touched = schedules.tick(T0)
        assert touched[0]["last_result"]["kind"] == "skipped" and "nothing to watch" in touched[0]["last_result"]["detail"]
    finally:
        fake.close()


def test_on_change_keeps_the_change_when_the_run_is_skipped(world, monkeypatch):
    fake = FakeAgent(tools=[{"name": "a", "description": ""}])
    try:
        agent = agents.add_agent("Acme", fake.url)
        row = schedules.create(schedules.ScheduleBody(name="watch", agent=agent["id"], trigger={"kind": "on_change"}), now=T0)
        schedules.tick(T0)  # baseline
        baseline = schedules.get_schedule(row["id"])["last_fingerprint"]
        fake.tools = [{"name": "b", "description": ""}]
        monkeypatch.delenv("WANDB_API_KEY")
        touched = schedules.tick(T0 + timedelta(minutes=1))
        assert touched[0]["last_result"]["kind"] == "skipped"
        assert schedules.get_schedule(row["id"])["last_fingerprint"] == baseline  # the change is not consumed
        monkeypatch.setenv("WANDB_API_KEY", "k")
        touched = schedules.tick(T0 + timedelta(minutes=2))
        assert touched[0]["last_result"]["kind"] == "started" and touched[0]["last_fingerprint"] != baseline
    finally:
        fake.close()


def test_patch_keeps_null_settings(client: TestClient, world):
    sid = client.post("/api/schedules", json=_interval()).json()["id"]
    r = client.patch(f"/api/schedules/{sid}", json={"settings": {"chaos_cycles": 4, "seeds": None, "until_quiet": None}})
    assert r.status_code == 200
    assert r.json()["settings"] == {"chaos_cycles": 4, "seeds": None, "repair_attempts": 3, "second_pass": True, "until_quiet": None, "world": "auto", "vulnerability": True}


def test_daemon_respects_the_kill_switch(world):
    assert schedules.start_daemon() is False
