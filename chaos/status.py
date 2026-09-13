"""Live phase signal for the UI, plus a transition log so a recorded run can be replayed.

`runs/status.json` always holds the current phase. It is written to a temp file and renamed so a
reader never sees a half-written document. Every transition is also appended to
`runs/status_log.jsonl` with `t_rel` (seconds since the loop started), which is what replay uses
to re-light the UI at the recorded pace.
"""

from __future__ import annotations

import json
import os
import time
from datetime import datetime, timezone
from typing import Literal

from chaos.state import RUNS_DIR

STATUS_PATH = RUNS_DIR / "status.json"
STATUS_LOG_PATH = RUNS_DIR / "status_log.jsonl"

Phase = Literal["baseline", "chaos", "target", "judge", "repair", "gate", "idle"]

_started_at: float | None = None


def start_run(resume: bool = False, cycle: int = 0) -> None:
    """Zero the relative clock and start a fresh transition log for this run.

    A resumed run continues the existing log instead: its clock is offset by the last recorded `t_rel`
    so the replay stays monotonic and plays the whole history, first run and continuation, as one.
    """
    global _started_at
    RUNS_DIR.mkdir(parents=True, exist_ok=True)
    offset = _last_t_rel() if resume else 0.0
    _started_at = time.monotonic() - offset
    if not resume:
        STATUS_LOG_PATH.write_text("")
    set_phase(cycle, "idle", None)


def _last_t_rel() -> float:
    if not STATUS_LOG_PATH.exists():
        return 0.0
    last = 0.0
    for line in STATUS_LOG_PATH.read_text().splitlines():
        try:
            t = json.loads(line).get("t_rel")
        except (json.JSONDecodeError, AttributeError):
            continue
        if isinstance(t, (int, float)):
            last = max(last, float(t))
    return last


def set_phase(cycle: int, phase: Phase, attack_succeeded: bool | None = None, **extra) -> None:
    RUNS_DIR.mkdir(parents=True, exist_ok=True)
    now = datetime.now(timezone.utc).isoformat()
    doc = {"cycle": cycle, "phase": phase, "since": now, "attack_succeeded": attack_succeeded, **extra}

    tmp = STATUS_PATH.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(doc))
    os.replace(tmp, STATUS_PATH)

    t_rel = round(time.monotonic() - _started_at, 3) if _started_at is not None else None
    with STATUS_LOG_PATH.open("a") as f:
        f.write(json.dumps({**doc, "t_rel": t_rel}) + "\n")
