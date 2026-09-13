"""Replay the recorded golden run into the UI at its original pace (docs/FRONTEND.md §3, slice 7).

The demo's fallback when the live loop is slow: instead of a real run, the API plays
`data/golden/status_log.jsonl` (every phase transition, with `t_rel` seconds since that loop
started) into `/api/status`, and lets `data/golden/cycles.jsonl` rows appear in `/api/cycles`
exactly when the recording finished them. Nothing is invented: every status the UI sees is a row
the loop actually wrote, in order, and every cycle is the recorded record. The only liberties are
the clock (`speed`, default 1.0, for rehearsals) and `since`, which is rewritten to the moment the
row went live in this replay so the UI's elapsed timers count from now rather than from the
original run hours ago (the recorded value survives as `recorded_since`).

One module-level session; `start()` refuses while one is active. The session ends on its own
`TAIL_S` after the last recorded row (the final idle stays on screen briefly, then the API goes
back to serving live/golden files) or on `stop()`. `pause()` freezes it where it is (Back on the
Agents page does this) so nothing advances off-screen; a paused replay never expires, keeps serving
the same frozen row from `/api/status`, and `resume()` continues from that position. A replay never
outranks a real run: api/main.py stops it the moment a live loop is seen (`replay_if_no_loop`) and
before spawning one. Never writes under runs/.

`status_at` / `cycles_at` / `completed_cycle_at` are pure (elapsed -> value) so the mapping can be
checked against the real log without a server:

    uv run python -c "from api import replay; ..."
"""

from __future__ import annotations

import json
import threading
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from functools import lru_cache

from chaos.schemas import CycleRecord
from chaos.state import GOLDEN_DIR

GOLDEN_LOG = GOLDEN_DIR / "status_log.jsonl"
GOLDEN_CYCLES = GOLDEN_DIR / "cycles.jsonl"
GOLDEN_STATUS = GOLDEN_DIR / "runs" / "status.json"

# How long the final idle row is served after the recording ends before the session clears itself.
TAIL_S = 5.0
MIN_SPEED, MAX_SPEED = 0.1, 50.0


@dataclass(frozen=True)
class Recording:
    rows: list[dict]  # status_log rows, sorted by t_rel, each with a numeric t_rel
    cycles: list[CycleRecord]  # golden cycles, sorted by cycle number
    recorded_at: str  # ISO time the golden run started
    duration_s: float  # t_rel of the last row


def load_recording() -> Recording:
    rows: list[dict] = []
    for line in GOLDEN_LOG.read_text().splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            row = json.loads(line)
        except ValueError:
            continue
        if isinstance(row.get("t_rel"), (int, float)):
            rows.append(row)
    rows.sort(key=lambda r: r["t_rel"])
    if not rows:
        raise FileNotFoundError(f"{GOLDEN_LOG} has no replayable rows")

    cycles: list[CycleRecord] = []
    if GOLDEN_CYCLES.exists():
        for line in GOLDEN_CYCLES.read_text().splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                cycles.append(CycleRecord.model_validate_json(line))
            except ValueError:
                continue
    cycles.sort(key=lambda c: c.cycle)

    # The first row is the run's `start_run` idle, written at t_rel≈0: its `since` is when the run began.
    recorded_at = rows[0].get("since") or _golden_status_since() or datetime.now(timezone.utc).isoformat()
    return Recording(rows=rows, cycles=cycles, recorded_at=recorded_at, duration_s=float(rows[-1]["t_rel"]))


def _golden_status_since() -> str | None:
    try:
        return json.loads(GOLDEN_STATUS.read_text()).get("since")
    except (OSError, ValueError, AttributeError):
        return None


def _golden_mtimes() -> tuple[float, float]:
    """Cache key for the recording: the golden files' mtimes, so a regenerated recording reloads."""
    try:
        cycles_mtime = GOLDEN_CYCLES.stat().st_mtime if GOLDEN_CYCLES.exists() else 0.0
        return GOLDEN_LOG.stat().st_mtime, cycles_mtime
    except OSError:
        return 0.0, 0.0


@lru_cache(maxsize=2)
def _recording_for(_key: tuple[float, float]) -> Recording:
    return load_recording()


def recording() -> Recording:
    """The golden recording, parsed once per file version (GET /api/replay asks on every Heal poll)."""
    return _recording_for(_golden_mtimes())


def recording_meta() -> dict | None:
    """`{recorded_at, cycles, duration_s}` for the Heal link, or None when there is nothing to replay."""
    try:
        rec = recording()
    except (OSError, ValueError):
        return None
    return {"recorded_at": rec.recorded_at, "cycles": len(rec.cycles), "duration_s": round(rec.duration_s, 1)}


# --- Pure mapping: elapsed seconds -> what the UI should see -----------------------------------


def row_at(rows: list[dict], elapsed: float) -> dict | None:
    """The row with the largest t_rel <= elapsed, or None before the first row."""
    hit = None
    for row in rows:
        if row["t_rel"] <= elapsed:
            hit = row
        else:
            break
    return hit


def completed_cycle_at(rows: list[dict], elapsed: float) -> int:
    """Highest cycle number whose `idle` transition the recording had reached by `elapsed`.

    loop.py writes `set_phase(cycle, "idle")` right after appending that cycle's record, so this is
    the number of cycles whose records existed at that moment (0 before the first one).
    """
    done = 0
    for row in rows:
        if row["t_rel"] > elapsed:
            break
        if row.get("phase") == "idle":
            done = max(done, int(row.get("cycle") or 0))
    return done


def cycles_at(rec: Recording, elapsed: float) -> list[CycleRecord]:
    done = completed_cycle_at(rec.rows, elapsed)
    return [c for c in rec.cycles if c.cycle <= done]


def status_at(rec: Recording, elapsed: float, t0: datetime | None = None, speed: float = 1.0) -> dict:
    """The status document for `elapsed` recorded seconds into the run.

    `since` is moved onto this replay's wall clock (`t0 + t_rel / speed`) when `t0` is given; the
    original stays as `recorded_since`. Past the end, the final row (idle) is returned unchanged.
    """
    row = row_at(rec.rows, elapsed)
    if row is None:
        doc: dict = {"cycle": 0, "phase": "idle", "since": rec.recorded_at, "attack_succeeded": None}
    else:
        doc = {k: v for k, v in row.items() if k != "t_rel"}
        if t0 is not None:
            doc["recorded_since"] = row.get("since")
            doc["since"] = (t0 + timedelta(seconds=row["t_rel"] / speed)).isoformat()
    return {**doc, "replay": True, "recorded_at": rec.recorded_at}


# --- Session -----------------------------------------------------------------------------------


@dataclass
class Session:
    recording: Recording
    t0: datetime
    speed: float
    # Pause bookkeeping. `t0` never moves; the clock is (wall time since t0) minus every second spent
    # paused, so a paused replay is frozen exactly where Back left it and resumes from there.
    paused_at: datetime | None = None
    paused_total: float = 0.0  # wall-clock seconds of completed pauses
    # Transport actions rewrite several fields at once while /api/status polls read them from other
    # threads. Without this, a poll could pair the new `speed` with the old `t0`, read an elapsed far
    # past the end, and clear the session for good. Re-entrant because set_speed reads then writes.
    _guard: threading.RLock = field(default_factory=threading.RLock, repr=False, compare=False)

    def _idle_s(self, now: datetime) -> float:
        current = (now - self.paused_at).total_seconds() if self.paused_at is not None else 0.0
        return self.paused_total + current

    def elapsed(self) -> float:
        with self._guard:
            now = datetime.now(timezone.utc)
            return ((now - self.t0).total_seconds() - self._idle_s(now)) * self.speed

    def effective_t0(self) -> datetime:
        """`t0` shifted by the paused time, so `since` (and the UI's step timers) exclude pauses."""
        with self._guard:
            now = datetime.now(timezone.utc)
            return self.t0 + timedelta(seconds=self._idle_s(now))

    def paused(self) -> bool:
        return self.paused_at is not None

    def pause(self) -> None:
        with self._guard:
            if self.paused_at is None:
                self.paused_at = datetime.now(timezone.utc)

    def resume(self) -> None:
        with self._guard:
            if self.paused_at is not None:
                self.paused_total += (datetime.now(timezone.utc) - self.paused_at).total_seconds()
                self.paused_at = None

    def _reanchor(self, elapsed: float, speed: float) -> None:
        """Move the clock so that it reads `elapsed` recorded seconds *right now* at `speed`.

        Everything the UI sees is a pure function of elapsed, so changing speed or seeking is just
        choosing a new `t0` such that the clock is continuous. Pause state survives: a paused replay
        stays paused (its `paused_at` is reset to now, and the banked pause time is folded into `t0`).
        """
        with self._guard:
            now = datetime.now(timezone.utc)
            was_paused = self.paused()
            self.speed = speed
            self.t0 = now - timedelta(seconds=elapsed / speed)
            self.paused_total = 0.0
            self.paused_at = now if was_paused else None

    def set_speed(self, speed: float) -> None:
        with self._guard:
            self._reanchor(self.elapsed(), speed)

    def seek(self, elapsed: float) -> None:
        self._reanchor(min(max(0.0, elapsed), self.recording.duration_s), self.speed)

    def finished(self) -> bool:
        # A paused replay never expires: its clock is stopped, and it must still be there to resume.
        with self._guard:
            return not self.paused() and self.elapsed() > self.recording.duration_s + TAIL_S * self.speed

    def info(self) -> dict:
        rec = self.recording
        return {
            "recorded_at": rec.recorded_at,
            "duration_s": rec.duration_s,
            "cycles": len(rec.cycles),
            "speed": self.speed,
            "started_at": self.t0.isoformat(),
            "elapsed_s": round(self.elapsed(), 3),
            "paused": self.paused(),
        }


_session: Session | None = None
_lock = threading.Lock()


def _current() -> Session | None:
    """The live session, clearing it once the recording (plus tail) has played out."""
    global _session
    s = _session
    if s is not None and s.finished():
        with _lock:
            if _session is s:
                _session = None
        return None
    return s


def active() -> bool:
    return _current() is not None


def start(speed: float = 1.0) -> dict:
    """Begin a replay from t=0. Raises RuntimeError("active") if one is already playing."""
    global _session
    speed = min(MAX_SPEED, max(MIN_SPEED, float(speed)))
    with _lock:
        if _session is not None and not _session.finished():
            raise RuntimeError("active")
        rec = recording()
        _session = Session(recording=rec, t0=datetime.now(timezone.utc), speed=speed)
        return _session.info()


def stop() -> dict:
    global _session
    with _lock:
        was = _session
        _session = None
    return {"stopped": was is not None, **({"was": was.info()} if was else {})}


def pause() -> dict:
    """Freeze the replay where it is (Back on Agents). Raises LookupError if none is active. Idempotent."""
    s = _current()
    if s is None:
        raise LookupError("no replay")
    s.pause()
    return info()


def resume() -> dict:
    """Let a paused replay run on from where it stopped. Raises LookupError if none is active. Idempotent."""
    s = _current()
    if s is None:
        raise LookupError("no replay")
    s.resume()
    return info()


def set_speed(speed: float) -> dict:
    """Change playback speed without moving the position. Raises LookupError if none is active."""
    s = _current()
    if s is None:
        raise LookupError("no replay")
    s.set_speed(min(MAX_SPEED, max(MIN_SPEED, float(speed))))
    return info()


def seek(elapsed_s: float) -> dict:
    """Jump to `elapsed_s` recorded seconds (clamped to the recording). Raises LookupError if none is active."""
    s = _current()
    if s is None:
        raise LookupError("no replay")
    s.seek(float(elapsed_s))
    return info()


def current_status() -> dict | None:
    s = _current()
    if s is None:
        return None
    elapsed = s.elapsed()
    doc = status_at(s.recording, elapsed, s.effective_t0(), s.speed)
    # Progress rides along on the 1 s status poll so the UI can show "3:31 / 16:27 · 3×" without a
    # second request; a real-time replay of a 47 s gate otherwise looks frozen.
    return {
        **doc,
        "speed": s.speed,
        "elapsed_s": round(min(elapsed, s.recording.duration_s), 1),
        "duration_s": round(s.recording.duration_s, 1),
        "paused": s.paused(),
    }


def current_cycles() -> list[CycleRecord] | None:
    s = _current()
    if s is None:
        return None
    return cycles_at(s.recording, s.elapsed())


def info() -> dict:
    """GET /api/replay. Always carries `recording` (what a replay would play, or None if there is no
    golden log) so the Heal screen can label its link before anything is playing; while active the
    session's speed/elapsed/started_at ride along too."""
    s = _current()
    return {"active": s is not None, "recording": recording_meta(), **(s.info() if s else {})}
