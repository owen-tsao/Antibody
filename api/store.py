"""Read-side access to run artifacts, with the committed golden run as fallback.

The loop writes files; the UI reads them through here. Nothing in this module imports
`weave` or spawns anything, so the API process stays cheap and cannot collide with the
loop's tracing state (docs/FRONTEND.md §8).

Source resolution: "live" means the files the loop writes (`cycles.jsonl`, `runs/`).
"golden" is `data/golden/`, a known-good run committed on purpose. Callers ask for a
source; `resolve_source("live")` degrades to golden when the live files are absent, so a
fresh checkout or a post-`reset` tree still shows the demo data — labeled as such.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Literal

from chaos.schemas import AgentConfig, CycleRecord, Scenario
from chaos.state import CONFIGS_DIR, CYCLES_PATH, GOLDEN_DIR, REGRESSION_PATH
from chaos.status import STATUS_PATH

Source = Literal["live", "golden"]

# Every reader here must tolerate the loop writing underneath it. `cycles.jsonl` and
# `status.json` are safe by construction (append / atomic rename); `save_config` and
# `save_regression` in chaos.state truncate-then-write, so a read in that window sees an
# empty file. pydantic's ValidationError and json's JSONDecodeError are both ValueErrors.


def _paths(source: Source) -> tuple[Path, Path, Path]:
    """(cycles.jsonl, configs dir, regression.json) for a source."""
    if source == "golden":
        return (
            GOLDEN_DIR / "cycles.jsonl",
            GOLDEN_DIR / "runs" / "configs",
            GOLDEN_DIR / "runs" / "regression.json",
        )
    return CYCLES_PATH, CONFIGS_DIR, REGRESSION_PATH


def live_exists() -> bool:
    return CYCLES_PATH.exists() or CONFIGS_DIR.exists()


def resolve_source(requested: Source) -> Source:
    if requested == "live" and not live_exists():
        return "golden"
    return requested


def read_cycles(source: Source) -> list[CycleRecord]:
    path, _, _ = _paths(source)
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
    _, configs, _ = _paths(source)
    if not configs.exists():
        return []
    # Only `v<int>.json` counts; a stray `v3 copy.json` must not take every read route down.
    return sorted(int(p.stem[1:]) for p in configs.glob("v*.json") if p.stem[1:].isdigit())


def read_config(source: Source, version: int) -> AgentConfig | None:
    """The saved config, or None when absent or caught mid-write (callers treat both as 'not there')."""
    _, configs, _ = _paths(source)
    path = configs / f"v{version}.json"
    if not path.exists():
        return None
    try:
        return AgentConfig.model_validate_json(path.read_text())
    except (OSError, ValueError):
        return None


def read_regression(source: Source) -> list[Scenario]:
    _, _, path = _paths(source)
    if not path.exists():
        return []
    try:
        return [Scenario(**row) for row in json.loads(path.read_text())]
    except (OSError, ValueError, TypeError):
        return []


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
