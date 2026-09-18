"""On-disk state so runs survive restarts and the demo can replay from any config version.

Layout:
    runs/configs/v{n}.json   every accepted AgentConfig, one file per version
    runs/regression.json     the captured regression suite (scenarios)
    runs/run.json            what only the loop process knows about this run (world, target, flags)
    runs/loop_settings.json  the request body the API spawned this run with (absent for a terminal run)
    cycles.jsonl             append-only cycle log read by the dashboard
    history/<timestamp>/     every previous run, moved there whole before a fresh run starts
    data/golden/             a committed clean run used as the demo fallback

`ANTIBODY_RUNS_DIR` relocates runs/ *and* cycles.jsonl (which then lives inside that directory);
`ANTIBODY_HISTORY_DIR` relocates history/. `history/` sits outside `runs/` on purpose: `reset` wipes
`runs/` and must never be able to delete past runs. Older checkouts kept them under `runs/archive/`;
`_migrate_legacy_archive` moves those into `history/` the first time a run or reset would touch them.

Importing this module refuses (SystemExit) a layout where `reset`'s `rmtree(RUNS_DIR)` could take the
repo or history/ with it — `ANTIBODY_RUNS_DIR=.` from the repo root, or a history dir inside runs/.
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
# Two start-of-run documents with different authors, kept apart on purpose. `run.json` is written by
# the loop process and holds what only it knows (world, target, argv). `loop_settings.json` is written
# by the API (api.loop_ctl) when *it* spawns a run and holds the request body it was given; a
# terminal-started run never has one. Both move to history/ with the run and go with `reset`.
RUN_MANIFEST_PATH = RUNS_DIR / "run.json"
LOOP_SETTINGS_PATH = RUNS_DIR / "loop_settings.json"
_history_override = os.environ.get("ANTIBODY_HISTORY_DIR")
HISTORY_DIR = Path(_history_override).expanduser().resolve() if _history_override else ROOT / "history"
GOLDEN_DIR = ROOT / "data" / "golden"
_LEGACY_ARCHIVE_DIR = RUNS_DIR / "archive"
# Files a file manager drops into a folder; an emptied runs/archive holding only these is still empty.
_STRAY_FILES = frozenset({".DS_Store", "Thumbs.db"})


def _refuse_unsafe_layout() -> None:
    """`reset` deletes RUNS_DIR whole, so nothing that must survive a reset may live inside it."""
    if HISTORY_DIR == RUNS_DIR or HISTORY_DIR.is_relative_to(RUNS_DIR):
        raise SystemExit(
            f"refusing to start: history dir {HISTORY_DIR} is inside runs dir {RUNS_DIR}; "
            "`reset` would delete every past run. Set ANTIBODY_HISTORY_DIR outside ANTIBODY_RUNS_DIR."
        )
    if ROOT.is_relative_to(RUNS_DIR):
        raise SystemExit(
            f"refusing to start: runs dir {RUNS_DIR} contains the repo ({ROOT}); "
            "`reset` would delete the checkout. Point ANTIBODY_RUNS_DIR at a directory of its own."
        )


_refuse_unsafe_layout()


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


def write_run_manifest(world: str, target: str, flags: list[str]) -> Path:
    """Record the facts about this run that no file the loop writes would otherwise carry.

    Only what the process alone knows goes in: which world it attacked (`mock`/`zendesk`), which target
    (`builtin` or the `ANTIBODY_TARGET` URL), its CLI flags, and the wall-clock start. Cycle counts,
    versions and the finish time are *not* stored: the API derives those from `cycles.jsonl`, `configs/`
    and `status_log.jsonl` at read time (`api.store.run_manifest`), so the manifest can never disagree
    with the run it describes — the loop appends cycles long after this file is written.

    `flags` are the flags of the process that *started* the run. A `--resume` continuation does not call
    this, so a run resumed with different flags keeps the first process's; the history folder is one
    archive, not a resume chain.
    """
    from datetime import datetime, timezone

    RUNS_DIR.mkdir(parents=True, exist_ok=True)
    doc = {
        "world": world,
        "target": target,
        "flags": list(flags),
        "started_at": datetime.now(timezone.utc).isoformat(),
    }
    RUN_MANIFEST_PATH.write_text(json.dumps(doc, indent=2))
    return RUN_MANIFEST_PATH


def _remove(path: Path) -> None:
    """Delete one entry without following a symlink into somewhere else."""
    if path.is_dir() and not path.is_symlink():
        shutil.rmtree(path)
    else:
        path.unlink()


def _move_dir_complete(src: Path, dest: Path) -> None:
    """Move a directory so `dest` only ever exists whole.

    Across filesystems `shutil.move` is a copy followed by a delete; a crash in the middle would leave a
    half-copied `dest` that later looks like a finished run. So the copy lands in `.incoming-<name>`
    next to `dest` and is renamed into place only once complete; a failed copy is removed and the
    source is left untouched. Same-filesystem moves are a rename and never partial.
    """
    staging = dest.parent / f".incoming-{dest.name}"
    if staging.is_symlink() or staging.exists():
        # A previous attempt died mid-copy. `src` still exists (we are moving it), so the leftover
        # cannot be the only copy of anything.
        _remove(staging)
    try:
        os.rename(src, staging)
    except OSError:
        try:
            shutil.copytree(src, staging, symlinks=True)
        except BaseException:
            shutil.rmtree(staging, ignore_errors=True)
            raise
        os.replace(staging, dest)
        shutil.rmtree(src)
        return
    os.replace(staging, dest)


def _migrate_legacy_archive() -> int:
    """Move `runs/archive/*` (the pre-history/ location) into HISTORY_DIR. Returns how many moved.

    Runs before anything that could delete or repopulate runs/, so a `reset` on an old checkout keeps
    every past run. Folders whose name already exists in history/ are left in place rather than merged.
    The emptied archive/ is removed only when nothing but file-manager droppings (`_STRAY_FILES`)
    remain; anything else is reported and left for a person. Symlinks are never followed or removed.
    """
    if _LEGACY_ARCHIVE_DIR.is_symlink():
        print(f"history: {_LEGACY_ARCHIVE_DIR} is a symlink; not migrating through it")
        return 0
    if not _LEGACY_ARCHIVE_DIR.is_dir():
        return 0
    moved = 0
    for child in sorted(_LEGACY_ARCHIVE_DIR.iterdir()):
        if child.is_symlink() or not child.is_dir():
            continue
        dest = HISTORY_DIR / child.name
        if dest.is_symlink() or dest.exists():
            print(f"history: {dest} already exists; leaving {child} in place")
            continue
        HISTORY_DIR.mkdir(parents=True, exist_ok=True)
        _move_dir_complete(child, dest)
        moved += 1
    remaining = sorted(p.name for p in _LEGACY_ARCHIVE_DIR.iterdir())
    if all(name in _STRAY_FILES for name in remaining):
        shutil.rmtree(_LEGACY_ARCHIVE_DIR)
    else:
        print(f"history: {_LEGACY_ARCHIVE_DIR} still holds {', '.join(remaining)}; leaving it for you to move by hand")
    if moved:
        print(f"history: moved {moved} archived run(s) from {_LEGACY_ARCHIVE_DIR} to {HISTORY_DIR}")
    return moved


def reset() -> None:
    """Wipe the current run's state. Explicit command; never happens implicitly on start. history/ is untouched."""
    _migrate_legacy_archive()
    removed: list[str] = []
    if CYCLES_PATH.exists():
        CYCLES_PATH.unlink()
        removed.append(str(CYCLES_PATH))
    if RUNS_DIR.is_dir():
        if _LEGACY_ARCHIVE_DIR.is_symlink() or _LEGACY_ARCHIVE_DIR.exists():
            # Only reachable when a legacy folder could not be migrated. Never delete it.
            print(f"reset: keeping {_LEGACY_ARCHIVE_DIR} (could not be migrated); move it by hand")
            for child in RUNS_DIR.iterdir():
                if child != _LEGACY_ARCHIVE_DIR:
                    _remove(child)
            removed.append(f"everything in {RUNS_DIR} except {_LEGACY_ARCHIVE_DIR.name}/")
        else:
            shutil.rmtree(RUNS_DIR)
            removed.append(str(RUNS_DIR))
    print(("reset: removed " + ", ".join(removed)) if removed else "reset: nothing to remove")


def archive_previous_run() -> Path | None:
    """Move the previous run's configs, suite, cycle log and phase log out of the way before a fresh run.

    A fresh run starts at v0 and cycle 1 again. Writing its v1, v2, ... over the previous run's files would
    silently change what every earlier cycle record points at, so the old run is kept whole under
    history/<timestamp>/ instead. Returns the archive path, or None if there was nothing to move.
    """
    from datetime import datetime, timezone

    _migrate_legacy_archive()
    # status.json goes too: a fresh run must not begin with the previous run's last phase on screen.
    movable = [
        CONFIGS_DIR,
        REGRESSION_PATH,
        CYCLES_PATH,
        RUN_MANIFEST_PATH,
        LOOP_SETTINGS_PATH,
        RUNS_DIR / "status.json",
        RUNS_DIR / "status_log.jsonl",
        RUNS_DIR / "vulnerability.json",
        RUNS_DIR / "vulnerability_detail.json",
    ]
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
