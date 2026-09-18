"""Antibody API. Run: uv run uvicorn api.main:app --port 8000  (no --reload: a reload forgets the loop it spawned)

The Vite dev server proxies /api to this in development; in production the same process also
serves the built dashboard from web/dist (mounted at "/" after every /api route, only when the
directory exists), so `make demo` is one server. Read routes serve the loop's files with a golden
fallback (api.store) from one of three sources, `live`, `golden` or `run:<id>` (a past run under
history/); /api/runs lists those runs with their manifests. /api/loop/* spawns and controls the loop
as a subprocess with the settings in the request body (api.loop_ctl); /api/manifest describes the
target for the Intro line and carries the settings defaults; /api/attack runs one seed scenario
in-process as a preview (api.attack); /api/replay/* plays a recorded run (golden, or any past run)
into /api/status and /api/cycles on its original schedule (api.replay); /api/rollback copies a past
run's config version in as the next live version (api.rollback); /api/health is what the Makefile waits
on and where the UI learns whether a key is set. /api/loop/reset is planned (docs/FRONTEND.md §3) and
does not exist yet.

Without WANDB_API_KEY the API is Replay-only: /api/attack and POST /api/loop/start answer 503
instead of spawning work that would die on `get_client()`.

Precedence for status, state and cycles is live > replay > file: a running loop always owns the
screen, so a replay is ignored *and stopped* the moment one is seen (`replay_if_no_loop`), and
`POST /api/loop/start` stops an active replay before spawning. Only with no loop alive does an
active replay win over the files; during it configs/regression come from the run being replayed
(golden, or the history run named by `recording=run:<id>`).

Importing this module has no side effects. Startup kicks off `weave.init` in a daemon thread
(network, never blocking) so the first /api/attack does not pay for it; `ANTIBODY_NO_WEAVE=1`
skips that. The API writes under runs/ only `loop.log` and `loop_settings.json` (api.loop_ctl) and,
on `POST /api/rollback`, the next `configs/v{n}.json` plus the merged `regression.json` (api.rollback).

Test-only override: `ANTIBODY_IGNORE_EXTERNAL_LOOP=1` makes the replay-start guard (and
loop_ctl's pgrep fallback) ignore loops this API did not spawn, so a scratch server on another port
can exercise replay while a real run owns runs/. Never set it on the demo server.
"""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from typing import Literal

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.exception_handlers import request_validation_exception_handler
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from api import attack, loop_ctl, manifest, replay, rollback, store
from api.loop_ctl import LoopStartBody
from api.store import Source
from chaos.state import ROOT, latest_version

WEB_DIST = ROOT / "web" / "dist"
NO_KEY_MESSAGE = "WANDB_API_KEY missing; add it to .env and restart the API (Replay works without one)"
LOOP_START_PATH = "/api/loop/start"

# uvicorn only installs handlers for its own loggers; logging under its name is the one way a
# line reliably reaches the terminal the server was started from.
_log = logging.getLogger("uvicorn.error")


@asynccontextmanager
async def _lifespan(_: FastAPI):
    # api.attack logs under its own name, which uvicorn does not route to the terminal; say it here.
    if attack.missing_api_key():
        _log.info("no WANDB_API_KEY: Replay only (live runs and seed attacks answer 503)")
    attack.warm_weave()
    yield


app = FastAPI(title="Antibody API", version="0.1.0", lifespan=_lifespan)


@app.exception_handler(RequestValidationError)
async def _body_rules_are_400s(request: Request, exc: RequestValidationError) -> JSONResponse:
    """A `LoopStartBody` `model_validator` rule ("nothing to run", "until_quiet cannot exceed chaos_cycles")
    is a client error the drawer shows verbatim, so `POST /api/loop/start` answers 400 with the plain
    message. Only that route and only errors located in its body qualify; everywhere else, and for
    field-level errors (a value out of range, a wrong type), FastAPI's 422 envelope stands."""
    if request.url.path == LOOP_START_PATH:
        rules = [
            e["msg"].removeprefix("Value error, ")
            for e in exc.errors()
            if e.get("type") == "value_error" and tuple(e.get("loc") or ())[:1] == ("body",)
        ]
        if rules:
            return JSONResponse(status_code=400, content={"detail": rules[0]})
    return await request_validation_exception_handler(request, exc)


def replay_if_no_loop() -> bool:
    """True when an active replay should be what the UI sees.

    The single place the live-vs-replay decision is made, so status, state, cycles and the config
    routes cannot disagree. A live loop (ours or an external one in this checkout) always wins: if a
    replay is playing next to it the replay is stopped here, because leaving it running would keep
    stealing the screen from the real run every time a poll came in.
    """
    if not replay.active():
        return False
    if loop_ctl.state()["running"]:
        was = replay.stop()
        if was.get("stopped"):
            _log.info("replay stopped: a live loop is running and owns /api/status")
        return False
    return True


def _resolve(requested: Source) -> Source:
    """`live` falls back to golden only when no loop is alive.

    A fresh run archives the previous run's files first, so for its first minutes runs/ is empty. Falling
    back to golden then would show the old 7-cycle run under a "cycle 1 · attacking" header until the
    first record lands and the screen snapped to one row. An empty live tree is the truth at that point.
    """
    src = store.resolve_source(requested)
    if src == "golden" and requested == "live" and loop_ctl.state()["running"]:
        return "live"
    return src


def _source(raw: str) -> Source:
    """The `source` query value, validated. `run:<id>` must name an existing history folder.

    A malformed id (anything outside `store.RUN_ID`, so also every path) is the client's mistake: 400.
    A well-formed id nobody has is 404. Neither may reach `store._paths` unchecked.
    """
    try:
        return store.parse_source(raw)
    except LookupError as e:
        raise HTTPException(404, str(e))
    except ValueError as e:
        raise HTTPException(400, str(e))


def _read_source(requested: Source) -> Source:
    """Where read routes get their files: the replayed run's during a replay (never the live run's), else as asked.

    Only `live` is overridden, to whichever tape is playing (golden, or a `run:<id>`). A past run asked
    for by name is exactly that run whether or not a tape is playing; the replay owns the screen, not
    the history.
    """
    if requested == "live" and replay_if_no_loop():
        playing = replay.current_source()
        if playing is not None:
            return playing
    return _resolve(requested)


@app.get("/api/health")
def get_health() -> dict:
    """Liveness + what this install can do. Reports whether a key is set, never the key itself."""
    return {
        "ok": True,
        "version": app.version,
        "live_exists": store.live_exists(),
        # What Replay actually needs (api.replay): the recorded phase log and the cycles it lands.
        "golden_exists": replay.GOLDEN_LOG.exists() and replay.GOLDEN_CYCLES.exists(),
        "has_api_key": not attack.missing_api_key(),
        "weave": attack.weave_status(),
    }


@app.get("/api/state")
def get_state(source: str = Query("live")) -> dict:
    src = _source(source)
    # Decide live-vs-replay once so cycles, versions and `source` cannot disagree within one response
    # (the replay's tail can expire between two calls).
    replaying = src == "live" and replay_if_no_loop()
    replayed = replay.current_cycles() if replaying else None
    replaying = replayed is not None
    # Versions and the vulnerability file come from the tape's own run (golden, or the replayed history run).
    src = (replay.current_source() or replay.GOLDEN) if replaying else _resolve(src)
    cycles = replayed if replaying else store.read_cycles(src)
    versions = store.config_versions(src)

    last_gate: Literal["accepted", "rejected"] | None = None
    legit_pass_rate: float | None = None
    for rec in reversed(cycles):
        if rec.gate is not None:
            last_gate = "accepted" if rec.gate.accepted else "rejected"
            legit_pass_rate = rec.gate.legit_pass_rate
            break

    out = {
        "latest_version": (
            cycles[-1].config_after if cycles else (versions[-1] if versions else None)
        ),
        "suite_size": cycles[-1].regression_suite_size if cycles else 0,
        "legit_pass_rate": legit_pass_rate,
        "last_gate": last_gate,
        "loop": loop_ctl.state(),
        "source": "replay" if replaying else src,
        # Before/after number for the Results headline. Null until `chaos.loop vulnerability` has run;
        # a fresh run archives the previous file, so a live run never shows a stale one.
        "vulnerability": store.read_vulnerability(src),
    }
    if replaying:
        # The tape's start time, not golden's: a replayed history run is labelled with its own date.
        out["recorded_at"] = replay.info().get("recorded_at")
    return out


@app.get("/api/status")
def get_status() -> dict:
    # Live > replay > file. A replay owns the phase signal only while no loop is alive.
    replayed = replay.current_status() if replay_if_no_loop() else None
    if replayed is not None:
        return replayed
    doc = store.read_status()
    # A SIGTERM'd or crashed loop never reaches its final set_phase("idle"), so status.json keeps
    # saying e.g. "gate" and the orbs stay lit. The API never writes runs/, so correct it on read:
    # no loop process alive + non-idle file = stale. The recorded phase survives as last_phase.
    if doc.get("phase", "idle") != "idle" and not loop_ctl.state()["running"]:
        return {**doc, "phase": "idle", "stale": True, "last_phase": doc["phase"]}
    return doc


@app.get("/api/cycles")
def get_cycles(source: str = Query("live")) -> list[dict]:
    src = _source(source)
    if src == "live" and replay_if_no_loop():
        replayed = replay.current_cycles()
        if replayed is not None:
            return [rec.model_dump() for rec in replayed]
    return [rec.model_dump() for rec in store.read_cycles(_resolve(src))]


@app.get("/api/configs")
def get_configs(source: str = Query("live")) -> list[dict]:
    return _config_rows(_read_source(_source(source)))


def _config_rows(src: Source) -> list[dict]:
    out = []
    for v in store.config_versions(src):
        cfg = store.read_config(src, v)
        if cfg is None:
            continue
        out.append(
            {"version": cfg.version, "parent_version": cfg.parent_version, "patch_note": cfg.patch_note}
        )
    return out


@app.get("/api/configs/{version}")
def get_config(version: int, source: str = Query("live")) -> dict:
    src = _read_source(_source(source))
    cfg = store.read_config(src, version)
    if cfg is None:
        raise HTTPException(404, f"no config v{version} in {src}")
    return cfg.model_dump()


@app.get("/api/regression")
def get_regression(source: str = Query("live")) -> list[dict]:
    src = _read_source(_source(source))
    return [s.model_dump() for s in store.read_regression(src)]


@app.get("/api/manifest")
def get_manifest() -> dict:
    return manifest.build()


# --- Run history (docs/plans/02, B1) ---------------------------------------------------------------


def _golden_row() -> dict | None:
    """The committed demo run as one more row, so the UI has a single list to show."""
    row = store.run_manifest("golden")
    if row is None:
        return None
    meta = replay.recording_meta()
    if meta is not None:
        row["started_at"] = meta["recorded_at"]
    return {**row, "label": "demo tape", "current": False}


def _live_row() -> dict | None:
    """The run in runs/ as it stands now; `finished_at` is null while its loop is still alive."""
    row = store.run_manifest("live")
    if row is None:
        return None
    if loop_ctl.state()["running"]:
        row["finished_at"] = None
    return {**row, "label": None, "current": True}


@app.get("/api/runs")
def get_runs() -> list[dict]:
    """Every run there is to open, newest first: the live run (`current: true`, only once it has a cycle),
    then history/ and the golden demo tape ordered by start time. Runs with no cycles are hidden."""
    rows = [{**m, "label": None, "current": False} for m in store.history_runs()]
    golden = _golden_row()
    if golden is not None and golden["cycles"] > 0:
        rows = store.newest_first([*rows, golden])
    live = _live_row()
    return ([live] if live and live["cycles"] > 0 else []) + rows


@app.get("/api/runs/{run_id}")
def get_run(run_id: str) -> dict:
    """Manifest plus `configs` (version, parent_version, patch_note). `run_id` is `live`, `golden` or a history folder."""
    if run_id == "live":
        row = _live_row()
        src: Source = "live"
    elif run_id == "golden":
        row = _golden_row()
        src = "golden"
    else:
        src = _source(f"{store.RUN_PREFIX}{run_id}")
        m = store.run_manifest(src)
        row = {**m, "label": None, "current": False} if m else None
    if row is None:
        raise HTTPException(404, f"run {run_id!r} has no files")
    return {**row, "configs": _config_rows(src)}


# --- Loop control ---------------------------------------------------------------


@app.post(LOOP_START_PATH, status_code=201)
def loop_start(body: LoopStartBody) -> dict:
    """Spawn `chaos.loop run` with the body's settings (`loop_ctl.LoopStartBody` is the contract).

    Client errors come first, whether or not a key is set, so the drawer reads the same on a keyless
    install: the body's own rules ("nothing to run", `until_quiet` over the cap) are 400s before this
    runs (`_body_rules_are_400s`); a `resume` with no saved config is 400 here rather than a child
    that exits 1 a second later.
    """
    if body.resume and latest_version() is None:
        raise HTTPException(400, "nothing to resume: no saved config to continue from")
    if attack.missing_api_key():
        raise HTTPException(503, NO_KEY_MESSAGE)
    # Heal always means "start a real run": a replay that was playing is the fallback, not a reason
    # to keep showing recorded data, so it is cleared before the loop is spawned.
    if replay.stop().get("stopped"):
        _log.info("replay stopped: a live loop is being started")
    try:
        return loop_ctl.start(body)
    except RuntimeError:
        raise HTTPException(409, {"message": "loop already running", **loop_ctl.state()})


@app.get("/api/loop")
def loop_state() -> dict:
    return loop_ctl.state()


@app.post("/api/loop/stop")
def loop_stop() -> dict:
    try:
        return loop_ctl.stop()
    except PermissionError:
        raise HTTPException(409, "loop not started by this API")
    except LookupError:
        raise HTTPException(404, "no loop started by this API is running")


# --- Rollback (docs/plans/02, B1) ---------------------------------------------------------------------


class RollbackBody(BaseModel):
    # A runs-list id: a history folder name or `golden`. `live` is a 400 (that is `--from-version`).
    run: str
    version: int = Field(..., ge=0)


@app.post("/api/rollback")
def rollback_to(body: RollbackBody) -> dict:
    """Copy `run`'s `v{version}` in as the next live config version and merge its regression suite into
    the live one (api.rollback). 200 `{config: AgentConfig, newer_tests}`; 400 for `live` or a malformed
    run id; 404 unknown run or version; 409 while a loop runs, when the run targeted another agent, when the
    live suite is unreadable, or when the version slot was taken concurrently (retry)."""
    try:
        return rollback.rollback(body.run, body.version)
    except ValueError as e:
        raise HTTPException(400, str(e))
    except LookupError as e:
        raise HTTPException(404, str(e))
    except rollback.RollbackRefused as e:
        raise HTTPException(409, str(e))


# --- Replay of a recorded run (docs/FRONTEND.md §3, slice 7; any past run since plan 02 B1) ------------


@app.post("/api/replay/start", status_code=201)
def replay_start(
    speed: float = Query(1.0, ge=replay.MIN_SPEED, le=replay.MAX_SPEED),
    recording: str = Query(replay.GOLDEN),
) -> dict:
    """Start playing a recording from t=0: the golden run by default, or a past run as `recording=run:<id>`.

    `speed` > 1 is for rehearsals (3× fits a 16-min run in 5). `live` is not a tape: the live run is
    what a replay stands in for, so asking to replay it is a 400. A history folder that has no
    `status_log.jsonl` or `cycles.jsonl` is a run, but not a recording: 400 too.
    """
    if recording == "live":
        raise HTTPException(400, "recording must be golden or run:<id>; the live run is not a tape")
    source = _source(recording)
    live = loop_ctl.state()
    # Test-only escape hatch (module docstring): a scratch server may replay next to a foreign run.
    if live["running"] and not (live.get("external") and loop_ctl.ignore_external()):
        raise HTTPException(409, {"message": "a live loop is running", "reason": "loop_running", **live})
    try:
        return replay.start(speed, source)
    except RuntimeError:
        raise HTTPException(409, {"message": "a replay is already active", "reason": "replay_active", **replay.info()})
    except FileNotFoundError as e:
        if source == replay.GOLDEN:
            raise HTTPException(503, f"no golden recording to replay: {e}")
        raise HTTPException(400, f"{recording} cannot be replayed: {e}")


@app.post("/api/replay/stop")
def replay_stop() -> dict:
    return replay.stop()


@app.post("/api/replay/pause")
def replay_pause() -> dict:
    """Freeze the replay at its current position (Back on Agents). 404 if no replay is active."""
    try:
        return replay.pause()
    except LookupError:
        raise HTTPException(404, "no replay is active")


@app.post("/api/replay/resume")
def replay_resume() -> dict:
    """Continue a paused replay from where it stopped. 404 if no replay is active."""
    try:
        return replay.resume()
    except LookupError:
        raise HTTPException(404, "no replay is active")


@app.post("/api/replay/speed")
def replay_speed(speed: float = Query(..., ge=replay.MIN_SPEED, le=replay.MAX_SPEED)) -> dict:
    """Change playback speed in place; the position does not jump. 404 if no replay is active."""
    try:
        return replay.set_speed(speed)
    except LookupError:
        raise HTTPException(404, "no replay is active")


@app.post("/api/replay/seek")
def replay_seek(t: float = Query(..., ge=0.0)) -> dict:
    """Jump to `t` recorded seconds (clamped to the recording's length). 404 if no replay is active."""
    try:
        return replay.seek(t)
    except LookupError:
        raise HTTPException(404, "no replay is active")


@app.get("/api/replay")
def replay_state() -> dict:
    """`{active, paused, recording: {source, id, recorded_at, cycles, duration_s} | null, ...session fields while active}`.

    `recording` is the tape that is playing, or the golden run a default start would play when idle."""
    return replay.info()


# --- Seed attack preview -----------------------------------------------------------


class AttackBody(BaseModel):
    scenario_id: str
    version: int = Field(0, ge=0)


@app.post("/api/attack")
def attack_preview(body: AttackBody) -> dict:
    # An external target's tool server lives in the loop process; previewing from here would bind its
    # port under uvicorn and the loop could never start. Refused before the key check: it is unsupported
    # with or without one.
    unsupported = attack.unsupported_target()
    if unsupported is not None:
        raise HTTPException(501, unsupported)
    # Unconditional: the target and judge call the inference endpoint with this key, so the attack
    # cannot run without it even when tracing is off (it used to fall through to a SystemExit → 500).
    if attack.missing_api_key():
        raise HTTPException(503, NO_KEY_MESSAGE)
    scenario = attack.find_scenario(body.scenario_id)
    if scenario is None:
        raise HTTPException(404, f"unknown seed scenario {body.scenario_id!r}")
    cfg = attack.find_config(body.version)
    if cfg is None:
        # Also the mid-write window (read_config returns None on a torn file): the config exists a
        # millisecond later, so a retryable 503 rather than a 404 the UI might cache as "gone".
        if body.version in store.config_versions(store.resolve_source("live")):
            raise HTTPException(503, f"config v{body.version} is being written; retry")
        raise HTTPException(404, f"no config v{body.version}")
    try:
        return attack.run(cfg, scenario)
    except attack.AttackBusy:
        raise HTTPException(409, "an attack is already running")
    except attack.AttackTimeout:
        raise HTTPException(504, f"attack did not finish within {attack.TIMEOUT_S:.0f}s")
    except attack.AttackFailed as e:
        raise HTTPException(500, f"attack failed: {e}")


@app.get("/api/loop/log")
def loop_log(tail: int = Query(200, ge=1, le=5000)) -> dict:
    return {"lines": loop_ctl.log_tail(tail)}


# --- Built dashboard -------------------------------------------------------------------
# Must stay last: Starlette matches in registration order, so every /api route above wins over the
# catch-all mount. `html=True` serves index.html for "/"; the app routes by query string, so no SPA
# fallback is needed. Skipped when web/dist is absent (dev via Vite, or a clone that never built).
if WEB_DIST.is_dir():
    app.mount("/", StaticFiles(directory=WEB_DIST, html=True), name="web")
