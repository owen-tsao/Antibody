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


def test_sidecar_stays_through_archive_and_goes_with_reset(runs: Path, capsys: pytest.CaptureFixture[str]) -> None:
    """The API writes the sidecar seconds before the child archives the *previous* run; archiving it
    would file it under that run and leave `GET /api/loop.settings` null forever after."""
    body = loop_ctl.LoopStartBody(chaos_cycles=2)
    loop_ctl.start(body)
    (runs / "run.json").write_text(json.dumps({"flags": ["--seeds", "1"]}))  # the previous run's
    archived = state.archive_previous_run()
    assert archived is not None and (archived / "run.json").exists()
    assert not (archived / "loop_settings.json").exists()
    assert (runs / "loop_settings.json").exists()
    # The child now writes its own run.json; the sidecar describes this run, so the settings hold.
    (runs / "run.json").write_text(json.dumps({"flags": loop_ctl._flags(body)}))
    loop_ctl._handle.proc.returncode = 0
    assert loop_ctl.state()["settings"] == body.model_dump()
    state.reset()
    assert not runs.exists() and loop_ctl.state()["settings"] is None
    assert f"reset: removed {runs}" in capsys.readouterr().out


def test_terminal_run_after_an_api_run_outdates_the_sidecar(runs: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """A terminal-started run archives the API run but leaves the sidecar; its run.json is what catches that."""
    body = loop_ctl.LoopStartBody(chaos_cycles=2, seeds=1)
    loop_ctl.start(body)
    (runs / "run.json").write_text(json.dumps({"flags": loop_ctl._flags(body)}))
    loop_ctl._handle.proc.returncode = 0
    monkeypatch.setattr(loop_ctl, "_handle", None)  # the API restarted
    assert loop_ctl.state()["settings"] == body.model_dump()
    # `chaos.loop run --seeds 3` from a shell: archives ours, writes its own run.json.
    assert state.archive_previous_run() is not None
    assert (runs / "loop_settings.json").exists()
    (runs / "run.json").write_text(json.dumps({"flags": ["--chaos-cycles", "3", "--repair-attempts", "3", "--seeds", "3"]}))
    assert loop_ctl.state()["settings"] is None
    # The next API start overwrites the sidecar and the settings are honest again.
    other = loop_ctl.LoopStartBody(seeds=0, chaos_cycles=1)
    loop_ctl.start(other)
    (runs / "run.json").write_text(json.dumps({"flags": loop_ctl._flags(other)}))
    loop_ctl._handle.proc.returncode = 0
    assert loop_ctl.state()["settings"] == other.model_dump()


def test_a_sidecar_from_before_the_vulnerability_flag_still_matches_its_run(runs: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Upgrade path: the body on disk has no `vulnerability` key and the run.json has no `--vulnerability`."""
    body = loop_ctl.LoopStartBody(chaos_cycles=2, seeds=1)
    loop_ctl.start(body)
    loop_ctl._handle.proc.returncode = 0
    monkeypatch.setattr(loop_ctl, "_handle", None)
    doc = json.loads((runs / "loop_settings.json").read_text())
    del doc["body"]["vulnerability"]
    (runs / "loop_settings.json").write_text(json.dumps(doc))
    (runs / "run.json").write_text(json.dumps({"flags": [f for f in loop_ctl._flags(body) if f != "--vulnerability"]}))
    assert loop_ctl.state()["settings"] == body.model_dump()
    # Other flags still count: a terminal run with different cycles outdates the sidecar.
    (runs / "run.json").write_text(json.dumps({"flags": ["--chaos-cycles", "9", "--repair-attempts", "3", "--seeds", "1"]}))
    assert loop_ctl.state()["settings"] is None


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


def test_value_error_400_is_scoped_to_the_loop_start_body() -> None:
    """The same rule error on another route, or outside the body, keeps FastAPI's 422 envelope."""
    import asyncio

    from fastapi.exceptions import RequestValidationError
    from fastapi import Request

    from api.main import _body_rules_are_400s

    def respond(path: str, loc: tuple) -> int:
        scope = {"type": "http", "method": "POST", "path": path, "headers": [], "query_string": b""}
        exc = RequestValidationError([{"type": "value_error", "loc": loc, "msg": "Value error, nothing to run", "input": {}}])
        return asyncio.run(_body_rules_are_400s(Request(scope), exc)).status_code

    assert respond("/api/loop/start", ("body",)) == 400
    assert respond("/api/loop/start", ("body", "chaos_cycles")) == 400
    assert respond("/api/loop/start", ("query", "speed")) == 422
    assert respond("/api/rollback", ("body",)) == 422
    assert respond("/api/replay/start", ("query", "recording")) == 422


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


def test_reset_refuses_a_folder_that_is_not_a_runs_dir(runs: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """`ANTIBODY_RUNS_DIR=~/Documents` passes the import guard; `reset` is the command that would empty it."""
    runs.mkdir()
    (runs / "thesis.docx").write_bytes(b"years of work")
    (runs / "photos").mkdir()
    (runs / ".DS_Store").write_bytes(b"")
    with pytest.raises(SystemExit, match="does not look like an Antibody runs dir"):
        state.reset()
    assert (runs / "thesis.docx").exists() and (runs / "photos").is_dir()
    # Any one of the loop's or the API's files makes it ours again.
    (runs / "loop.log").write_text("$ uv run ...\n")
    state.reset()
    assert not runs.exists()


@pytest.mark.parametrize("marker", ["configs", "status.json", "run.json", "loop.log"])
def test_reset_recognises_each_runs_dir_marker(runs: Path, marker: str) -> None:
    runs.mkdir()
    (runs / "stray.txt").write_text("")
    (runs / marker).mkdir() if marker == "configs" else (runs / marker).write_text("")
    state.reset()
    assert not runs.exists()


def test_reset_of_an_empty_or_absent_runs_dir_is_fine(runs: Path) -> None:
    state.reset()
    runs.mkdir()
    state.reset()
    assert not runs.exists()


def test_migration_finishes_an_interrupted_move(runs: Path, capsys: pytest.CaptureFixture[str]) -> None:
    """Crash between `rename(src, staging)` and `replace(staging, dest)`: the run is whole under
    `.incoming-<name>` and `src` is gone. It must get its name back, never be deleted."""
    state.HISTORY_DIR.mkdir()
    orphan = state.HISTORY_DIR / ".incoming-20260102T000000Z"
    orphan.mkdir()
    (orphan / "cycles.jsonl").write_text("{}\n")
    # No archive/ at all: the source dir went with the rename, and reset removed the rest.
    assert state._migrate_legacy_archive() == 0
    assert (state.HISTORY_DIR / "20260102T000000Z" / "cycles.jsonl").exists()
    assert not orphan.exists()
    assert "recovered" in capsys.readouterr().out


def test_migration_does_not_finalize_a_half_copy_whose_source_still_exists(runs: Path) -> None:
    """A staging dir next to a live src is a partial cross-device copy: redo it from src, do not promote it."""
    src = runs / "archive" / "r1"
    src.mkdir(parents=True)
    (src / "a.json").write_text('{"whole": true}')
    state.HISTORY_DIR.mkdir()
    staging = state.HISTORY_DIR / ".incoming-r1"
    staging.mkdir()
    (staging / "a.json").write_text("{")
    assert state._migrate_legacy_archive() == 1
    assert (state.HISTORY_DIR / "r1" / "a.json").read_text() == '{"whole": true}'
    assert not staging.exists() and not src.exists()


def test_migration_never_promotes_over_an_existing_run(runs: Path) -> None:
    state.HISTORY_DIR.mkdir()
    (state.HISTORY_DIR / "r2").mkdir()
    (state.HISTORY_DIR / "r2" / "cycles.jsonl").write_text("real\n")
    staging = state.HISTORY_DIR / ".incoming-r2"
    staging.mkdir()
    (staging / "cycles.jsonl").write_text("orphan\n")
    state._migrate_legacy_archive()
    assert (state.HISTORY_DIR / "r2" / "cycles.jsonl").read_text() == "real\n"
    assert (staging / "cycles.jsonl").read_text() == "orphan\n"
