"""Approval (plan 09 §2): every saved version is pending until a person decides; the certified config is the highest approved.

The loop never reads approvals.json; it is a run file that moves to history/ with the run and is deleted by reset.
"""

from __future__ import annotations

import json
import shutil
from pathlib import Path

import pytest

from api import loop_ctl, store
from chaos import loop, state
from chaos.state import GOLDEN_DIR


@pytest.fixture
def live(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """A live runs/ holding the golden run's configs (v0..v3) and suite, an empty history/, no loop running."""
    runs = tmp_path / "runs"
    runs.mkdir()
    shutil.copytree(GOLDEN_DIR / "runs" / "configs", runs / "configs")
    shutil.copy(GOLDEN_DIR / "runs" / "regression.json", runs / "regression.json")
    shutil.copy(GOLDEN_DIR / "cycles.jsonl", runs / "cycles.jsonl")
    history = tmp_path / "history"
    history.mkdir()
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
    return runs


def _versions(runs: Path) -> list[int]:
    return sorted(int(p.stem[1:]) for p in (runs / "configs").glob("v*.json"))


def test_everything_is_pending_until_someone_decides(client, live):
    r = client.get("/api/approvals")
    assert r.status_code == 200
    body = r.json()
    assert body["certified"] == 0
    assert [d["version"] for d in body["decisions"]] == _versions(live)
    assert {d["status"] for d in body["decisions"]} == {"pending"}
    assert {row["review"] for row in client.get("/api/configs").json()} == {"pending"}


def test_approve_then_reject_round_trips_and_certifies_the_highest_approved(client, live):
    top = _versions(live)[-1]
    r = client.post(f"/api/configs/{top}/review", json={"status": "approved", "note": "looked at the diff"})
    assert r.status_code == 200
    assert r.json()["status"] == "approved" and r.json()["certified"] == top
    assert client.post("/api/configs/1/review", json={"status": "approved"}).json()["certified"] == top
    assert client.post(f"/api/configs/{top}/review", json={"status": "rejected"}).json()["certified"] == 1

    on_disk = json.loads((live / "approvals.json").read_text())
    assert on_disk[str(top)]["status"] == "rejected" and on_disk["1"]["note"] == ""
    rows = {row["version"]: row["review"] for row in client.get("/api/configs").json()}
    assert rows[top] == "rejected" and rows[1] == "approved" and rows[0] == "pending"


def test_rejected_alone_does_not_certify(client, live):
    client.post("/api/configs/2/review", json={"status": "rejected"})
    assert client.get("/api/approvals").json()["certified"] == 0
    assert state.approved_version() == 0


def test_unknown_version_and_bad_status(client, live):
    assert client.post("/api/configs/99/review", json={"status": "approved"}).status_code == 404
    assert client.post("/api/configs/1/review", json={"status": "maybe"}).status_code == 422


def test_approvals_travel_with_the_run_when_it_is_archived(client, live):
    client.post("/api/configs/1/review", json={"status": "approved"})
    archived = state.archive_previous_run()
    assert archived is not None
    assert (archived / "approvals.json").exists() and not (live / "approvals.json").exists()
    run_id = archived.name
    assert client.get(f"/api/approvals?source=run:{run_id}").json()["certified"] == 1
    # The live tree is empty again: reads fall back to the golden run, where nothing is certified either.
    after = client.get("/api/approvals").json()
    assert after["certified"] == 0 and {d["status"] for d in after["decisions"]} <= {"pending"}


def test_check_approved_picks_the_certified_version(live):
    assert loop.check_config(None, approved=True).version == 0
    state.review(2, "approved")
    assert loop.check_config(None, approved=True).version == 2
    assert loop.check_config(None).version == _versions(live)[-1]


def test_torn_file_reads_as_no_decisions(live):
    (live / "approvals.json").write_text('{"1": "yes", "x": {"status": "approved"}, "2": {"status": "later"}}')
    assert state.load_approvals() == {}
