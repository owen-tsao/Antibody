"""Loop control: the settings sidecar, body rules, and the guards in chaos.state that keep `reset` safe.

Run with `uv run --with pytest pytest tests/`. Nothing here spawns the loop: `subprocess.Popen` is
replaced with a stand-in, and the layout guard is exercised in a child interpreter because it fires
at import time.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from api import loop_ctl
from chaos import state
from chaos.state import ROOT


class FakeProc:
    def __init__(self, cmd, **_):
        self.cmd = cmd
        self.pid = 4242
        self.returncode = None

    def poll(self):
        return self.returncode


@pytest.fixture
def runs(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Relocate every path the API and the archiver touch, and fake the spawn."""
    runs = tmp_path / "runs"
    monkeypatch.setattr(state, "RUNS_DIR", runs)
    monkeypatch.setattr(state, "CONFIGS_DIR", runs / "configs")
    monkeypatch.setattr(state, "REGRESSION_PATH", runs / "regression.json")
    monkeypatch.setattr(state, "CYCLES_PATH", runs / "cycles.jsonl")
    monkeypatch.setattr(state, "RUN_MANIFEST_PATH", runs / "run.json")
    monkeypatch.setattr(state, "LOOP_SETTINGS_PATH", runs / "loop_settings.json")
    monkeypatch.setattr(state, "HISTORY_DIR", tmp_path / "history")
    monkeypatch.setattr(state, "_LEGACY_ARCHIVE_DIR", runs / "archive")
    monkeypatch.setattr(loop_ctl, "RUNS_DIR", runs)
    monkeypatch.setattr(loop_ctl, "LOG_PATH", runs / "loop.log")
    monkeypatch.setattr(loop_ctl, "LOOP_SETTINGS_PATH", runs / "loop_settings.json")
    monkeypatch.setattr(loop_ctl, "RUN_MANIFEST_PATH", runs / "run.json")
    monkeypatch.setattr(loop_ctl, "_handle", None)
    monkeypatch.setattr(loop_ctl.subprocess, "Popen", FakeProc)
    monkeypatch.setenv("ANTIBODY_IGNORE_EXTERNAL_LOOP", "1")
    monkeypatch.delenv("ANTIBODY_LOOP_CMD", raising=False)
    return runs


@pytest.fixture
def client(monkeypatch: pytest.MonkeyPatch) -> TestClient:
    from api.main import app

    monkeypatch.delenv("WANDB_API_KEY", raising=False)
    return TestClient(app)


# --- the sidecar ------------------------------------------------------------------------------------


def test_start_writes_sidecar_and_reports_the_body(runs: Path) -> None:
    body = loop_ctl.LoopStartBody(chaos_cycles=2, seeds=1, until_quiet=2)
    out = loop_ctl.start(body)
    doc = json.loads((runs / "loop_settings.json").read_text())
    assert doc["body"] == body.model_dump() == out["settings"]
    assert doc["pid"] == 4242 and doc["started_at"] == out["started_at"]
    flags = loop_ctl._flags(body)
    assert doc["cmd"][-len(flags) :] == flags and "chaos.loop" in doc["cmd"]
    # The `$` line is still there for a person reading the log.
    assert (runs / "loop.log").read_text().startswith("$ ")
    # While the child runs, state() answers from memory; after it exits, from the sidecar.
    assert loop_ctl.state()["settings"] == body.model_dump()
    loop_ctl._handle.proc.returncode = 0
    assert loop_ctl.state()["settings"] == body.model_dump()


def test_failed_spawn_leaves_no_sidecar(runs: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    def boom(*_, **__):
        raise OSError("no such executable")

    monkeypatch.setattr(loop_ctl.subprocess, "Popen", boom)
    with pytest.raises(OSError):
        loop_ctl.start(loop_ctl.LoopStartBody())
    assert not (runs / "loop_settings.json").exists()
    assert loop_ctl.state()["settings"] is None


def test_settings_survive_a_restart_but_not_a_hand_started_run(runs: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    body = loop_ctl.LoopStartBody(chaos_cycles=1, seeds=0)
    loop_ctl.start(body)
    monkeypatch.setattr(loop_ctl, "_handle", None)  # the API restarted
    assert loop_ctl.state()["settings"] == body.model_dump()
    # The loop's own run.json says the run on disk was started with other flags: not our settings.
    (runs / "run.json").write_text(json.dumps({"flags": ["--seeds", "2"]}))
    assert loop_ctl.state()["settings"] is None
    (runs / "run.json").write_text(json.dumps({"flags": loop_ctl._flags(body)}))
    assert loop_ctl.state()["settings"] == body.model_dump()


def test_settings_null_while_an_external_loop_runs(runs: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    loop_ctl.start(loop_ctl.LoopStartBody())
    monkeypatch.setattr(loop_ctl, "_handle", None)
    monkeypatch.setattr(loop_ctl, "external_pid", lambda: 999)
    st = loop_ctl.state()
    assert st["external"] is True and st["settings"] is None


def test_loop_cmd_override_reports_the_body_on_both_routes(runs: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ANTIBODY_LOOP_CMD", "sleep 30")
    body = loop_ctl.LoopStartBody(chaos_cycles=1)
    posted = loop_ctl.start(body)["settings"]
    assert posted == body.model_dump()
    loop_ctl._handle.proc.returncode = 0
    assert loop_ctl.state()["settings"] == posted
    assert json.loads((runs / "loop_settings.json").read_text())["cmd"] == ["sleep", "30"]


def test_archive_and_reset_take_the_sidecar_along(runs: Path, capsys: pytest.CaptureFixture[str]) -> None:
    loop_ctl.start(loop_ctl.LoopStartBody())
    archived = state.archive_previous_run()
    assert archived is not None and (archived / "loop_settings.json").exists()
    assert not (runs / "loop_settings.json").exists()
    loop_ctl._handle.proc.returncode = 0
    loop_ctl.start(loop_ctl.LoopStartBody())
    state.reset()
    assert not runs.exists()
    out = capsys.readouterr().out
    assert f"reset: removed {runs}" in out


# --- body rules and the routes' 400s ----------------------------------------------------------------


@pytest.mark.parametrize(
    ("body", "message"),
    [
        ({"chaos_cycles": 0, "seeds": 0}, "nothing to run"),
        ({"chaos_cycles": 1, "until_quiet": 5}, "until_quiet cannot exceed chaos_cycles"),
        ({"chaos_cycles": 0, "seeds": 1, "until_quiet": 1}, "until_quiet cannot exceed chaos_cycles"),
    ],
)
def test_body_rules_are_400_before_the_key_check(client: TestClient, body: dict, message: str) -> None:
    r = client.post("/api/loop/start", json=body)
    assert r.status_code == 400 and r.json()["detail"].startswith(message)


def test_out_of_range_fields_stay_422(client: TestClient) -> None:
    assert client.post("/api/loop/start", json={"chaos_cycles": 99}).status_code == 422


def test_resume_with_nothing_saved_is_400(client: TestClient, runs: Path) -> None:
    r = client.post("/api/loop/start", json={"resume": True})
    assert r.status_code == 400 and r.json()["detail"].startswith("nothing to resume")


def test_valid_body_without_key_is_503(client: TestClient, runs: Path) -> None:
    r = client.post("/api/loop/start", json={"chaos_cycles": 1})
    assert r.status_code == 503 and "restart the API" in r.json()["detail"]


def test_health_golden_needs_the_phase_log(client: TestClient) -> None:
    assert client.get("/api/health").json()["golden_exists"] is True


# --- chaos.state: layout guard, migration, reset ------------------------------------------------------


def _import_state(**env: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, "-c", "import chaos.state"],
        cwd=ROOT,
        env={**os.environ, **env},
        capture_output=True,
        text=True,
        timeout=60,
    )


@pytest.mark.parametrize(
    "env",
    [
        {"ANTIBODY_RUNS_DIR": str(ROOT)},
        {"ANTIBODY_RUNS_DIR": "/"},
        {"ANTIBODY_RUNS_DIR": "{tmp}/runs", "ANTIBODY_HISTORY_DIR": "{tmp}/runs/history"},
        {"ANTIBODY_RUNS_DIR": "{tmp}/runs", "ANTIBODY_HISTORY_DIR": "{tmp}/runs"},
    ],
)
def test_import_refuses_layouts_reset_could_destroy(tmp_path: Path, env: dict[str, str]) -> None:
    r = _import_state(**{k: v.format(tmp=tmp_path) for k, v in env.items()})
    assert r.returncode != 0
    assert "refusing to start" in r.stderr


def test_import_accepts_a_sane_relocation(tmp_path: Path) -> None:
    r = _import_state(ANTIBODY_RUNS_DIR=str(tmp_path / "runs"), ANTIBODY_HISTORY_DIR=str(tmp_path / "history"))
    assert r.returncode == 0, r.stderr


def test_migration_moves_whole_folders_and_removes_only_a_stray_filled_archive(runs: Path) -> None:
    archive = runs / "archive"
    (archive / "20260101T000000Z").mkdir(parents=True)
    (archive / "20260101T000000Z" / "cycles.jsonl").write_text("{}\n")
    (archive / ".DS_Store").write_bytes(b"")
    assert state._migrate_legacy_archive() == 1
    assert (state.HISTORY_DIR / "20260101T000000Z" / "cycles.jsonl").exists()
    assert not archive.exists()
    assert not list(state.HISTORY_DIR.glob(".incoming-*"))


def test_migration_keeps_an_archive_with_unknown_leftovers(runs: Path, capsys: pytest.CaptureFixture[str]) -> None:
    archive = runs / "archive"
    archive.mkdir(parents=True)
    (archive / "notes.txt").write_text("keep me")
    assert state._migrate_legacy_archive() == 0
    assert (archive / "notes.txt").exists()
    assert "notes.txt" in capsys.readouterr().out


def test_migration_never_follows_symlinks(runs: Path, tmp_path: Path) -> None:
    outside = tmp_path / "outside"
    (outside / "real-run").mkdir(parents=True)
    runs.mkdir()
    (runs / "archive").symlink_to(outside)
    assert state._migrate_legacy_archive() == 0
    assert (outside / "real-run").exists() and (runs / "archive").is_symlink()


def test_failed_cross_device_copy_leaves_source_and_no_partial_dest(runs: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    src = runs / "archive" / "r1"
    src.mkdir(parents=True)
    (src / "a.json").write_text("{}")
    dest = state.HISTORY_DIR / "r1"
    state.HISTORY_DIR.mkdir()

    def cross_device(*_):
        raise OSError(18, "Cross-device link")

    def half_copy(s, d, **_):
        Path(d).mkdir()
        (Path(d) / "a.json").write_text("{")
        raise OSError("disk full")

    monkeypatch.setattr(state.os, "rename", cross_device)
    monkeypatch.setattr(state.shutil, "copytree", half_copy)
    with pytest.raises(OSError, match="disk full"):
        state._move_dir_complete(src, dest)
    assert (src / "a.json").exists()
    assert not dest.exists() and not list(state.HISTORY_DIR.iterdir())


def test_reset_says_what_it_kept(runs: Path, capsys: pytest.CaptureFixture[str]) -> None:
    # A legacy folder whose name history/ already has cannot be migrated, so reset must leave it alone.
    (runs / "archive" / "dup").mkdir(parents=True)
    (state.HISTORY_DIR / "dup").mkdir(parents=True)
    (runs / "status.json").write_text("{}")
    state.reset()
    assert (runs / "archive" / "dup").is_dir() and not (runs / "status.json").exists()
    out = capsys.readouterr().out
    assert f"except {'archive'}/" in out and f"reset: removed {runs}\n" not in out
