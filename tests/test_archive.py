"""`POST /api/runs/archive` — Clear on the Current run page (docs/plans/08-rework-round-2.md §8).

Run with `uv run --with pytest pytest tests/`. The `runs` fixture from test_loop_ctl relocates every path
the archiver touches, so nothing here moves the developer's real runs/.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from test_loop_ctl import client, runs  # noqa: F401  (fixtures)

from api import loop_ctl, replay
from chaos import state


def _write_run(runs: Path) -> None:
    (runs / "configs").mkdir(parents=True)
    (runs / "configs" / "v0.json").write_text("{}")
    (runs / "cycles.jsonl").write_text('{"cycle": 1}\n')
    (runs / "run.json").write_text('{"target": "builtin"}')


def test_archive_moves_the_run_and_names_the_folder(runs: Path, client: TestClient) -> None:
    _write_run(runs)
    r = client.post("/api/runs/archive")
    assert r.status_code == 200
    name = r.json()["archived"]
    assert name and (state.HISTORY_DIR / name / "cycles.jsonl").exists()
    assert not (runs / "cycles.jsonl").exists() and not (runs / "configs").exists()


def test_archive_on_an_empty_tree_is_null_not_an_error(runs: Path, client: TestClient) -> None:
    assert client.post("/api/runs/archive").json() == {"archived": None}
    _write_run(runs)
    assert client.post("/api/runs/archive").json()["archived"] is not None
    # The second Clear in a row finds nothing to move.
    assert client.post("/api/runs/archive").json() == {"archived": None}


def test_archive_refuses_while_the_loop_runs(runs: Path, client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    _write_run(runs)
    monkeypatch.setattr(loop_ctl, "is_running", lambda: True)
    r = client.post("/api/runs/archive")
    assert r.status_code == 409
    assert (runs / "cycles.jsonl").exists()


def test_archive_stops_a_playing_tape_but_not_when_refused(runs: Path, client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    stops: list[bool] = []
    monkeypatch.setattr(replay, "stop", lambda: (stops.append(True), {"stopped": True})[1])
    _write_run(runs)
    assert client.post("/api/runs/archive").status_code == 200
    assert stops == [True]
    monkeypatch.setattr(loop_ctl, "is_running", lambda: True)
    assert client.post("/api/runs/archive").status_code == 409
    assert stops == [True]
