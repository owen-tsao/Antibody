"""Rollback: copy a past run's config version in as the next live version and merge its suite (docs/plans/02, B1).

Run with `uv run --with pytest pytest tests/`. `runs/` is a temp dir here, so nothing under the checkout's
runs/ is ever written; the history folder is a copy of the golden run in the flat archive shape.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from conftest import flat_run
from fastapi.testclient import TestClient

from api import loop_ctl, rollback, store
from chaos import state
from chaos.schemas import AgentConfig, Scenario

RUN = "20260913T174437Z"
EXTERNAL = "against-external-target"


def _scenario(sid: str, title: str = "") -> Scenario:
    return Scenario(
        id=sid,
        kind="prompt_injection_via_tool",
        title=title or sid,
        user_message="hi",
        expected_behavior="refuse",
    )


@pytest.fixture
def world(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> dict[str, Path]:
    """An empty live runs/ next to a history with one built-in run and one made against an external target."""
    runs = tmp_path / "runs"
    history = tmp_path / "history"
    flat_run(history / RUN)
    flat_run(history / EXTERNAL, manifest={"world": "mock", "target": "http://localhost:8790", "flags": []})
    monkeypatch.setattr(state, "RUNS_DIR", runs)
    # store imports these names at import time, so both modules need the patch.
    for mod in (state, store):
        monkeypatch.setattr(mod, "CONFIGS_DIR", runs / "configs")
        monkeypatch.setattr(mod, "REGRESSION_PATH", runs / "regression.json")
        monkeypatch.setattr(mod, "CYCLES_PATH", runs / "cycles.jsonl")
        monkeypatch.setattr(mod, "HISTORY_DIR", history)
    monkeypatch.setattr(loop_ctl, "state", lambda: {**loop_ctl.IDLE})
    monkeypatch.delenv("ANTIBODY_TARGET", raising=False)
    return {"runs": runs, "history": history}


def _live_versions(runs: Path) -> list[int]:
    return sorted(int(p.stem[1:]) for p in (runs / "configs").glob("v*.json"))


def _live_suite_ids(runs: Path) -> set[str]:
    return {s["id"] for s in json.loads((runs / "regression.json").read_text())}


def _run_suite_ids(history: Path, run: str = RUN) -> set[str]:
    return {s["id"] for s in json.loads((history / run / "regression.json").read_text())}


# --- the pure merge ---------------------------------------------------------------------------------------


def test_merge_is_a_union_where_live_wins() -> None:
    live = [_scenario("a", "live a"), _scenario("b")]
    incoming = [_scenario("a", "old a"), _scenario("c")]
    merged, newer = rollback.merge_suites(live, incoming)
    assert [s.id for s in merged] == ["a", "b", "c"]
    assert next(s for s in merged if s.id == "a").title == "live a"
    # `b` is the one test the incoming run never saw.
    assert newer == 1


def test_merge_into_nothing_is_the_incoming_suite() -> None:
    incoming = [_scenario("a"), _scenario("b")]
    merged, newer = rollback.merge_suites([], incoming)
    assert merged == incoming and newer == 0


# --- the operation ------------------------------------------------------------------------------------------


def test_rollback_into_empty_runs_becomes_v0(world: dict[str, Path], client: TestClient) -> None:
    r = client.post("/api/rollback", json={"run": RUN, "version": 1})
    assert r.status_code == 200, r.text
    doc = r.json()
    assert set(doc) == {"config", "newer_tests"}
    cfg = AgentConfig.model_validate(doc["config"])
    assert cfg.version == 0 and cfg.parent_version is None
    assert cfg.patch_note == f"rollback to run {RUN} v1"
    source = store.read_config(f"run:{RUN}", 1)
    assert cfg.system_prompt == source.system_prompt and cfg.guardrail_rules == source.guardrail_rules
    assert _live_versions(world["runs"]) == [0]
    assert state.load_config(0) == cfg
    # No live suite existed, so the run's suite is now the live one and nothing is newer than it.
    assert doc["newer_tests"] == 0
    assert _live_suite_ids(world["runs"]) == _run_suite_ids(world["history"])


def test_rollback_appends_after_the_latest_live_version(world: dict[str, Path], client: TestClient) -> None:
    state.save_config(AgentConfig(version=0, system_prompt="live v0"))
    state.save_config(AgentConfig(version=1, system_prompt="live v1", parent_version=0))
    r = client.post("/api/rollback", json={"run": RUN, "version": 2})
    assert r.status_code == 200
    cfg = r.json()["config"]
    assert cfg["version"] == 2 and cfg["parent_version"] == 1
    assert cfg["patch_note"] == f"rollback to run {RUN} v2"
    assert _live_versions(world["runs"]) == [0, 1, 2]
    # It is a copy: the run's own v2 is untouched and the live list gained a version rather than losing one.
    assert store.read_config(f"run:{RUN}", 2).patch_note != cfg["patch_note"]
    rows = client.get("/api/configs", params={"source": "live"}).json()
    assert rows[-1] == {"version": 2, "parent_version": 1, "patch_note": cfg["patch_note"]}


def test_rollback_twice_keeps_incrementing(world: dict[str, Path], client: TestClient) -> None:
    assert client.post("/api/rollback", json={"run": RUN, "version": 1}).json()["config"]["version"] == 0
    second = client.post("/api/rollback", json={"run": RUN, "version": 3}).json()["config"]
    assert second["version"] == 1 and second["parent_version"] == 0


def test_rollback_merges_suite_live_wins_and_counts_newer(world: dict[str, Path], client: TestClient) -> None:
    run_ids = sorted(_run_suite_ids(world["history"]))
    clash, *_ = run_ids
    state.save_regression([_scenario(clash, "the live copy"), _scenario("newer-1"), _scenario("newer-2")])
    r = client.post("/api/rollback", json={"run": RUN, "version": 0})
    assert r.status_code == 200
    assert r.json()["newer_tests"] == 2
    suite = json.loads((world["runs"] / "regression.json").read_text())
    ids = [s["id"] for s in suite]
    assert set(ids) == set(run_ids) | {"newer-1", "newer-2"}
    assert len(ids) == len(set(ids))
    assert next(s for s in suite if s["id"] == clash)["title"] == "the live copy"
    # Live entries keep their order at the front; the run's new ones follow.
    assert ids[:3] == [clash, "newer-1", "newer-2"]
    assert not (world["runs"] / "regression.json.tmp").exists()


def test_rollback_to_golden(world: dict[str, Path], client: TestClient) -> None:
    r = client.post("/api/rollback", json={"run": "golden", "version": 3})
    assert r.status_code == 200
    assert r.json()["config"]["patch_note"] == "rollback to run golden v3"


# --- refusals -------------------------------------------------------------------------------------------------


def test_rollback_refused_while_loop_runs(world: dict[str, Path], client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(loop_ctl, "state", lambda: {**loop_ctl.IDLE, "running": True, "pid": 4242})
    r = client.post("/api/rollback", json={"run": RUN, "version": 1})
    assert r.status_code == 409 and "loop is running" in r.json()["detail"]
    assert not (world["runs"] / "configs").exists()


def test_rollback_refused_across_targets(world: dict[str, Path], client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    r = client.post("/api/rollback", json={"run": EXTERNAL, "version": 1})
    assert r.status_code == 409
    assert "http://localhost:8790" in r.json()["detail"] and "'builtin'" in r.json()["detail"]
    assert not (world["runs"] / "configs").exists()
    # The same install pointed at that target may take it; and now the built-in run is the foreign one.
    monkeypatch.setenv("ANTIBODY_TARGET", "http://localhost:8790")
    assert client.post("/api/rollback", json={"run": EXTERNAL, "version": 1}).status_code == 200
    assert client.post("/api/rollback", json={"run": RUN, "version": 1}).status_code == 409


@pytest.mark.parametrize(
    ("body", "code"),
    [
        ({"run": "live", "version": 0}, 400),
        ({"run": "../etc", "version": 0}, 400),
        ({"run": "nope", "version": 0}, 404),
        ({"run": RUN, "version": 99}, 404),
        ({"run": RUN, "version": -1}, 422),
        ({"run": RUN}, 422),
    ],
)
def test_rollback_errors(world: dict[str, Path], client: TestClient, body: dict, code: int) -> None:
    r = client.post("/api/rollback", json=body)
    assert r.status_code == code, r.text
    assert not (world["runs"] / "configs").exists()
