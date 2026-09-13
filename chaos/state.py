"""On-disk state so runs survive restarts and the demo can replay from any config version.

Layout:
    runs/configs/v{n}.json   every accepted AgentConfig, one file per version
    runs/regression.json     the captured regression suite (scenarios)
    cycles.jsonl             append-only cycle log read by the dashboard
    data/golden/             a committed clean run used as the demo fallback
"""

from __future__ import annotations

import json
import shutil
from pathlib import Path

from chaos.config import ROOT
from chaos.schemas import AgentConfig, Scenario

RUNS_DIR = ROOT / "runs"
CONFIGS_DIR = RUNS_DIR / "configs"
REGRESSION_PATH = RUNS_DIR / "regression.json"
CYCLES_PATH = ROOT / "cycles.jsonl"
GOLDEN_DIR = ROOT / "data" / "golden"


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
    versions = [int(p.stem[1:]) for p in CONFIGS_DIR.glob("v*.json")]
    return max(versions) if versions else None


def save_regression(scenarios: list[Scenario]) -> None:
    RUNS_DIR.mkdir(parents=True, exist_ok=True)
    REGRESSION_PATH.write_text(json.dumps([s.model_dump() for s in scenarios], indent=2))


def load_regression() -> list[Scenario]:
    if not REGRESSION_PATH.exists():
        return []
    return [Scenario(**row) for row in json.loads(REGRESSION_PATH.read_text())]


def reset() -> None:
    """Wipe all run state. Explicit command; never happens implicitly on start."""
    for p in (RUNS_DIR, CYCLES_PATH):
        if p.is_dir():
            shutil.rmtree(p)
        elif p.exists():
            p.unlink()
    print("reset: removed runs/ and cycles.jsonl")


def snapshot_golden() -> None:
    """Copy the current run into data/golden/ so a known-good run is committed for demo fallback."""
    if GOLDEN_DIR.exists():
        shutil.rmtree(GOLDEN_DIR)
    GOLDEN_DIR.mkdir(parents=True)
    if CYCLES_PATH.exists():
        shutil.copy(CYCLES_PATH, GOLDEN_DIR / "cycles.jsonl")
    if RUNS_DIR.exists():
        shutil.copytree(RUNS_DIR, GOLDEN_DIR / "runs")
    print(f"golden: snapshot written to {GOLDEN_DIR}")
