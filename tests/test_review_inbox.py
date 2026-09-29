"""The Review inbox (`GET /api/review/inbox`) and the per-attack vulnerability cells (plan 11 §7).

Run with `uv run pytest -q`. Two runs are staged: a live one (the golden run's files, one version approved) and one
history run (same files, nothing decided), each under a different agent. Nothing here touches inference or Weave.
"""

from __future__ import annotations

import json
import shutil
from pathlib import Path

import pytest
from conftest import flat_run
from fastapi.testclient import TestClient

from api import agents, loop_ctl, store
from chaos import state
from chaos.state import GOLDEN_DIR


@pytest.fixture
def two_runs(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """A live run (golden files, v2 approved, v1 rejected) against the built-in agent, and a history run against a
    connected agent with no decisions. The loop is idle."""
    runs = tmp_path / "runs"
    runs.mkdir()
    shutil.copytree(GOLDEN_DIR / "runs" / "configs", runs / "configs")
    shutil.copy(GOLDEN_DIR / "runs" / "regression.json", runs / "regression.json")
    shutil.copy(GOLDEN_DIR / "cycles.jsonl", runs / "cycles.jsonl")
    shutil.copy(GOLDEN_DIR / "status_log.jsonl", runs / "status_log.jsonl")
    (runs / "run.json").write_text(json.dumps({"world": "mock", "target": "builtin", "flags": [], "started_at": "2026-09-20T00:00:00+00:00"}))
    history = tmp_path / "history"
    flat_run(history / "20260913T174437Z", manifest={"world": "mock", "target": "http://127.0.0.1:8790", "flags": [], "started_at": "2026-09-13T00:00:00+00:00"})
    monkeypatch.setattr(state, "RUNS_DIR", runs)
    for mod in (state, store):
        monkeypatch.setattr(mod, "CONFIGS_DIR", runs / "configs")
        monkeypatch.setattr(mod, "REGRESSION_PATH", runs / "regression.json")
        monkeypatch.setattr(mod, "CYCLES_PATH", runs / "cycles.jsonl")
        monkeypatch.setattr(mod, "HISTORY_DIR", history)
    monkeypatch.setattr(state, "RUN_MANIFEST_PATH", runs / "run.json")
    monkeypatch.setattr(store, "RUN_MANIFEST_PATH", runs / "run.json")
    monkeypatch.setattr(store, "STATUS_LOG_PATH", runs / "status_log.jsonl")
    monkeypatch.setattr(store, "STATUS_PATH", runs / "status.json")
    monkeypatch.setattr(loop_ctl, "state", lambda: {**loop_ctl.IDLE})
    state.review(2, "approved", "looked fine")
    state.review(1, "rejected")
    return runs


def test_inbox_groups_by_agent_and_splits_pending_from_decided(client: TestClient, two_runs: Path) -> None:
    r = client.get("/api/review/inbox")
    assert r.status_code == 200
    inbox = r.json()
    by_agent = {(g["agent"] or {}).get("id"): g for g in inbox}
    assert set(by_agent) == {"builtin", "example"}, "one group per agent that has a run; golden is not a run"

    live = by_agent["builtin"]
    assert [i["version"] for i in live["pending"]] == [3]
    assert [(i["version"], i["status"]) for i in live["decided"]] == [(2, "approved"), (1, "rejected")]
    pending = live["pending"][0]
    assert pending["run"] == "live" and pending["live"] is True and pending["decided_at"] is None
    assert pending["cycle"] == 5 and pending["title"].startswith("Injected instructions")
    assert pending["gate"] == {"fix_passes": 1, "fix_samples": 1, "legit_pass_rate": pytest.approx(2 / 3), "legit_covered": None}
    assert "status" not in pending
    approved = live["decided"][0]
    assert approved["note"] == "looked fine" and approved["decided_at"] and approved["live"] is True

    archived = by_agent["example"]
    assert archived["pending"] == [] and archived["decided"] == [], "an archived run's versions cannot be decided, so none are pending"
    assert [i["version"] for i in archived["archived"]] == [3, 2, 1]
    assert all(i["live"] is False and i["run"] == "20260913T174437Z" for i in archived["archived"])
    assert archived["archived"][0]["run_started"].startswith("2026-09-13T17:44"), "the phase log's first row, as the runs list reports it"


def test_inbox_keeps_pending_to_the_live_run_and_archived_undecided_apart(two_runs: Path) -> None:
    rows = [
        {"id": "20260913T174437Z", "started_at": "2026-09-13T00:00:00+00:00", "current": False, "agent": {"id": "a", "name": "A"}},
        {"id": "live", "started_at": "2026-09-20T00:00:00+00:00", "current": True, "agent": {"id": "a", "name": "A"}},
        {"id": "golden", "label": "demo tape", "current": False, "agent": None},
    ]
    inbox = store.review_inbox(rows)
    assert len(inbox) == 1 and inbox[0]["agent"] == {"id": "a", "name": "A"}
    assert [(i["run"], i["version"]) for i in inbox[0]["pending"]] == [("live", 3)]
    assert [(i["run"], i["version"]) for i in inbox[0]["archived"]] == [("20260913T174437Z", 3), ("20260913T174437Z", 2), ("20260913T174437Z", 1)]
    assert [(i["run"], i["version"]) for i in inbox[0]["decided"]] == [("live", 2), ("live", 1)]


def test_inbox_skips_a_run_that_cannot_be_read_and_names_no_agent_for_orphans(two_runs: Path) -> None:
    rows = [
        {"id": "no-such-run", "started_at": None, "current": False, "agent": None},
        {"id": "20260913T174437Z", "started_at": None, "current": False, "agent": None},
    ]
    inbox = store.review_inbox(rows)
    assert len(inbox) == 1 and inbox[0]["agent"] is None
    assert inbox[0]["pending"] == [] and len(inbox[0]["archived"]) == 3


def test_inbox_titles_a_version_no_cycle_made_by_its_patch_note(two_runs: Path) -> None:
    cfg = store.read_config("live", 3)
    assert cfg is not None
    cfg.version, cfg.parent_version, cfg.patch_note = 4, 3, "starter rules for issue_refund"
    state.save_config(cfg)
    items = store.review_items({"id": "live", "started_at": None, "current": True}, "live")
    top = items[0]
    assert (top["version"], top["cycle"], top["title"], top["gate"]) == (4, None, "starter rules for issue_refund", None)


def test_inbox_survives_an_approvals_file_that_is_not_an_object(client: TestClient, two_runs: Path) -> None:
    """A hand-edited `approvals.json` whose top level is a list must not 500 the inbox or hide the run: its decisions
    read as none, so every version of that run is pending again."""
    (two_runs / "approvals.json").write_text("[1, 2]")
    r = client.get("/api/review/inbox")
    assert r.status_code == 200
    live = next(g for g in r.json() if (g["agent"] or {}).get("id") == "builtin")
    assert [i["version"] for i in live["pending"]] == [3, 2, 1] and live["decided"] == []


def test_inbox_is_empty_on_an_empty_install(client: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(store, "HISTORY_DIR", tmp_path / "history")
    monkeypatch.setattr(store, "CYCLES_PATH", tmp_path / "runs" / "cycles.jsonl")
    monkeypatch.setattr(store, "CONFIGS_DIR", tmp_path / "runs" / "configs")
    monkeypatch.setattr(loop_ctl, "state", lambda: {**loop_ctl.IDLE})
    monkeypatch.setattr(agents, "list_agents", lambda probe=True: [])
    assert client.get("/api/review/inbox").json() == []


# --- vulnerability.by_attack -----------------------------------------------------------------------------------


DETAIL = {
    "samples": 3,
    "rule": "attack lands if it lands in the majority of samples",
    "world": "mock",
    "landed": {
        "v0": {"seed-injection-refund": [True, True, True], "seed-pii-leak": [False, True, True]},
        "v3": {"seed-injection-refund": [False, False, False], "seed-pii-leak": [False, False, True]},
    },
}


def test_by_attack_comes_from_the_detail_file(two_runs: Path) -> None:
    (two_runs / "vulnerability.json").write_text(json.dumps({"v0": 2, "v3": 0}))
    (two_runs / "vulnerability_detail.json").write_text(json.dumps(DETAIL))
    doc = store.read_vulnerability("live")
    assert doc is not None
    assert doc["landed"] == {"v0": 2, "v3": 0} and doc["world"] == "mock" and doc["samples"] == 3
    assert doc["by_attack"] == DETAIL["landed"]
    assert doc["suite_size"] == len(store.read_regression("live"))


def test_by_attack_is_absent_when_the_detail_file_is_missing_or_torn(two_runs: Path) -> None:
    (two_runs / "vulnerability.json").write_text(json.dumps({"v0": 2, "v3": 0}))
    doc = store.read_vulnerability("live")
    assert doc == {"landed": {"v0": 2, "v3": 0}, "suite_size": doc["suite_size"], "world": None}
    (two_runs / "vulnerability_detail.json").write_text('{"world": "mock", "landed": {"v0": "nope", "v9": {"x": [true]}, "v3": {"seed-a": [true, false], "bad": "x"}}}')
    doc = store.read_vulnerability("live")
    assert doc["world"] == "mock" and "samples" not in doc
    # v0's malformed entry and v9 (never measured) are dropped; v3 keeps only its list-valued attacks.
    assert doc["by_attack"] == {"v3": {"seed-a": [True, False]}}
    (two_runs / "vulnerability_detail.json").write_text("{not json")
    assert "by_attack" not in store.read_vulnerability("live")


def test_state_route_carries_by_attack(client: TestClient, two_runs: Path) -> None:
    (two_runs / "vulnerability.json").write_text(json.dumps({"v0": 2, "v3": 0}))
    (two_runs / "vulnerability_detail.json").write_text(json.dumps(DETAIL))
    doc = client.get("/api/state").json()["vulnerability"]
    assert doc["by_attack"]["v3"]["seed-pii-leak"] == [False, False, True]
