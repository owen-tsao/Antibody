"""Run manifests, `GET /api/runs`, and `run:<id>` as a read source (docs/plans/02, B1).

Run with `uv run --with pytest pytest tests/` — pytest is not a project dependency, so it is pulled in
for the run only. Fixtures are built from the committed golden run, so no inference and no live loop.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from conftest import GOLDEN_CYCLES, flat_run
from fastapi.testclient import TestClient

from api import loop_ctl, store
from chaos import state

LONG_ID = "A" * 300


@pytest.fixture
def history(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """A history folder of known runs, plus a live runs/ that is empty and a loop that is idle.

    The live paths and `loop_ctl.state` are patched so no test here reads the developer's real runs/ or
    runs `pgrep`/`lsof`: what `/api/state` and `/api/runs` return must not depend on the checkout.
    """
    root = tmp_path / "history"
    flat_run(root / "20260913T174437Z")
    flat_run(
        root / "manifested-run_2",
        manifest={
            "world": "zendesk",
            "target": "http://localhost:8790",
            "flags": ["--seeds", "1"],
            "started_at": "2026-09-13T00:00:00+00:00",
            # Stale derived fields a future writer might leave behind; they must be ignored.
            "cycles": 99,
            "final_version": 42,
        },
    )
    flat_run(root / "aborted-before-cycle-1", cycles=False)
    (root / "bad.name").mkdir()
    monkeypatch.setattr(store, "HISTORY_DIR", root)
    runs = tmp_path / "runs"
    monkeypatch.setattr(store, "CYCLES_PATH", runs / "cycles.jsonl")
    monkeypatch.setattr(store, "CONFIGS_DIR", runs / "configs")
    monkeypatch.setattr(store, "REGRESSION_PATH", runs / "regression.json")
    monkeypatch.setattr(store, "RUN_MANIFEST_PATH", runs / "run.json")
    monkeypatch.setattr(store, "STATUS_LOG_PATH", runs / "status_log.jsonl")
    monkeypatch.setattr(store, "STATUS_PATH", runs / "status.json")
    monkeypatch.setattr(loop_ctl, "state", lambda: {**loop_ctl.IDLE})
    return root


# --- id validation ---------------------------------------------------------------------------------


@pytest.mark.parametrize("bad", ["../../etc", "a/b", "x.y", "", ".", "..", "a b", "run:x", LONG_ID])
def test_parse_source_rejects_malformed_ids(history: Path, bad: str) -> None:
    with pytest.raises(ValueError):
        store.parse_source(f"run:{bad}")


def test_run_id_accepts_names_up_to_the_cap() -> None:
    assert store.RUN_ID.fullmatch("A" * 128) and not store.RUN_ID.fullmatch("A" * 129)


def test_parse_source_rejects_unknown_source_words(history: Path) -> None:
    with pytest.raises(ValueError):
        store.parse_source("bogus")


def test_parse_source_unknown_run_is_lookup_error(history: Path) -> None:
    with pytest.raises(LookupError):
        store.parse_source("run:nope")


def test_parse_source_accepts_existing_runs(history: Path) -> None:
    assert store.parse_source("run:20260913T174437Z") == "run:20260913T174437Z"
    assert store.parse_source("live") == "live"
    assert store.parse_source("golden") == "golden"


def test_run_dir_refuses_symlink_out_of_history(history: Path, tmp_path: Path) -> None:
    outside = tmp_path / "outside"
    outside.mkdir()
    (history / "escape").symlink_to(outside)
    with pytest.raises(ValueError):
        store.run_dir("escape")


def test_run_paths_stay_inside_history(history: Path) -> None:
    paths = store.run_paths("run:20260913T174437Z")
    for p in paths:
        assert p.resolve().is_relative_to(history.resolve())
    # Flat shape: configs and regression sit next to cycles, not under runs/.
    assert paths.configs == history / "20260913T174437Z" / "configs"
    assert paths.regression == history / "20260913T174437Z" / "regression.json"


# --- manifests --------------------------------------------------------------------------------------


def test_legacy_archive_gets_synthesized_manifest(history: Path) -> None:
    m = store.run_manifest("run:20260913T174437Z")
    assert m is not None
    assert m["id"] == "20260913T174437Z"
    assert m["synthesized"] is True
    assert (m["world"], m["target"], m["flags"]) == ("mock", "builtin", [])
    assert m["cycles"] == GOLDEN_CYCLES
    assert m["versions"] == [0, 1, 2, 3] and m["final_version"] == 3
    assert m["accepted"] + m["rejected"] <= m["cycles"]
    first_row = json.loads((history / "20260913T174437Z" / "status_log.jsonl").read_text().splitlines()[0])
    assert m["started_at"] == first_row["since"]
    assert m["finished_at"] is not None and m["finished_at"] >= m["started_at"]


def test_run_json_supplies_only_what_the_process_knew(history: Path) -> None:
    m = store.run_manifest("run:manifested-run_2")
    assert m is not None
    assert m["synthesized"] is False
    assert (m["world"], m["target"], m["flags"]) == ("zendesk", "http://localhost:8790", ["--seeds", "1"])
    # Derived fields come from the files, never from the stored document.
    assert m["cycles"] == GOLDEN_CYCLES and m["final_version"] == 3
    # The phase log's first row wins over the stored start time.
    assert m["started_at"] != "2026-09-13T00:00:00+00:00"


def test_history_hides_empty_and_unreachable_runs(history: Path) -> None:
    ids = [m["id"] for m in store.history_runs()]
    assert "aborted-before-cycle-1" not in ids
    assert "bad.name" not in ids
    assert set(ids) == {"20260913T174437Z", "manifested-run_2"}


def test_history_list_survives_planted_symlinks(history: Path, tmp_path: Path, client: TestClient) -> None:
    """A symlink out of history/ (which `run_dir` refuses) or to a sibling run must not 500 the list or duplicate a row."""
    outside = flat_run(tmp_path / "outside" / "elsewhere")
    (history / "escape").symlink_to(outside)
    (history / "alias").symlink_to(history / "20260913T174437Z")
    ids = [m["id"] for m in store.history_runs()]
    assert ids.count("20260913T174437Z") == 1
    assert set(ids) == {"20260913T174437Z", "manifested-run_2"}
    r = client.get("/api/runs")
    assert r.status_code == 200
    assert {row["id"] for row in r.json()} == {"20260913T174437Z", "manifested-run_2", "golden"}


def test_history_list_skips_a_folder_that_vanishes_mid_read(history: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    real = store.run_manifest

    def flaky(source: str):
        if source.endswith("manifested-run_2"):
            raise OSError("gone")
        return real(source)

    monkeypatch.setattr(store, "run_manifest", flaky)
    assert [m["id"] for m in store.history_runs()] == ["20260913T174437Z"]


def test_newest_first_puts_undated_runs_last() -> None:
    rows = [
        {"id": "a", "started_at": None},
        {"id": "b", "started_at": "2026-09-13T10:00:00+00:00"},
        {"id": "c", "started_at": "2026-09-14T10:00:00+00:00"},
    ]
    assert [r["id"] for r in store.newest_first(rows)] == ["c", "b", "a"]


def test_run_manifest_none_when_nothing_there(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    root = tmp_path / "history"
    (root / "empty").mkdir(parents=True)
    monkeypatch.setattr(store, "HISTORY_DIR", root)
    assert store.run_manifest("run:empty") is None


# --- the loop side: writing and archiving run.json ----------------------------------------------------


def test_write_run_manifest_moves_with_the_archive(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    runs = tmp_path / "runs"
    history = tmp_path / "history"
    monkeypatch.setattr(state, "RUNS_DIR", runs)
    monkeypatch.setattr(state, "CONFIGS_DIR", runs / "configs")
    monkeypatch.setattr(state, "REGRESSION_PATH", runs / "regression.json")
    monkeypatch.setattr(state, "CYCLES_PATH", runs / "cycles.jsonl")
    monkeypatch.setattr(state, "RUN_MANIFEST_PATH", runs / "run.json")
    monkeypatch.setattr(state, "HISTORY_DIR", history)
    monkeypatch.setattr(state, "_LEGACY_ARCHIVE_DIR", runs / "archive")

    path = state.write_run_manifest(world="mock", target="builtin", flags=["--chaos-cycles", "1"])
    doc = json.loads(path.read_text())
    assert doc["world"] == "mock" and doc["flags"] == ["--chaos-cycles", "1"] and "started_at" in doc
    assert not {"cycles", "versions", "final_version"} & doc.keys()

    archived = state.archive_previous_run()
    assert archived is not None and archived.parent == history
    assert (archived / "run.json").exists() and not path.exists()


# --- routes -----------------------------------------------------------------------------------------


def test_runs_list_shape(client: TestClient, history: Path) -> None:
    rows = client.get("/api/runs").json()
    ids = [r["id"] for r in rows]
    assert "golden" in ids and "20260913T174437Z" in ids and "manifested-run_2" in ids
    assert "aborted-before-cycle-1" not in ids
    golden = next(r for r in rows if r["id"] == "golden")
    assert golden["label"] == "demo tape" and golden["current"] is False
    keys = {
        "id", "label", "current", "started_at", "finished_at", "world", "target", "agent", "cycles",
        "accepted", "rejected", "versions", "final_version", "flags", "synthesized",
    }
    assert all(set(r) == keys for r in rows)
    dated = [r["started_at"] for r in rows if not r["current"] and r["started_at"]]
    assert dated == sorted(dated, reverse=True)


def test_run_detail_has_configs(client: TestClient, history: Path) -> None:
    doc = client.get("/api/runs/manifested-run_2").json()
    assert doc["world"] == "zendesk"
    assert [c["version"] for c in doc["configs"]] == [0, 1, 2, 3]
    assert {"version", "parent_version", "patch_note"} == set(doc["configs"][0])
    assert client.get("/api/runs/golden").json()["label"] == "demo tape"


@pytest.mark.parametrize(
    ("run_id", "code"),
    # An encoded slash never reaches the handler: the router decodes it and finds no route.
    [("nope", 404), ("bad.name", 400), ("a%2Fb", 404), (LONG_ID, 400)],
)
def test_run_detail_errors(client: TestClient, history: Path, run_id: str, code: int) -> None:
    assert client.get(f"/api/runs/{run_id}").status_code == code


def test_live_row_reads_the_patched_runs_dir(client: TestClient, history: Path, tmp_path: Path) -> None:
    """The list shows the live run only once it has a cycle, and it reads the runs/ this test controls."""
    assert not any(r["current"] for r in client.get("/api/runs").json())
    live = tmp_path / "runs"
    live.mkdir()
    (live / "cycles.jsonl").write_text((history / "20260913T174437Z" / "cycles.jsonl").read_text())
    rows = client.get("/api/runs").json()
    assert rows[0]["current"] is True and rows[0]["id"] == "live" and rows[0]["cycles"] == GOLDEN_CYCLES


@pytest.mark.parametrize("route", ["/api/cycles", "/api/configs", "/api/configs/0", "/api/regression", "/api/state"])
def test_read_routes_accept_run_source(client: TestClient, history: Path, route: str) -> None:
    r = client.get(route, params={"source": "run:20260913T174437Z"})
    assert r.status_code == 200
    if route == "/api/cycles":
        assert len(r.json()) == GOLDEN_CYCLES
    if route == "/api/state":
        assert r.json()["source"] == "run:20260913T174437Z"


@pytest.mark.parametrize("route", ["/api/cycles", "/api/configs", "/api/configs/0", "/api/regression", "/api/state"])
@pytest.mark.parametrize(
    ("source", "code"),
    [("run:../../etc", 400), ("run:nope", 404), ("run:bad.name", 400), ("run:", 400), ("bogus", 400), (f"run:{LONG_ID}", 400)],
)
def test_read_routes_reject_bad_sources(client: TestClient, history: Path, route: str, source: str, code: int) -> None:
    assert client.get(route, params={"source": source}).status_code == code


def test_live_and_golden_sources_unchanged(client: TestClient, history: Path) -> None:
    assert client.get("/api/cycles", params={"source": "golden"}).status_code == 200
    # The patched live runs/ is empty, so `live` falls back to golden (nothing depends on the checkout).
    live = client.get("/api/state", params={"source": "live"}).json()
    assert live["source"] == "golden" and live["loop"]["running"] is False
