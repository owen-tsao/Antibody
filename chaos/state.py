"""On-disk state so runs survive restarts and the demo can replay from any config version.

Layout:
    runs/configs/v{n}.json   every accepted AgentConfig, one file per version
    runs/regression.json     the captured regression suite (scenarios)
    cycles.jsonl             append-only cycle log read by the dashboard
    history/<timestamp>/     every previous run, moved there whole before a fresh run starts
    data/golden/             a committed clean run used as the demo fallback

`ANTIBODY_RUNS_DIR` relocates runs/ *and* cycles.jsonl (which then lives inside that directory);
`ANTIBODY_HISTORY_DIR` relocates history/. `history/` sits outside `runs/` on purpose: `reset` wipes
`runs/` and must never be able to delete past runs. Older checkouts kept them under `runs/archive/`;
`_migrate_legacy_archive` moves those into `history/` the first time a run or reset would touch them.
"""

from __future__ import annotations

import json
import os
import shutil
from pathlib import Path

from chaos.config import ROOT
from chaos.schemas import AgentConfig, Scenario

_runs_override = os.environ.get("ANTIBODY_RUNS_DIR")
RUNS_DIR = Path(_runs_override).expanduser().resolve() if _runs_override else ROOT / "runs"
CONFIGS_DIR = RUNS_DIR / "configs"
REGRESSION_PATH = RUNS_DIR / "regression.json"
CYCLES_PATH = RUNS_DIR / "cycles.jsonl" if _runs_override else ROOT / "cycles.jsonl"
_history_override = os.environ.get("ANTIBODY_HISTORY_DIR")
HISTORY_DIR = Path(_history_override).expanduser().resolve() if _history_override else ROOT / "history"
GOLDEN_DIR = ROOT / "data" / "golden"
_LEGACY_ARCHIVE_DIR = RUNS_DIR / "archive"


def save_config(cfg: AgentConfig) -> Path:
    CONFIGS_DIR.mkdir(parents=True, exist_ok=True)
    path = CONFIGS_DIR / f"v{cfg.version}.json"
    path.write_text(cfg.model_dump_json(indent=2))
    return path


def load_config(version: int) -> AgentConfig:
    path = CONFIGS_DIR / f"v{version}.json"
    if not path.exists():
        raise FileNotFoundError(f"no saved config v{version} at {path}; run the loop first or use --from-version 0")
    return AgentConfig.model_validate_json(path.read_text())


def latest_version() -> int | None:
    if not CONFIGS_DIR.exists():
        return None
    versions = [int(p.stem[1:]) for p in CONFIGS_DIR.glob("v*.json") if p.stem[1:].isdigit()]
    return max(versions) if versions else None


def save_regression(scenarios: list[Scenario]) -> None:
    RUNS_DIR.mkdir(parents=True, exist_ok=True)
    REGRESSION_PATH.write_text(json.dumps([s.model_dump() for s in scenarios], indent=2))


def load_regression() -> list[Scenario]:
    if not REGRESSION_PATH.exists():
        return []
    return [Scenario(**row) for row in json.loads(REGRESSION_PATH.read_text())]


def _migrate_legacy_archive() -> int:
    """Move `runs/archive/*` (the pre-history/ location) into HISTORY_DIR. Returns how many moved.

    Runs before anything that could delete or repopulate runs/, so a `reset` on an old checkout keeps
    every past run. Folders whose name already exists in history/ are left in place rather than merged.
    """
    if not _LEGACY_ARCHIVE_DIR.is_dir():
        return 0
    moved = 0
    for child in sorted(_LEGACY_ARCHIVE_DIR.iterdir()):
        if not child.is_dir():
            continue
        dest = HISTORY_DIR / child.name
        if dest.exists():
            print(f"history: {dest} already exists; leaving {child} in place")
            continue
        HISTORY_DIR.mkdir(parents=True, exist_ok=True)
        shutil.move(str(child), str(dest))
        moved += 1
    if not any(_LEGACY_ARCHIVE_DIR.iterdir()):
        _LEGACY_ARCHIVE_DIR.rmdir()
    if moved:
        print(f"history: moved {moved} archived run(s) from {_LEGACY_ARCHIVE_DIR} to {HISTORY_DIR}")
    return moved


def reset() -> None:
    """Wipe the current run's state. Explicit command; never happens implicitly on start. history/ is untouched."""
    _migrate_legacy_archive()
    if CYCLES_PATH.exists():
        CYCLES_PATH.unlink()
    if RUNS_DIR.is_dir():
        if _LEGACY_ARCHIVE_DIR.exists():
            # Only reachable when a legacy folder collided with one already in history/. Never delete it.
            print(f"reset: keeping {_LEGACY_ARCHIVE_DIR} (could not be migrated); move it by hand")
            for child in RUNS_DIR.iterdir():
                if child != _LEGACY_ARCHIVE_DIR:
                    shutil.rmtree(child) if child.is_dir() else child.unlink()
        else:
            shutil.rmtree(RUNS_DIR)
    print(f"reset: removed {RUNS_DIR} and {CYCLES_PATH}")


def archive_previous_run() -> Path | None:
    """Move the previous run's configs, suite, cycle log and phase log out of the way before a fresh run.

    A fresh run starts at v0 and cycle 1 again. Writing its v1, v2, ... over the previous run's files would
    silently change what every earlier cycle record points at, so the old run is kept whole under
    history/<timestamp>/ instead. Returns the archive path, or None if there was nothing to move.
    """
    from datetime import datetime, timezone

    _migrate_legacy_archive()
    # status.json goes too: a fresh run must not begin with the previous run's last phase on screen.
    movable = [CONFIGS_DIR, REGRESSION_PATH, CYCLES_PATH, RUNS_DIR / "status.json", RUNS_DIR / "status_log.jsonl", RUNS_DIR / "vulnerability.json", RUNS_DIR / "vulnerability_detail.json"]
    present = [p for p in movable if p.exists()]
    if not present:
        return None
    dest = HISTORY_DIR / datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    dest.mkdir(parents=True)
    for p in present:
        shutil.move(str(p), str(dest / p.name))
    return dest


def snapshot_golden() -> None:
    """Copy the current run into data/golden/ so a known-good run is committed for demo fallback."""
    _migrate_legacy_archive()
    if GOLDEN_DIR.exists():
        shutil.rmtree(GOLDEN_DIR)
    GOLDEN_DIR.mkdir(parents=True)
    if CYCLES_PATH.exists():
        shutil.copy(CYCLES_PATH, GOLDEN_DIR / "cycles.jsonl")
    if RUNS_DIR.exists():
        shutil.copytree(RUNS_DIR, GOLDEN_DIR / "runs", ignore=shutil.ignore_patterns("loop.log"))
        # The recorded phase transitions are what replay plays back; the frontend reads them at top level.
        log = RUNS_DIR / "status_log.jsonl"
        if log.exists():
            shutil.copy(log, GOLDEN_DIR / "status_log.jsonl")
    print(f"golden: snapshot written to {GOLDEN_DIR}")
