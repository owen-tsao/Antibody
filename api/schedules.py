"""Schedules (docs/plans/09-roadmap-v1.md §6): attack an agent on an interval, or whenever the agent changes.

A schedule is a saved start request (`LoopStartBody` minus `target`, plus the agent) and a trigger:

    {"kind": "interval", "every_minutes": 360}   fire when `next_at` has passed
    {"kind": "on_change"}                        fire when the agent's fingerprint moved since the last check

The fingerprint is a hash of what the agent tells us about itself: `GET <url>/tools` and, when it answers,
`GET <url>/version`. An agent that lists no tools and has no version route cannot be watched for change (the
schedule records `skipped`); the built-in agent has nothing to watch and cannot take `on_change` at all.

`tick(now)` runs every 30 s in a daemon thread started by the API's lifespan (`ANTIBODY_NO_SCHEDULER=1`
disables it; tests call `tick` directly). A due schedule fires through the same `preflight` + `start` the
Heal button uses, so a keyless install, a deleted agent or a loop already running each land in
`last_result` as `skipped` with the reason, never as a child that exits a second later. One run at a time:
while a loop runs, due schedules wait for the next tick.

The list lives in `history/schedules.json` (beside agents.json: it is not a run artefact and survives
`reset`), written whole via mkstemp + replace under a lock; the path is resolved at call time so a relocated
history/ carries it.
"""

from __future__ import annotations

import contextlib
import hashlib
import json
import os
import secrets
import tempfile
import threading
from datetime import datetime, timedelta, timezone
from typing import Literal

from pydantic import BaseModel, Field, model_validator

from api import agents, loop_ctl, store
from api.loop_ctl import LoopStartBody
from chaos.target import get_json

TICK_S = 30.0
FINGERPRINT_TIMEOUT_S = 5.0
MIN_EVERY_MINUTES = 15
MAX_EVERY_MINUTES = 7 * 24 * 60
NO_SCHEDULER_ENV = "ANTIBODY_NO_SCHEDULER"

_store_lock = threading.Lock()


class IntervalTrigger(BaseModel):
    kind: Literal["interval"]
    every_minutes: int = Field(ge=MIN_EVERY_MINUTES, le=MAX_EVERY_MINUTES)


class OnChangeTrigger(BaseModel):
    kind: Literal["on_change"]


Trigger = IntervalTrigger | OnChangeTrigger


class ScheduleSettings(BaseModel):
    """`LoopStartBody` without `target` (the schedule's agent is the target) and without `resume`
    (a scheduled run always continues the live run when there is one — see `fire`)."""

    chaos_cycles: int = Field(3, ge=0, le=10)
    seeds: int | None = Field(None, ge=0, le=10)
    repair_attempts: int = Field(3, ge=1, le=5)
    second_pass: bool = True
    until_quiet: int | None = Field(None, ge=1, le=10)
    world: loop_ctl.World = "auto"
    vulnerability: bool = True

    @model_validator(mode="after")
    def _rules(self) -> ScheduleSettings:
        if self.chaos_cycles == 0 and self.seeds == 0:
            raise ValueError("nothing to run: no seeds and no chaos cycles")
        if self.until_quiet is not None and self.until_quiet > self.chaos_cycles:
            raise ValueError("until_quiet cannot exceed chaos_cycles")
        return self


class ScheduleBody(BaseModel):
    """POST /api/schedules and PATCH /api/schedules/{id} (every field optional there)."""

    name: str = Field(min_length=1, max_length=80)
    agent: str = Field(min_length=1, max_length=64)
    trigger: Trigger
    settings: ScheduleSettings = Field(default_factory=ScheduleSettings)
    enabled: bool = True


class SchedulePatch(BaseModel):
    name: str | None = Field(None, min_length=1, max_length=80)
    agent: str | None = Field(None, min_length=1, max_length=64)
    trigger: Trigger | None = None
    settings: ScheduleSettings | None = None
    enabled: bool | None = None


def _path():
    return store.HISTORY_DIR / "schedules.json"


def _read() -> list[dict]:
    path = _path()
    if not path.exists():
        return []
    try:
        rows = json.loads(path.read_text())
    except (OSError, ValueError):
        return []
    return [r for r in rows if isinstance(r, dict) and isinstance(r.get("id"), str)] if isinstance(rows, list) else []


def _write(rows: list[dict]) -> None:
    path = _path()
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=".schedules-", suffix=".tmp")
    try:
        with os.fdopen(fd, "w") as f:
            f.write(json.dumps(rows, indent=2))
        os.replace(tmp, path)
    except BaseException:
        with contextlib.suppress(OSError):
            os.unlink(tmp)
        raise


def _now_iso(now: datetime) -> str:
    return now.astimezone(timezone.utc).isoformat(timespec="seconds")


def _next_at(trigger: dict, now: datetime) -> str | None:
    if trigger["kind"] == "interval":
        return _now_iso(now + timedelta(minutes=trigger["every_minutes"]))
    return None


def _validate_agent(agent_id: str, trigger: dict) -> None:
    row = agents.get_agent(agent_id)
    if row is None:
        raise ValueError(f"unknown agent {agent_id!r}")
    if trigger["kind"] == "on_change" and not row.get("url"):
        raise ValueError("the built-in agent never changes; use an interval")


# --- CRUD -----------------------------------------------------------------------------------------------


def list_schedules() -> list[dict]:
    return _read()


def get_schedule(schedule_id: str) -> dict | None:
    return next((r for r in _read() if r["id"] == schedule_id), None)


def create(body: ScheduleBody, now: datetime | None = None) -> dict:
    """ValueError (400) for an unknown agent or `on_change` on the built-in one."""
    now = now or datetime.now(timezone.utc)
    trigger = body.trigger.model_dump()
    _validate_agent(body.agent, trigger)
    row = {
        "id": secrets.token_urlsafe(8),
        "name": " ".join(body.name.split()),
        "agent": body.agent,
        "trigger": trigger,
        "settings": body.settings.model_dump(),
        "enabled": body.enabled,
        "created_at": _now_iso(now),
        "last_run_at": None,
        "last_result": None,
        "last_fingerprint": None,
        "next_at": _next_at(trigger, now),
    }
    with _store_lock:
        _write([*_read(), row])
    return row


def update(schedule_id: str, patch: SchedulePatch, now: datetime | None = None) -> dict:
    """LookupError (404) for an unknown id; ValueError (400) as `create`. Changing the trigger resets `next_at`."""
    now = now or datetime.now(timezone.utc)
    with _store_lock:
        rows = _read()
        row = next((r for r in rows if r["id"] == schedule_id), None)
        if row is None:
            raise LookupError(f"no schedule {schedule_id!r}")
        # Top-level None means "not sent"; nested models are stored whole (their own Nones — `seeds: null` = all
        # seeds — are values, which `exclude_none` would strip recursively).
        changes = {k: v for k, v in patch.model_dump().items() if v is not None}
        trigger = changes.get("trigger", row["trigger"])
        _validate_agent(changes.get("agent", row["agent"]), trigger)
        if "name" in changes:
            changes["name"] = " ".join(changes["name"].split())
        row.update(changes)
        if "trigger" in changes or ("enabled" in changes and changes["enabled"]):
            row["next_at"] = _next_at(trigger, now)
        if "agent" in changes:
            row["last_fingerprint"] = None
        _write(rows)
    return row


def delete(schedule_id: str) -> None:
    with _store_lock:
        rows = _read()
        kept = [r for r in rows if r["id"] != schedule_id]
        if len(kept) == len(rows):
            raise LookupError(f"no schedule {schedule_id!r}")
        _write(kept)


# --- firing ---------------------------------------------------------------------------------------------


def fingerprint(agent: dict) -> str | None:
    """sha256 over `GET /tools` and, when it answers, `GET /version`; None when neither answers (nothing to watch)."""
    url = agent.get("url")
    if not url:
        return None
    parts: list[str] = []
    for route in ("/tools", "/version"):
        try:
            doc = get_json(f"{url}{route}", FINGERPRINT_TIMEOUT_S)
        except Exception:  # noqa: BLE001 - absent route, refused, timed out: this part is simply not there
            continue
        parts.append(json.dumps(doc, sort_keys=True))
    if not parts:
        return None
    return hashlib.sha256("\n".join(parts).encode()).hexdigest()


def _start_body(row: dict) -> LoopStartBody:
    from chaos.state import latest_version

    # Continue the live run when one exists (its suite and versions are this agent's when the target matches),
    # else start fresh. A live tree made against another agent is left alone: the loop archives it itself.
    manifest = store.run_manifest("live")
    owner = agents.agent_for_target(manifest.get("target")) if manifest else None
    same = owner is not None and owner["id"] == row["agent"]
    return LoopStartBody(**row["settings"], target=row["agent"], resume=bool(same and latest_version() is not None))


def _record(schedule_id: str, now: datetime, result: dict, *, fired: bool, fingerprint_value: str | None = None, keep_fingerprint: bool = False) -> dict | None:
    with _store_lock:
        rows = _read()
        row = next((r for r in rows if r["id"] == schedule_id), None)
        if row is None:
            return None
        row["last_result"] = {**result, "at": _now_iso(now)}
        if fired:
            row["last_run_at"] = _now_iso(now)
            row["next_at"] = _next_at(row["trigger"], now)
        if fingerprint_value is not None or keep_fingerprint:
            row["last_fingerprint"] = fingerprint_value if fingerprint_value is not None else row["last_fingerprint"]
        _write(rows)
        return row


def fire(row: dict, now: datetime | None = None) -> dict:
    """Start the schedule's run now. Records `started` / `skipped` (with why) / `failed` in `last_result`."""
    from api import replay

    now = now or datetime.now(timezone.utc)
    try:
        body = _start_body(row)
        loop_ctl.preflight(body)
        # Like Heal: a tape that was playing is the fallback, not a reason to keep showing recorded data.
        replay.stop()
        out = loop_ctl.start(body)
    except loop_ctl.MissingKey:
        result = {"kind": "skipped", "detail": "no WANDB_API_KEY; the loop cannot call inference"}
    except ValueError as e:
        result = {"kind": "skipped", "detail": str(e)}
    except RuntimeError:
        result = {"kind": "skipped", "detail": "a loop is already running"}
    except Exception as e:  # noqa: BLE001 - the daemon must survive a spawn that blew up
        result = {"kind": "failed", "detail": f"{type(e).__name__}: {e}"}
    else:
        result = {"kind": "started", "detail": f"pid {out['pid']}"}
    return _record(row["id"], now, result, fired=result["kind"] == "started") or {**row, "last_result": result}


def due(row: dict, now: datetime) -> tuple[bool, str | None, str | None]:
    """`(is_due, fingerprint, why_not)` for one enabled schedule at `now`. An `on_change` schedule that has never
    been checked records its fingerprint and is not due (the first check is a baseline, not a change)."""
    if not row.get("enabled"):
        return False, None, None
    trigger = row["trigger"]
    if trigger["kind"] == "interval":
        next_at = row.get("next_at")
        return (next_at is None or datetime.fromisoformat(next_at) <= now), None, None
    agent = agents.get_agent(row["agent"])
    if agent is None:
        return False, None, f"unknown agent {row['agent']!r}"
    fp = fingerprint(agent)
    if fp is None:
        return False, None, "the agent lists no tools and has no /version route; nothing to watch"
    last = row.get("last_fingerprint")
    return (last is not None and fp != last), fp, None


def tick(now: datetime | None = None) -> list[dict]:
    """One pass over every enabled schedule: fire the first due one (one run at a time), record the rest.
    Returns the schedules it touched. Safe to call while a loop runs (nothing fires)."""
    now = now or datetime.now(timezone.utc)
    touched: list[dict] = []
    running = loop_ctl.is_running()
    for row in _read():
        if not row.get("enabled"):
            continue
        is_due, fp, why_not = due(row, now)
        if why_not:
            touched.append(_record(row["id"], now, {"kind": "skipped", "detail": why_not}, fired=False) or row)
            continue
        if fp is not None and not is_due:
            # Baseline (first sight) or unchanged: remember what we saw so the next move is visible.
            if row.get("last_fingerprint") != fp:
                touched.append(_record(row["id"], now, row.get("last_result") or {"kind": "skipped", "detail": "baseline recorded; waiting for the agent to change"}, fired=False, fingerprint_value=fp) or row)
            continue
        if not is_due:
            continue
        if running:
            # The change is not consumed: the old baseline stays, so the schedule is still due next tick.
            touched.append(_record(row["id"], now, {"kind": "skipped", "detail": "a loop is already running; will retry"}, fired=False) or row)
            continue
        fired = fire(row, now)
        # An on_change run that started has handled this fingerprint; one that was skipped has not, and stays due.
        if fp is not None and fired["last_result"]["kind"] == "started":
            fired = _record(row["id"], now, fired["last_result"], fired=False, fingerprint_value=fp) or fired
        touched.append(fired)
        running = fired["last_result"]["kind"] == "started"
    return touched


# --- the daemon -----------------------------------------------------------------------------------------

_thread: threading.Thread | None = None
_stop = threading.Event()


def start_daemon() -> bool:
    """Start the ticking thread unless `ANTIBODY_NO_SCHEDULER` is set or it already runs. Returns whether it runs."""
    global _thread
    if os.environ.get(NO_SCHEDULER_ENV, "").strip():
        return False
    if _thread is not None and _thread.is_alive():
        return True
    _stop.clear()

    def loop() -> None:
        while not _stop.wait(TICK_S):
            try:
                tick()
            except Exception:  # noqa: BLE001 - a bad tick must not kill the daemon
                pass

    _thread = threading.Thread(target=loop, name="antibody-scheduler", daemon=True)
    _thread.start()
    return True


def stop_daemon() -> None:
    _stop.set()


def describe(row: dict) -> dict:
    """The row as the API returns it: stored fields plus the agent's current name (or null when it is gone)."""
    agent = agents.get_agent(row["agent"])
    return {**row, "agent_name": agent["name"] if agent else None}
