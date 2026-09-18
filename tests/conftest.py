"""Shared test scaffolding: a history folder in the loop's flat archive shape, built from the committed golden run.

pytest is not a project dependency (`uv run --with pytest pytest`); nothing here touches inference or a live loop.
"""

from __future__ import annotations

import json
import shutil
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from chaos.state import GOLDEN_DIR

GOLDEN_CYCLES = 6


def flat_run(dest: Path, *, cycles: bool = True, manifest: dict | None = None) -> Path:
    """A history folder in the loop's flat archive shape, copied from the golden run."""
    dest.mkdir(parents=True)
    shutil.copytree(GOLDEN_DIR / "runs" / "configs", dest / "configs")
    shutil.copy(GOLDEN_DIR / "runs" / "regression.json", dest / "regression.json")
    shutil.copy(GOLDEN_DIR / "status_log.jsonl", dest / "status_log.jsonl")
    if cycles:
        shutil.copy(GOLDEN_DIR / "cycles.jsonl", dest / "cycles.jsonl")
    if manifest is not None:
        (dest / "run.json").write_text(json.dumps(manifest))
    return dest


@pytest.fixture
def client() -> TestClient:
    from api.main import app

    # No context manager: the lifespan would start the weave warm-up thread.
    return TestClient(app)
