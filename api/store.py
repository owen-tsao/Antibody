"""Read-side access to run artifacts, with the committed golden run as fallback.

The loop writes files; the UI reads them through here. Nothing in this module imports
`weave` or spawns anything, so the API process stays cheap and cannot collide with the
loop's tracing state (docs/FRONTEND.md §8).

Source resolution: "live" means the files the loop writes (`cycles.jsonl`, `runs/`).
"golden" is `data/golden/`, a known-good run committed on purpose. "run:<id>" is one past run
under `history/<id>/` (a flat folder: `cycles.jsonl`, `configs/`, `regression.json`, `status_log.jsonl`
side by side). Callers ask for a source; `resolve_source("live")` degrades to golden when the live
files are absent, so a fresh checkout or a post-`reset` tree still shows the demo data — labeled as
such. `<id>` arrives in a URL, so `parse_source` is the one door: it accepts only names that match
`RUN_ID` and resolve to an existing folder inside `HISTORY_DIR`.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Literal, NamedTuple

from chaos.schemas import AgentConfig, CycleRecord, Scenario
from chaos.state import CONFIGS_DIR, CYCLES_PATH, GOLDEN_DIR, HISTORY_DIR, REGRESSION_PATH, RUN_MANIFEST_PATH
from chaos.status import STATUS_LOG_PATH, STATUS_PATH

# `"live"`, `"golden"`, or `"run:<id>"`. Wider than the two literals so a history folder can be read
# through the same functions; route handlers get one via `parse_source`, never straight from the URL.
Source = Literal["live", "golden"] | str
RUN_PREFIX = "run:"
# History folder names: the loop's UTC stamps (`20260913T174437Z`) and hand-named copies
# (`continuation-2026-09-13`). No dots, no slashes, so `..` and paths can never match.
RUN_ID = re.compile(r"^[A-Za-z0-9T_-]+$")

# Every reader here must tolerate the loop writing underneath it. `cycles.jsonl`, `status.json`
# and `regression.json` are safe by construction (append / atomic rename); `save_config` in
# chaos.state truncates-then-writes, so a read in that window sees an empty file. pydantic's
# ValidationError and json's JSONDecodeError are both ValueErrors.


class RunPaths(NamedTuple):
    cycles: Path
    configs: Path
    regression: Path
    status_log: Path
    manifest: Path
    status: Path


def run_dir(run_id: str) -> Path:
    """`HISTORY_DIR/<run_id>` for a name that came from a URL.

    Raises ValueError for a name outside `RUN_ID` and LookupError when no such folder exists. The
    regex alone rules out traversal; the containment check after `resolve()` is the invariant this
    module promises regardless of what the regex is loosened to later.
    """
    if not RUN_ID.fullmatch(run_id) or Path(run_id).name != run_id:
        raise ValueError(f"invalid run id {run_id!r}")
    root = HISTORY_DIR.resolve()
    path = (HISTORY_DIR / run_id).resolve()
    if path.parent != root or not path.is_relative_to(root):
        raise ValueError(f"run id {run_id!r} escapes the history folder")
    if not path.is_dir():
        raise LookupError(f"no run {run_id!r} in history")
    return path


def parse_source(raw: str) -> Source:
    """Validate a `source` query value. ValueError for a malformed one, LookupError for an unknown run."""
    if raw in ("live", "golden"):
        return raw
    if raw.startswith(RUN_PREFIX):
        run_dir(raw[len(RUN_PREFIX) :])
        return raw
    raise ValueError(f"source must be live, golden or run:<id>, not {raw!r}")


def run_paths(source: Source) -> RunPaths:
    """Where a source keeps its files. Golden nests `runs/`; live and history folders do not.

    The one place the two folder shapes are known: every reader here and the replay loader go through it.
    """
    if source == "golden":
        return RunPaths(
            cycles=GOLDEN_DIR / "cycles.jsonl",
            configs=GOLDEN_DIR / "runs" / "configs",
            regression=GOLDEN_DIR / "runs" / "regression.json",
            status_log=GOLDEN_DIR / "status_log.jsonl",
            manifest=GOLDEN_DIR / "runs" / "run.json",
            status=GOLDEN_DIR / "runs" / "status.json",
        )
    if source == "live":
        return RunPaths(CYCLES_PATH, CONFIGS_DIR, REGRESSION_PATH, STATUS_LOG_PATH, RUN_MANIFEST_PATH, STATUS_PATH)
    if source.startswith(RUN_PREFIX):
        d = run_dir(source[len(RUN_PREFIX) :])
        return RunPaths(
            cycles=d / "cycles.jsonl",
            configs=d / "configs",
            regression=d / "regression.json",
            status_log=d / "status_log.jsonl",
            manifest=d / "run.json",
            status=d / "status.json",
        )
    raise ValueError(f"unknown source {source!r}")


def live_exists() -> bool:
    return CYCLES_PATH.exists() or CONFIGS_DIR.exists()


def resolve_source(requested: Source) -> Source:
    if requested == "live" and not live_exists():
        return "golden"
    return requested


def read_cycles(source: Source) -> list[CycleRecord]:
    path = run_paths(source).cycles
    if not path.exists():
        return []
    out: list[CycleRecord] = []
    try:
        text = path.read_text()
    except OSError:
        # A fresh run archives the previous run's files between our exists() and read: not there yet.
        return []
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            out.append(CycleRecord.model_validate_json(line))
        except ValueError:
            # The loop appends mid-run; a torn final line is expected, not an error.
            continue
    return out


def config_versions(source: Source) -> list[int]:
    configs = run_paths(source).configs
    if not configs.exists():
        return []
    # Only `v<int>.json` counts; a stray `v3 copy.json` must not take every read route down.
    return sorted(int(p.stem[1:]) for p in configs.glob("v*.json") if p.stem[1:].isdigit())


def read_config(source: Source, version: int) -> AgentConfig | None:
    """The saved config, or None when absent or caught mid-write (callers treat both as 'not there')."""
    path = run_paths(source).configs / f"v{version}.json"
    if not path.exists():
        return None
    try:
        return AgentConfig.model_validate_json(path.read_text())
    except (OSError, ValueError):
        return None


def read_regression(source: Source) -> list[Scenario]:
    path = run_paths(source).regression
    if not path.exists():
        return []
    try:
        return [Scenario(**row) for row in json.loads(path.read_text())]
    except (OSError, ValueError, TypeError):
        return []


def read_vulnerability(source: Source) -> dict | None:
    """`runs/vulnerability.json` as `{"landed": {"v0": 6, ...}, "suite_size": 6, "world": "mock"|"zendesk"|None}`.

    Written by `chaos.loop vulnerability` after a run: how many of the final regression suite's
    attacks land on each saved config. The denominator is that final suite, so it comes from
    `regression.json`, not from any one cycle's `regression_suite_size`. `world` is where the
    measurement ran (from the detail file); None when the run predates that field.
    """
    regression = run_paths(source).regression
    path = regression.parent / "vulnerability.json"
    if not path.exists():
        return None
    try:
        doc = json.loads(path.read_text())
    except (OSError, ValueError):
        return None
    if not isinstance(doc, dict):
        return None
    landed = {
        k: v
        for k, v in doc.items()
        if isinstance(k, str) and k.startswith("v") and k[1:].isdigit() and isinstance(v, int) and not isinstance(v, bool)
    }
    if not landed:
        return None
    world = None
    try:
        detail = json.loads((regression.parent / "vulnerability_detail.json").read_text())
        if isinstance(detail, dict) and detail.get("world") in ("mock", "zendesk"):
            world = detail["world"]
    except (OSError, ValueError):
        pass
    return {"landed": landed, "suite_size": len(read_regression(source)), "world": world}


def read_status() -> dict:
    """Raw contents of `runs/status.json` (written by chaos.status at every phase transition)."""
    if not STATUS_PATH.exists():
        return {"phase": "idle"}
    try:
        doc = json.loads(STATUS_PATH.read_text())
    except (OSError, ValueError):
        # Written atomically via rename (and moved aside by a fresh run), but be tolerant anyway.
        return {"phase": "idle"}
    # Anything that is not an object (a stray `null`, a list) would crash the phase check upstream.
    return doc if isinstance(doc, dict) else {"phase": "idle"}


# --- Run manifests -------------------------------------------------------------------------------

WORLDS = ("mock", "zendesk")


def _status_log_bounds(path: Path) -> tuple[str | None, str | None]:
    """(`since` of the first row, `since` of the last row) of a phase log; None where there is no row."""
    if not path.exists():
        return None, None
    try:
        lines = path.read_text().splitlines()
    except OSError:
        return None, None
    stamps = []
    for line in lines:
        try:
            row = json.loads(line)
        except ValueError:
            continue
        if isinstance(row, dict) and isinstance(row.get("since"), str):
            stamps.append(row["since"])
    return (stamps[0], stamps[-1]) if stamps else (None, None)


def _manifest_file(path: Path) -> dict | None:
    """The stored `run.json` fields worth trusting, or None when absent or unreadable."""
    try:
        doc = json.loads(path.read_text())
    except (OSError, ValueError):
        return None
    if not isinstance(doc, dict):
        return None
    world = doc.get("world") if doc.get("world") in WORLDS else "mock"
    target = doc.get("target") if isinstance(doc.get("target"), str) and doc["target"] else "builtin"
    flags = [f for f in doc.get("flags", []) if isinstance(f, str)] if isinstance(doc.get("flags"), list) else []
    started = doc.get("started_at") if isinstance(doc.get("started_at"), str) else None
    return {"world": world, "target": target, "flags": flags, "started_at": started}


def run_manifest(source: Source) -> dict | None:
    """One run described: what its process recorded plus what its files say now.

    `run.json` contributes only `world`, `target`, `flags` (and `started_at` as a fallback): those are
    facts nobody but the loop process had. Everything countable — `cycles`, `accepted`, `rejected`,
    `versions`, `final_version`, `started_at`, `finished_at` — is read from `cycles.jsonl`, `configs/`
    and `status_log.jsonl` here, because the loop keeps appending to those long after any file written
    at start could be current. Runs made before `run.json` existed get `world: "mock"`,
    `target: "builtin"` and `synthesized: true` so the UI can say it is guessing. None when the source
    has none of its files at all.
    """
    paths = run_paths(source)
    stored = _manifest_file(paths.manifest)
    cycles = read_cycles(source)
    versions = config_versions(source)
    first, last = _status_log_bounds(paths.status_log)
    if stored is None and not cycles and not versions and first is None:
        return None
    gated = [rec.gate for rec in cycles if rec.gate is not None]
    if versions:
        final_version: int | None = versions[-1]
    else:
        final_version = cycles[-1].config_after if cycles else None
    if source.startswith(RUN_PREFIX):
        run_id = source[len(RUN_PREFIX) :]
    else:
        run_id = source
    return {
        "id": run_id,
        "started_at": first or (stored or {}).get("started_at"),
        "finished_at": last,
        "world": stored["world"] if stored else "mock",
        "target": stored["target"] if stored else "builtin",
        "cycles": len(cycles),
        "accepted": sum(1 for g in gated if g.accepted),
        "rejected": sum(1 for g in gated if not g.accepted),
        "versions": versions,
        "final_version": final_version,
        "flags": stored["flags"] if stored else [],
        "synthesized": stored is None,
    }


def history_runs() -> list[dict]:
    """Manifests of every past run under HISTORY_DIR that has at least one cycle, newest start first.

    A folder with no cycles (a run aborted before cycle 1) is skipped: there is nothing to open. Folders
    whose names would not survive `parse_source` are skipped too, since no URL could ever reach them.
    """
    if not HISTORY_DIR.is_dir():
        return []
    out: list[dict] = []
    for child in HISTORY_DIR.iterdir():
        if not child.is_dir() or not RUN_ID.fullmatch(child.name):
            continue
        manifest = run_manifest(f"{RUN_PREFIX}{child.name}")
        if manifest is not None and manifest["cycles"] > 0:
            out.append(manifest)
    return newest_first(out)


def newest_first(manifests: list[dict]) -> list[dict]:
    """Sort by `started_at` descending. A run with no phase log has no start time and sorts last rather than breaking the sort."""
    return sorted(manifests, key=lambda m: (m["started_at"] is not None, m["started_at"] or "", m["id"]), reverse=True)
