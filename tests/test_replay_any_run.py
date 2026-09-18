"""Replay any past run, not only golden (docs/plans/02, B1 second half).

Run with `uv run --with pytest pytest tests/`. The history fixture is a copy of the golden run in the
flat archive shape, so no inference and no live loop. Every test clears the module session so a tape
left playing by one test cannot leak into the next.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from conftest import GOLDEN_CYCLES, flat_run
from fastapi.testclient import TestClient

from api import loop_ctl, replay, store
from api.main import _read_source

RUN = "20260913T174437Z"
RUN_SRC = f"run:{RUN}"
# A start time no golden row has, so a test can tell the two tapes apart by `recorded_at`.
ARCHIVED_AT = "2026-09-01T00:00:00+00:00"


@pytest.fixture
def history(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    root = tmp_path / "history"
    run = flat_run(root / RUN)
    log = run / "status_log.jsonl"
    rows = [json.loads(line) for line in log.read_text().splitlines() if line.strip()]
    rows[0]["since"] = ARCHIVED_AT
    log.write_text("".join(json.dumps(r) + "\n" for r in rows))
    flat_run(root / "no-log").joinpath("status_log.jsonl").unlink()
    flat_run(root / "no-cycles", cycles=False)
    monkeypatch.setattr(store, "HISTORY_DIR", root)
    return root


@pytest.fixture(autouse=True)
def _quiet(monkeypatch: pytest.MonkeyPatch):
    """No loop is ever running, no session survives a test, and no cached tape from an earlier tmp dir is reused."""
    monkeypatch.setattr(loop_ctl, "state", lambda: {**loop_ctl.IDLE})
    replay._recording_for.cache_clear()
    replay.stop()
    yield
    replay.stop()


# --- loading --------------------------------------------------------------------------------------------


def test_recording_loads_from_a_history_folder(history: Path) -> None:
    rec = replay.recording(RUN_SRC)
    assert rec.source == RUN_SRC and rec.id == RUN
    assert rec.recorded_at == ARCHIVED_AT
    assert len(rec.cycles) == GOLDEN_CYCLES
    assert rec.meta() == {
        "source": RUN_SRC,
        "id": RUN,
        "recorded_at": ARCHIVED_AT,
        "cycles": GOLDEN_CYCLES,
        "duration_s": round(rec.duration_s, 1),
    }


def test_golden_recording_is_unchanged(history: Path) -> None:
    rec = replay.recording()
    assert rec.source == "golden" and rec.id == "golden"
    assert rec.recorded_at != ARCHIVED_AT
    assert replay.recording_meta()["source"] == "golden"


def test_cache_is_per_recording(history: Path) -> None:
    assert replay.recording(RUN_SRC) is not replay.recording("golden")
    assert replay.recording(RUN_SRC) is replay.recording(RUN_SRC)


@pytest.mark.parametrize("run", ["no-log", "no-cycles"])
def test_folder_without_a_tape_is_refused(history: Path, run: str) -> None:
    with pytest.raises(FileNotFoundError):
        replay.recording(f"run:{run}")
    assert replay.recording_meta(f"run:{run}") is None


# --- routes ---------------------------------------------------------------------------------------------


def test_start_run_recording_reports_which_tape(client: TestClient, history: Path) -> None:
    r = client.post("/api/replay/start", params={"speed": 20, "recording": RUN_SRC})
    assert r.status_code == 201
    started = r.json()
    assert started["active"] is True
    assert started["recording"]["source"] == RUN_SRC and started["recording"]["id"] == RUN
    assert started["recorded_at"] == ARCHIVED_AT

    info = client.get("/api/replay").json()
    assert info["active"] is True and info["recording"]["source"] == RUN_SRC
    assert info["recorded_at"] == ARCHIVED_AT and info["recording"]["recorded_at"] == ARCHIVED_AT
    assert info["cycles"] == GOLDEN_CYCLES
    # Every field the shipped UI reads is still there.
    assert {"active", "recording", "paused", "ended", "recorded_at", "duration_s", "cycles", "speed", "started_at", "elapsed_s"} <= set(info)
    assert {"recorded_at", "cycles", "duration_s"} <= set(info["recording"])


def test_start_defaults_to_golden(client: TestClient, history: Path) -> None:
    r = client.post("/api/replay/start", params={"speed": 20})
    assert r.status_code == 201
    assert r.json()["recording"]["source"] == "golden"
    assert client.get("/api/replay").json()["recording"]["id"] == "golden"


def test_idle_info_describes_golden(client: TestClient, history: Path) -> None:
    info = client.get("/api/replay").json()
    assert info["active"] is False and info["recording"]["source"] == "golden"


@pytest.mark.parametrize(
    ("recording", "code"),
    [("run:nope", 404), ("run:no-log", 400), ("run:no-cycles", 400), ("run:../x", 400), ("live", 400), ("bogus", 400), ("run:" + "A" * 300, 400)],
)
def test_start_rejects_bad_recordings(client: TestClient, history: Path, recording: str, code: int) -> None:
    r = client.post("/api/replay/start", params={"recording": recording})
    assert r.status_code == code
    assert client.get("/api/replay").json()["active"] is False


def test_live_reads_follow_the_replayed_run(client: TestClient, history: Path) -> None:
    client.post("/api/replay/start", params={"speed": 20, "recording": RUN_SRC})
    assert _read_source("live") == RUN_SRC
    # A run asked for by name is served as asked, whatever is playing.
    assert _read_source(RUN_SRC) == RUN_SRC
    assert _read_source("golden") == "golden"

    state = client.get("/api/state").json()
    assert state["source"] == "replay" and state["recorded_at"] == ARCHIVED_AT
    assert client.get("/api/configs").json() == client.get("/api/configs", params={"source": RUN_SRC}).json()
    # Seek to the end: every one of the run's cycles is visible through the plain live route.
    client.post("/api/replay/seek", params={"t": 10**9})
    assert len(client.get("/api/cycles").json()) == GOLDEN_CYCLES
    status = client.get("/api/status").json()
    assert status["replay"] is True and status["recorded_at"] == ARCHIVED_AT


def test_live_reads_follow_golden_by_default(client: TestClient, history: Path) -> None:
    client.post("/api/replay/start", params={"speed": 20})
    assert _read_source("live") == "golden"
    assert client.get("/api/state").json()["recorded_at"] != ARCHIVED_AT


def test_stop_returns_reads_to_files(client: TestClient, history: Path) -> None:
    client.post("/api/replay/start", params={"recording": RUN_SRC})
    assert client.post("/api/replay/stop").json()["stopped"] is True
    assert _read_source("live") in ("live", "golden")
    assert client.get("/api/replay").json()["active"] is False


def test_second_start_while_playing_is_409(client: TestClient, history: Path) -> None:
    client.post("/api/replay/start", params={"recording": RUN_SRC})
    r = client.post("/api/replay/start")
    assert r.status_code == 409 and r.json()["detail"]["reason"] == "replay_active"
    # The refusal names the tape that is still playing, not the one that was asked for.
    assert r.json()["detail"]["recording"]["source"] == RUN_SRC
