"""On-disk state so runs survive restarts and the demo can replay from any config version.

Layout:
    runs/configs/v{n}.json   every accepted AgentConfig, one file per version
    runs/regression.json     the captured regression suite (scenarios)
    runs/run.json            what only the loop process knows about this run (world, target, flags)
    runs/loop_settings.json  the request body the API last spawned a run with (absent for a terminal-only install)
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

import contextlib
import json
import os
import shutil
import tempfile
from pathlib import Path

from chaos.config import ROOT
from chaos.schemas import AgentConfig, Scenario

_runs_override = os.environ.get("ANTIBODY_RUNS_DIR")
RUNS_DIR = Path(_runs_override).expanduser().resolve() if _runs_override else ROOT / "runs"
CONFIGS_DIR = RUNS_DIR / "configs"
REGRESSION_PATH = RUNS_DIR / "regression.json"
CYCLES_PATH = RUNS_DIR / "cycles.jsonl" if _runs_override else ROOT / "cycles.jsonl"
# Two start-of-run documents with different authors, kept apart on purpose. `run.json` is written by
# the loop process and holds what only it knows (world, target, argv); it moves to history/ with the
# run. `loop_settings.json` is written by the API (api.loop_ctl) *after* it spawns a run and holds the
# request body it was given. It is deliberately not archived: the API writes it seconds before the
# child's `archive_previous_run` runs, so moving it would file it under the *previous* run and leave
# the current one with nothing. It stays until the next `start()` overwrites it or `reset` deletes it;
# the flags in `run.json` are what tells the API whether it still describes the run on disk.
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


def save_config(cfg: AgentConfig, *, exclusive: bool = False) -> Path:
    """Write `configs/v{n}.json`. With `exclusive`, an existing file is an error (FileExistsError), not overwritten.

    The loop owns the version sequence while it runs and may rewrite a version on purpose. The API's
    rollback does not: two concurrent rollbacks that both computed the same next version must not
    silently collapse into one file, so it asks for `exclusive` and turns the failure into a retry.
    """
    CONFIGS_DIR.mkdir(parents=True, exist_ok=True)
    path = CONFIGS_DIR / f"v{cfg.version}.json"
    text = cfg.model_dump_json(indent=2)
    if exclusive:
        with open(path, "x") as f:
            f.write(text)
    else:
        path.write_text(text)
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
    """Write the suite whole via rename: the API reads it on a poll, and rollback writes it while the API serves.

    The temp file gets a unique name (`mkstemp`) rather than a fixed `.tmp`, so two writers landing at
    once cannot truncate each other's half-written file or lose the race on `os.replace`.
    """
    RUNS_DIR.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=REGRESSION_PATH.parent, prefix=".regression-", suffix=".tmp")
    try:
        with os.fdopen(fd, "w") as f:
            f.write(json.dumps([s.model_dump() for s in scenarios], indent=2))
        os.replace(tmp, REGRESSION_PATH)
    except BaseException:
        with contextlib.suppress(OSError):
            os.unlink(tmp)
        raise


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
    if (staging.is_symlink() or staging.exists()) and (src.is_symlink() or src.exists()):
        # A previous attempt died mid-copy. `src` is still there, so the leftover cannot be the only
        # copy of anything. (A leftover *without* a src is a finished move that never got its final
        # name; `_finalize_staged` handles those and this function is never asked to overwrite one.)
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


def _finalize_staged(legacy_src_dir: Path) -> int:
    """Give orphaned `history/.incoming-<name>` folders their final name. Returns how many.

    `_move_dir_complete` renames `src` to the staging name first and to `dest` second; a crash between
    the two leaves a complete run under the staging name and no `src`. Left alone it would be invisible
    to `GET /api/runs` and deleted by the next same-named migration attempt. It is finalized only when
    `dest` does not exist and `src` is gone (the rename happened, so staging holds everything). A staging
    folder whose `src` still exists is a half-copy and is left for `_move_dir_complete` to redo.
    """
    if not HISTORY_DIR.is_dir():
        return 0
    finalized = 0
    for staging in sorted(HISTORY_DIR.glob(".incoming-*")):
        name = staging.name.removeprefix(".incoming-")
        dest = HISTORY_DIR / name
        src = legacy_src_dir / name
        if staging.is_symlink() or not staging.is_dir() or not name:
            continue
        if dest.is_symlink() or dest.exists() or src.is_symlink() or src.exists():
            continue
        os.replace(staging, dest)
        print(f"history: recovered {dest} from an interrupted move")
        finalized += 1
    return finalized


def _migrate_legacy_archive() -> int:
    """Move `runs/archive/*` (the pre-history/ location) into HISTORY_DIR. Returns how many moved.

    Runs before anything that could delete or repopulate runs/, so a `reset` on an old checkout keeps
    every past run, and once at API startup so the history shows before the next run. Folders whose
    name already exists in history/ are left in place rather than merged.
    The emptied archive/ is removed only when nothing but file-manager droppings (`_STRAY_FILES`)
    remain; anything else is reported and left for a person. Symlinks are never followed or removed.
    Any move that was interrupted last time is finished first (`_finalize_staged`).
    """
    _finalize_staged(_LEGACY_ARCHIVE_DIR)
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


# Public name for the API's startup hook; the loop-side callers above keep the private one.
migrate_legacy_archive = _migrate_legacy_archive


# What a directory the loop or the API has written to always holds at least one of. A non-empty
# RUNS_DIR with none of these is somebody's folder, not ours, and `reset` refuses to rmtree it.
_RUNS_DIR_MARKERS = ("configs", "status.json", "run.json", "loop.log", "archive")


def _looks_like_runs_dir(path: Path) -> bool:
    """True for an empty or absent directory too: there is nothing to protect there."""
    if not path.is_dir():
        return True
    entries = [p.name for p in path.iterdir() if p.name not in _STRAY_FILES]
    return not entries or any(name in entries for name in _RUNS_DIR_MARKERS)


def reset() -> None:
    """Wipe the current run's state. Explicit command; never happens implicitly on start. history/ is untouched.

    Refuses (SystemExit) when RUNS_DIR is a populated directory that carries none of the loop's or
    the API's files: `ANTIBODY_RUNS_DIR=~/Documents` passes the import-time layout guard, and this is
    the one command that would empty it.
    """
    if not _looks_like_runs_dir(RUNS_DIR):
        raise SystemExit(
            f"reset: refusing to remove {RUNS_DIR}: it does not look like an Antibody runs dir "
            f"(none of {', '.join(_RUNS_DIR_MARKERS)} found). Check ANTIBODY_RUNS_DIR."
        )
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
