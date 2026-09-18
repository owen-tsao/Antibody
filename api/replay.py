"""Replay a recorded run into the UI at its original pace (docs/FRONTEND.md §3, slice 7).

The demo's fallback when the live loop is slow: instead of a real run, the API plays a recording's
`status_log.jsonl` (every phase transition, with `t_rel` seconds since that loop started) into
`/api/status`, and lets its `cycles.jsonl` rows appear in `/api/cycles` exactly when the recording
finished them. The recording is the committed golden run (`data/golden/`) by default, or any past run
under history/ (`run:<id>`, plan 02 B1); `api.store.run_paths` knows where each keeps its files.
Nothing is invented: every status the UI sees is a row the loop actually wrote, in order, and every
cycle is the recorded record. The only liberties are the clock (`speed`, default 1.0, for rehearsals)
and `since`, which is rewritten to the moment the row went live in this replay so the UI's elapsed
timers count from now rather than from the original run hours ago (the recorded value survives as
`recorded_since`).

One module-level session; `start()` refuses while one is still playing. A replay never ends on its
own: once the recording has played out (`ended`) the session stays, frozen on its final row with
every recorded cycle visible, until `stop()` or a fresh `start()` replaces it. This is deliberate. The
API's read routes serve the live run's files whenever no replay is active, and those files usually
disagree with the recording (a different number of cycles, a different config version); if
the session expired on a timer, the screen would silently switch runs a few seconds after the
replay finished. `pause()` freezes it where it is (Back on the Agents page does this) so nothing
advances off-screen; `resume()` continues from that position, or restarts from the top when the
recording has ended. A replay never outranks a real run: api/main.py stops it the moment a live
loop is seen (`replay_if_no_loop`) and before spawning one. This module never writes under runs/.

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
from pathlib import Path

from api import store
from chaos.schemas import CycleRecord

GOLDEN = "golden"
_GOLDEN_PATHS = store.run_paths(GOLDEN)
# What Replay actually needs from the committed run (GET /api/health reports whether both exist).
GOLDEN_LOG = _GOLDEN_PATHS.status_log
GOLDEN_CYCLES = _GOLDEN_PATHS.cycles

MIN_SPEED, MAX_SPEED = 0.1, 50.0
# Recording seconds short of the duration that still counts as ended (see Session.ended).
END_EPS_S = 0.01


@dataclass(frozen=True)
class Recording:
    source: str  # `golden` or `run:<id>`: which tape this is
    rows: list[dict]  # status_log rows, sorted by t_rel, each with a numeric t_rel
    cycles: list[CycleRecord]  # the run's cycles, sorted by cycle number
    recorded_at: str  # ISO time the recorded run started
    duration_s: float  # t_rel of the last row

    @property
    def id(self) -> str:
        return self.source.removeprefix(store.RUN_PREFIX)

    def meta(self) -> dict:
        """`{source, id, recorded_at, cycles, duration_s}`: the tape described, for labels."""
        return {
            "source": self.source,
            "id": self.id,
            "recorded_at": self.recorded_at,
            "cycles": len(self.cycles),
            "duration_s": round(self.duration_s, 1),
        }


def load_recording(paths: store.RunPaths, source: str = GOLDEN) -> Recording:
    """Parse one run's phase log and cycles. FileNotFoundError when either file is missing or the log
    has no replayable rows: a folder that lacks them is not a tape, whatever else it holds."""
    if not paths.status_log.exists():
        raise FileNotFoundError(f"{source} has no status_log.jsonl to replay")
    if not paths.cycles.exists():
        raise FileNotFoundError(f"{source} has no cycles.jsonl to replay")
    rows: list[dict] = []
    for line in paths.status_log.read_text().splitlines():
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
        raise FileNotFoundError(f"{paths.status_log} has no replayable rows")

    cycles: list[CycleRecord] = []
    for line in paths.cycles.read_text().splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            cycles.append(CycleRecord.model_validate_json(line))
        except ValueError:
            continue
    cycles.sort(key=lambda c: c.cycle)

    # The first row is the run's `start_run` idle, written at t_rel≈0: its `since` is when the run began.
    recorded_at = rows[0].get("since") or _status_since(paths.status) or datetime.now(timezone.utc).isoformat()
    return Recording(
        source=source, rows=rows, cycles=cycles, recorded_at=recorded_at, duration_s=float(rows[-1]["t_rel"])
    )


def _status_since(path: Path) -> str | None:
    try:
        return json.loads(path.read_text()).get("since")
    except (OSError, ValueError, AttributeError):
        return None


def _mtimes(paths: store.RunPaths) -> tuple[float, float]:
    """Cache key for one recording: its two files' mtimes, so a regenerated tape reloads."""
    try:
        cycles_mtime = paths.cycles.stat().st_mtime if paths.cycles.exists() else 0.0
        return paths.status_log.stat().st_mtime, cycles_mtime
    except OSError:
        return 0.0, 0.0


@lru_cache(maxsize=8)
def _recording_for(source: str, _key: tuple[float, float]) -> Recording:
    return load_recording(store.run_paths(source), source)


def recording(source: str = GOLDEN) -> Recording:
    """A recording, parsed once per file version (GET /api/replay asks on every Heal poll).

    `source` is `golden` or a `run:<id>` that already passed `store.parse_source`.
    """
    return _recording_for(source, _mtimes(store.run_paths(source)))


def recording_meta(source: str = GOLDEN) -> dict | None:
    """`Recording.meta()` for the Heal link, or None when there is nothing to replay."""
    try:
        return recording(source).meta()
    except (OSError, ValueError, LookupError):
        return None


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
            if self.ended():
                # The play control at the end of a tape starts it over.
                self._reanchor(0.0, self.speed)
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

    def ended(self) -> bool:
        """The recording has played out. The session stays; the UI sees the final row and every cycle."""
        with self._guard:
            # Tolerance: a seek to the very end re-anchors t0 through a microsecond-rounded timedelta,
            # so a frozen clock can read a few µs short of the duration and play would not restart.
            return self.elapsed() >= self.recording.duration_s - END_EPS_S

    def info(self) -> dict:
        rec = self.recording
        return {
            "recorded_at": rec.recorded_at,
            "duration_s": rec.duration_s,
            "cycles": len(rec.cycles),
            "speed": self.speed,
            "started_at": self.t0.isoformat(),
            "elapsed_s": round(min(self.elapsed(), rec.duration_s), 3),
            # An ended tape reads as paused at its last frame: the transport shows play, not pause.
            "paused": self.paused() or self.ended(),
            "ended": self.ended(),
        }


_session: Session | None = None
_lock = threading.Lock()


def _current() -> Session | None:
    """The session, if any. It never clears itself; see the module docstring for why."""
    return _session


def active() -> bool:
    return _current() is not None


def start(speed: float = 1.0, source: str = GOLDEN) -> dict:
    """Begin a replay of `source` from t=0. Raises RuntimeError("active") if one is still playing (an
    ended one is replaced) and FileNotFoundError when the source is not a replayable tape."""
    global _session
    speed = min(MAX_SPEED, max(MIN_SPEED, float(speed)))
    with _lock:
        if _session is not None and not _session.ended():
            raise RuntimeError("active")
        rec = recording(source)
        _session = Session(recording=rec, t0=datetime.now(timezone.utc), speed=speed)
        return info()


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
        "paused": s.paused() or s.ended(),
        "ended": s.ended(),
    }


def current_cycles() -> list[CycleRecord] | None:
    s = _current()
    if s is None:
        return None
    return cycles_at(s.recording, s.elapsed())


def current_source() -> str | None:
    """The source (`golden` or `run:<id>`) whose files the active replay stands in for; None when idle.

    api.main serves configs/regression from here while a tape plays, so a replayed history run shows
    its own versions rather than golden's.
    """
    s = _current()
    return s.recording.source if s is not None else None


def info() -> dict:
    """GET /api/replay. Always carries `recording`: the tape that is playing, or, when idle, the golden
    run a default start would play (None if there is no golden log), so the Heal screen can label its
    link before anything is playing; while active the session's speed/elapsed/started_at ride along too."""
    s = _current()
    meta = s.recording.meta() if s is not None else recording_meta()
    return {"active": s is not None, "recording": meta, **(s.info() if s else {})}
