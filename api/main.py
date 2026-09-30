"""Antibody API. Run: uv run uvicorn api.main:app --port 8000  (no --reload: a reload forgets the loop it spawned)

The Vite dev server proxies /api to this in development; in production the same process also
serves the built dashboard from web/dist (mounted at "/" after every /api route, only when the
directory exists), so `make demo` is one server. Read routes serve the loop's files with a golden
fallback (api.store) from one of three sources, `live`, `golden` or `run:<id>` (a past run under
history/): /api/state, /api/status, /api/cycles, /api/configs (every saved version's summary row),
/api/configs/{v} and /api/regression (the captured suite). /api/runs lists those runs with their manifests
and names the agent each ran against; /api/runs/{id} is one run plus its config versions.
/api/agents/* is the list of connected agents: add one by URL, ping it (or ping a bare URL before saving it),
delete it, or start and stop the bundled example agent and read its log tail (api.agents, api.example_agent).
/api/loop/* spawns and controls the loop as a subprocess with the settings in the request body, including
which agent to attack, and /api/loop/log tails runs/loop.log (api.loop_ctl); there is no reset route —
wiping runs/ is the CLI's `chaos.loop reset`;
/api/manifest describes the default target and the models for the Intro line and carries the settings defaults;
/api/attack runs one seed scenario in-process as a preview, against the running loop's agent when there is
one (api.attack); /api/replay/* plays a recorded
run (golden, or any past run) into /api/status and /api/cycles on its original schedule (api.replay);
/api/rollback copies a past run's config version in as the next live version (api.rollback); /api/health
is what the Makefile waits on and where the UI learns whether a key is set.

Without WANDB_API_KEY the API is Replay-only: /api/attack and POST /api/loop/start answer 503
instead of spawning work that would die on `get_client()`.

Request bodies are capped at the front door (`BodyCap`: `MAX_BODY_BYTES`, tighter per route in `BODY_CAPS`) and
answer 413 before anything is buffered; a 422 for a body over `ECHO_MAX_BYTES` omits FastAPI's per-error `input` echo.

Precedence for status, state and cycles is live > replay > file: a running loop always owns the
screen, so a replay is ignored *and stopped* the moment one is seen (`replay_if_no_loop`), and
`POST /api/loop/start` stops an active replay before spawning. Only with no loop alive does an
active replay win over the files; during it configs/regression come from the run being replayed
(golden, or the history run named by `recording=run:<id>`).

Importing this module has no side effects. Startup migrates any pre-history/ `runs/archive` and kicks off
`weave.init` in a daemon thread (network, never blocking) so the first /api/attack does not pay for it;
`ANTIBODY_NO_WEAVE=1` skips that. The API writes under runs/ only `loop.log` and `loop_settings.json`
(api.loop_ctl), `example_agent.log` and `example_agent.pid` (api.example_agent) and, on
`POST /api/rollback`, the next `configs/v{n}.json` plus the merged `regression.json` (api.rollback).
Under history/ it writes one file, `agents.json` (api.agents).

Test-only override: `ANTIBODY_IGNORE_EXTERNAL_LOOP=1` makes the replay-start guard (and
loop_ctl's pgrep fallback) ignore loops this API did not spawn, so a scratch server on another port
can exercise replay while a real run owns runs/. Never set it on the demo server.
"""

from __future__ import annotations

import json
import logging
from contextlib import asynccontextmanager
from typing import Literal

from fastapi import FastAPI, HTTPException, Query, Request, Response
from fastapi.encoders import jsonable_encoder
from fastapi.exception_handlers import request_validation_exception_handler
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from starlette.datastructures import Headers
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from api import agents, attack, auth, example_agent, incidents, loop_ctl, manifest, replay, rollback, schedules, store, tool_setup
from api.loop_ctl import LoopStartBody
from api.store import Source
from chaos import gateway, scenarios, state
from chaos.schemas import ScenarioKind, ToolRule
from chaos.state import ROOT

WEB_DIST = ROOT / "web" / "dist"
NO_KEY_MESSAGE = "WANDB_API_KEY missing; add it to .env and restart the API (Replay works without one)"
LOOP_START_PATH = "/api/loop/start"
IMPORT_PATH = "/api/scenarios/import"

# Request bodies the API accepts, in bytes. Every body is a small JSON document; the one paste route carries a
# transcript capped at `scenarios.IMPORT_MAX_CHARS` characters, which JSON-escaped in UTF-8 stays well under its
# cap. Over the line the answer is 413 before the body is buffered or parsed — a 5 MB paste used to be read whole,
# rejected by Pydantic, and echoed back as an 11 MB 422.
MAX_BODY_BYTES = 1024 * 1024
BODY_CAPS = {IMPORT_PATH: 256 * 1024}
# A 422 echoes the offending `input` per error, which for a body over this size repeats the paste once per field.
ECHO_MAX_BYTES = 4096

# uvicorn only installs handlers for its own loggers; logging under its name is the one way a
# line reliably reaches the terminal the server was started from.
_log = logging.getLogger("uvicorn.error")


@asynccontextmanager
async def _lifespan(_: FastAPI):
    # api.attack logs under its own name, which uvicorn does not route to the terminal; say it here.
    if attack.missing_api_key():
        _log.info("no WANDB_API_KEY: Replay only (live runs and seed attacks answer 503)")
    # A checkout with runs under the old runs/archive/ shows its history before the next run, not after.
    # A no-op (one `is_dir`) when there is nothing to migrate.
    try:
        state.migrate_legacy_archive()
    except OSError as e:  # noqa: BLE001 - a half-moved archive must not stop the API from serving
        _log.warning("could not migrate runs/archive into history/: %s", e)
    attack.warm_weave()
    # Scheduled runs (api.schedules): a 30 s ticker; `ANTIBODY_NO_SCHEDULER=1` keeps it off (tests, CI).
    schedules.start_daemon()
    yield
    schedules.stop_daemon()


app = FastAPI(title="Antibody API", version="0.1.0", lifespan=_lifespan)


def body_cap(path: str) -> int:
    """How many body bytes a route may carry: its own line from `BODY_CAPS`, else `MAX_BODY_BYTES`."""
    return BODY_CAPS.get(path, MAX_BODY_BYTES)


def too_large(cap: int) -> str:
    return f"request body is larger than {cap} bytes"


class BodyCap:
    """Pure ASGI front door for request size: a declared `Content-Length` over the route's cap is 413 at once, and a body
    that arrives without one (chunked) is counted as it streams and refused at the same line — the 413 goes out from
    here, the app is handed a disconnect so it stops reading, and whatever it answers to that is dropped. Not an
    exception raised from `receive`: `BaseHTTPMiddleware` awaits `receive` inside a task group, which would wrap it in
    an `ExceptionGroup` that FastAPI turns into a 400. Outermost on purpose: nothing downstream buffers a byte over the cap."""

    def __init__(self, app: ASGIApp):
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        cap = body_cap(scope["path"])
        refusal = JSONResponse(status_code=413, content={"detail": too_large(cap)})
        declared = Headers(scope=scope).get("content-length", "")
        if declared.isdigit() and int(declared) > cap:
            await refusal(scope, receive, send)
            return
        seen = 0
        refused = False

        async def counted() -> Message:
            nonlocal seen, refused
            message = await receive()
            if message["type"] == "http.request" and not refused:
                seen += len(message.get("body", b""))
                if seen > cap:
                    refused = True
                    await refusal(scope, receive, send)
                    return {"type": "http.disconnect"}
            return message

        async def unless_refused(message: Message) -> None:
            if not refused:
                await send(message)

        await self.app(scope, counted, unless_refused)


@app.middleware("http")
async def _bearer_token(request: Request, call_next):
    """`ANTIBODY_API_TOKEN` set → every /api route but /api/health wants the bearer (api.auth). A JSONResponse
    rather than an HTTPException: raised inside middleware, an exception skips FastAPI's handlers."""
    if not auth.authorized(request):
        return auth.refusal()
    return await call_next(request)


app.add_middleware(BodyCap)


def body_size(request: Request, exc: RequestValidationError) -> int:
    """The rejected body's size in bytes: the declared length when there is one, else the parsed document's."""
    declared = request.headers.get("content-length", "")
    if declared.isdigit():
        return int(declared)
    body = getattr(exc, "body", None)
    if body is None:
        return 0
    return len(body) if isinstance(body, (bytes, str)) else len(json.dumps(body, default=str))


@app.exception_handler(RequestValidationError)
async def _validation_errors(request: Request, exc: RequestValidationError) -> JSONResponse:
    """Two departures from FastAPI's 422 envelope. A `LoopStartBody` `model_validator` rule ("nothing to run",
    "until_quiet cannot exceed chaos_cycles") is a client error the drawer shows verbatim, so `POST /api/loop/start`
    answers 400 with the plain message — only that route and only errors located in its body. And for a body over
    `ECHO_MAX_BYTES` the per-error `input` echo is dropped: the answer says where and why without repeating the paste.
    Everywhere else, and for field-level errors on a small body, the standard envelope stands."""
    if request.url.path == LOOP_START_PATH:
        rules = [
            e["msg"].removeprefix("Value error, ")
            for e in exc.errors()
            if e.get("type") == "value_error" and tuple(e.get("loc") or ())[:1] == ("body",)
        ]
        if rules:
            return JSONResponse(status_code=400, content={"detail": rules[0]})
    if body_size(request, exc) > ECHO_MAX_BYTES:
        errors = [{k: v for k, v in e.items() if k != "input"} for e in exc.errors()]
        return JSONResponse(status_code=422, content={"detail": jsonable_encoder(errors)})
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
        # Whether every other /api route wants `Authorization: Bearer` (api.auth); never the token.
        "auth_required": auth.required(),
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
    legit_covered: dict[str, int] | None = None
    for rec in reversed(cycles):
        if rec.gate is not None:
            last_gate = "accepted" if rec.gate.accepted else "rejected"
            legit_pass_rate = rec.gate.legit_pass_rate
            legit_covered = rec.gate.legit_covered
            break

    out = {
        "latest_version": (
            cycles[-1].config_after if cycles else (versions[-1] if versions else None)
        ),
        "suite_size": cycles[-1].regression_suite_size if cycles else 0,
        "legit_pass_rate": legit_pass_rate,
        # The denominator behind the rate: legit tasks the target could perform, of the pack's total (None = all).
        "legit_covered": legit_covered,
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
    decisions = store.read_approvals(src)
    out = []
    for v in store.config_versions(src):
        cfg = store.read_config(src, v)
        if cfg is None:
            continue
        out.append(
            {
                "version": cfg.version,
                "parent_version": cfg.parent_version,
                "patch_note": cfg.patch_note,
                "review": state.review_status(cfg.version, decisions),
            }
        )
    return out


@app.get("/api/configs/{version}")
def get_config(version: int, source: str = Query("live")) -> dict:
    src = _read_source(_source(source))
    cfg = store.read_config(src, version)
    if cfg is None:
        raise HTTPException(404, f"no config v{version} in {src}")
    return cfg.model_dump()


# --- Approval: which saved versions a person certified (docs/plans/09, §2) ------------------------------


class ReviewBody(BaseModel):
    status: Literal["approved", "rejected"]
    note: str = Field("", max_length=500)


@app.get("/api/approvals")
def get_approvals(source: str = Query("live")) -> dict:
    """`{certified, decisions: [{version, status, at, note}]}` for every saved version of a run; absent = pending."""
    src = _read_source(_source(source))
    decisions = store.read_approvals(src)
    return {
        "certified": state.approved_version(decisions),
        "decisions": [
            {"version": v, **(decisions.get(v) or {"status": "pending", "at": None, "note": ""})}
            for v in store.config_versions(src)
        ],
    }


@app.post("/api/configs/{version}/review")
def review_config(version: int, body: ReviewBody) -> dict:
    """Approve or reject one live version. Allowed while the loop runs: the loop never reads this file."""
    if store.read_config("live", version) is None:
        raise HTTPException(404, f"no live config v{version}")
    with loop_ctl.runs_lock:
        entry = state.review(version, body.status, body.note)
    # The decision as feedback on the evaluation that admitted the version, when this process traces (plan 11 §4.6);
    # off the request thread, and silently skipped without a client or a stored call id.
    attack.record_decision_later(store.eval_call_id("live", version), body.status, body.note)
    return {"version": version, **entry, "certified": state.approved_version()}


@app.get("/api/review/inbox")
def get_review_inbox() -> list[dict]:
    """Every saved version per agent, split into `pending` and `decided` (api.store.review_inbox): the Review index in one poll
    instead of three reads per run. Golden is not a run anyone decides on and is left out."""
    return store.review_inbox(get_runs())


@app.get("/api/regression")
def get_regression(source: str = Query("live")) -> list[dict]:
    src = _read_source(_source(source))
    # The suite is the one live file a person writes before any run exists (an imported incident); show it
    # rather than the golden fallback, which the other read routes take on an empty tree.
    if source == "live" and src == "golden" and not replay_if_no_loop() and store.run_paths("live").regression.exists():
        src = "live"
    return [s.model_dump() for s in store.read_regression(src)]


@app.get("/api/manifest")
def get_manifest() -> dict:
    return manifest.build()


@app.get("/api/domains")
def get_domains() -> list[dict]:
    """Every domain pack the loop can run in: `[{name, tools: [{name, class}], families: [name], legit: number}]`.
    Built from the packs on first request (they import weave, kept off the API's startup path like the manifest)."""
    return manifest.domains()


# --- Run history (docs/plans/02, B1) ---------------------------------------------------------------


def _golden_row() -> dict | None:
    """The committed reference run as one more row, so the UI has a single list to show."""
    row = store.run_manifest("golden")
    if row is None:
        return None
    meta = replay.recording_meta()
    if meta is not None:
        row["started_at"] = meta["recorded_at"]
    return {**row, "label": "reference run", "current": False}


def _live_row() -> dict | None:
    """The run in runs/ as it stands now; `finished_at` is null while its loop is still alive.

    `recording` is always false here: `POST /api/replay/start` refuses `live` by design (the live run is
    what a replay stands in for). The same files become a tape once the next run archives them under an id.
    """
    row = store.run_manifest("live")
    if row is None:
        return None
    loop = loop_ctl.state()
    if loop["running"]:
        row["finished_at"] = None
        # A `vulnerability` measurement re-attacks this run's versions (plan 11 §7): the one we spawned says so in its
        # settings; one started from a terminal, or the epilogue of a `--vulnerability` run, says so in status.json.
        row["measuring"] = (loop["settings"] or {}).get("mode") == "vulnerability" or store.read_status().get("measuring") == "vulnerability"
    return {**row, "recording": False, "label": None, "current": True}


def _with_agent(row: dict) -> dict:
    """The row plus `agent: {id, name} | null`, joined on the run's verbatim `target` (api.agents normalises both sides)."""
    return {**row, "agent": agents.agent_for_target(row.get("target"))}


@app.get("/api/runs")
def get_runs() -> list[dict]:
    """Every run there is to open, newest first: the live run (`current: true`, only once it has a cycle),
    then history/ and the golden reference run ordered by start time. Runs with no cycles are hidden."""
    rows = [{**m, "label": None, "current": False} for m in store.history_runs()]
    golden = _golden_row()
    if golden is not None and golden["cycles"] > 0:
        rows = store.newest_first([*rows, golden])
    live = _live_row()
    return [_with_agent(r) for r in ([live] if live and live["cycles"] > 0 else []) + rows]


@app.post("/api/runs/archive")
def archive_run() -> dict:
    """Clear the current run: file its folders under history/ and answer `{archived: <run id> | null}`.

    409 while a loop runs. Any playing tape is stopped first — not for the files (replay reads tapes into
    memory) but because the Current run page shows an active tape as "watching" and must land on its empty face.
    """
    try:
        archived = loop_ctl.archive_live_run()
    except RuntimeError:
        raise HTTPException(409, "loop is running")
    if replay.stop().get("stopped"):
        _log.info("replay stopped: the current run was cleared")
    return {"archived": archived}


@app.get("/api/runs/{run_id}")
def get_run(run_id: str) -> dict:
    """Manifest plus `agent` and `configs` (version, parent_version, patch_note). `run_id` is `live`, `golden` or a history folder."""
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
    return {**_with_agent(row), "configs": _config_rows(src)}


# --- Agents (plan 00, Block 1) ------------------------------------------------------------------------


class AgentBody(BaseModel):
    name: str
    url: str
    # Where the agent's real tools live (`POST <tools_backend>/tools/{name}`); omitted = the sandbox storefront.
    tools_backend: str | None = None
    # The domain pack whose world this agent speaks (`GET /api/domains`); omitted = the API's default.
    domain: str | None = Field(None, max_length=32)


class AgentPatchBody(BaseModel):
    tools_backend: str | None = None


@app.get("/api/agents")
def get_agents() -> list[dict]:
    """`builtin`, `example` (with `running`/`starting`/`pid`), then every connected agent."""
    return agents.list_agents()


@app.post("/api/agents", status_code=201)
def agent_create(body: AgentBody) -> dict:
    """Connect an agent by name and `http(s)://` URL. 400 for a bad name or URL, 409 when that URL is already connected."""
    try:
        return agents.add_agent(body.name, body.url, body.tools_backend, body.domain)
    except ValueError as e:
        raise HTTPException(400, str(e))
    except agents.Duplicate as e:
        raise HTTPException(409, str(e))


@app.patch("/api/agents/{agent_id}")
def agent_patch(agent_id: str, body: AgentPatchBody) -> dict:
    """Point a connected agent at its real tools (`tools_backend`), or back at the sandbox with null. 404 for the
    built-in rows or an unknown id; 400 for a bad URL; 409 while a loop runs (the running child already has its value)."""
    if loop_ctl.is_running():
        raise HTTPException(409, "a loop is running; change the tools backend when it finishes")
    try:
        return agents.set_tools_backend(agent_id, body.tools_backend)
    except LookupError as e:
        raise HTTPException(404, str(e))
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.get("/api/agents/{agent_id}/tools")
def agent_tools(agent_id: str) -> dict:
    """The Tools panel (api.tool_setup): the agent's listed tools, the sandbox mapping, each tool's class and a
    starter rule per tool. `tools: null` until a ping has listed them."""
    agent = agents.get_agent(agent_id)
    if agent is None:
        raise HTTPException(404, f"no agent {agent_id!r}")
    return tool_setup.proposal(agent)


class ApplyRulesBody(BaseModel):
    rules: dict[str, ToolRule]


@app.post("/api/agents/{agent_id}/tools/apply", status_code=201)
def agent_tools_apply(agent_id: str, body: ApplyRulesBody) -> dict:
    """Save the rules as the next live config version. 201 the config; 400 for no rules; 404 unknown agent; 409
    while a loop runs or when the live run belongs to another agent."""
    agent = agents.get_agent(agent_id)
    if agent is None:
        raise HTTPException(404, f"no agent {agent_id!r}")
    try:
        return tool_setup.apply(agent, body.rules).model_dump()
    except ValueError as e:
        raise HTTPException(400, str(e))
    except rollback.RollbackRefused as e:
        raise HTTPException(409, str(e))


@app.delete("/api/agents/{agent_id}", status_code=204)
def agent_delete(agent_id: str) -> None:
    """404 for `builtin`, `example` or an unknown id. 409 while any loop runs: the live run names its target only
    seconds after spawn, so the conservative rule is that nothing is deleted while a run is in flight."""
    if loop_ctl.is_running():
        raise HTTPException(409, "a loop is running; agents cannot be deleted until it finishes")
    try:
        agents.delete_agent(agent_id)
    except LookupError as e:
        raise HTTPException(404, str(e))


@app.post("/api/agents/{agent_id}/ping")
def agent_ping(agent_id: str) -> dict:
    """`{ok, latency_ms, reply_preview | error, tools, mapping}`. Always 200 once the agent exists: an unreachable
    agent is a result (`ok: false`), not an HTTP error. Records no episode."""
    agent = agents.get_agent(agent_id)
    if agent is None:
        raise HTTPException(404, f"no agent {agent_id!r}")
    return agents.ping(agent)


class PingUrlBody(BaseModel):
    url: str


@app.post("/api/agents/ping")
def agent_ping_url(body: PingUrlBody) -> dict:
    """The same `PingResult` for a URL that is not connected yet, so the connect form can test before saving.
    400 for a URL `POST /api/agents` would reject; nothing is stored."""
    try:
        return agents.ping_url(body.url)
    except ValueError as e:
        raise HTTPException(400, str(e))


class ExampleBody(BaseModel):
    # Which bundled example: `support` (the original, default) or `airline`. Optional so the connect screen's bodiless call keeps working.
    name: str | None = None


def _example(name: str | None) -> example_agent.Example:
    try:
        return example_agent.example(name)
    except KeyError as e:
        raise HTTPException(404, str(e))


@app.post("/api/agents/example/start", status_code=202)
def example_agent_start(body: ExampleBody | None = None) -> dict:
    """Spawn a bundled example agent on its port. 202 because the first start syncs its venv and can take a minute; the
    row's `running` flips when the port answers. 503 without a key (the agents call inference); 409 if the port is taken;
    404 for a name that is not an example."""
    ex = _example(body.name if body else None)
    if attack.missing_api_key():
        raise HTTPException(503, NO_KEY_MESSAGE)
    try:
        return example_agent.start(ex)
    except example_agent.PortBusy as e:
        raise HTTPException(409, {"message": str(e), **example_agent.state_of(ex)})


@app.post("/api/agents/example/stop")
def example_agent_stop(body: ExampleBody | None = None) -> dict:
    """Stop the example agent this API spawned. 404 when nothing is running; an agent on the port that someone else started
    is reported (`owned: false`) and left alone."""
    ex = _example(body.name if body else None)
    try:
        return example_agent.stop(ex)
    except LookupError as e:
        raise HTTPException(404, str(e))


@app.get("/api/agents/example/log")
def example_agent_log(tail: int = Query(200, ge=1, le=5000), name: str | None = None) -> dict:
    return {"lines": example_agent.log_tail(_example(name), tail)}


# --- Loop control ---------------------------------------------------------------


@app.post(LOOP_START_PATH, status_code=201)
def loop_start(body: LoopStartBody) -> dict:
    """Spawn `chaos.loop run` with the body's settings (`loop_ctl.LoopStartBody` is the contract).

    Client errors come first, whether or not a key is set, so the drawer reads the same on a keyless
    install: the body's own rules ("nothing to run", `until_quiet` over the cap) are 400s before this
    runs (`_body_rules_are_400s`); a `resume` with no saved config, or a `target` naming no agent, is 400
    here rather than a child that exits 1 a second later.
    """
    try:
        loop_ctl.preflight(body)
    except ValueError as e:
        raise HTTPException(400, str(e))
    except loop_ctl.MissingKey:
        raise HTTPException(503, NO_KEY_MESSAGE)
    # Heal always means "start a real run": a replay that was playing is the fallback, not a reason
    # to keep showing recorded data, so it is cleared before the loop is spawned.
    if replay.stop().get("stopped"):
        _log.info("replay stopped: a live loop is being started")
    try:
        return loop_ctl.start(body)
    except ValueError as e:
        # `target` names an agent that does not exist (deleted between the picker's load and Start).
        raise HTTPException(400, str(e))
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


# --- Import an incident (docs/plans/09-roadmap-v1.md §3) -------------------------------------------------


class ImportBody(BaseModel):
    transcript: str = Field(min_length=1, max_length=scenarios.IMPORT_MAX_CHARS)
    kind: ScenarioKind
    title: str = Field("", max_length=80)
    # None: the active pack's own customer (retail: cust_owen).
    customer_id: str | None = Field(None, max_length=64)


@app.post(IMPORT_PATH, status_code=201)
def import_scenario(body: ImportBody, response: Response) -> dict:
    """A pasted support transcript becomes a live regression scenario (api.incidents). 201 `{scenario, created:
    true}`; 200 `{…, created: false}` when the same customer text was imported before (the row is replaced);
    400 for a paste with no customer turn; 409 while a loop runs or when the live suite is unreadable."""
    try:
        scenario, created = incidents.import_incident(body.transcript, kind=body.kind, title=body.title, customer_id=body.customer_id)
    except ValueError as e:
        raise HTTPException(400, str(e))
    except incidents.ImportRefused as e:
        raise HTTPException(409, str(e))
    if not created:
        response.status_code = 200
    return {"scenario": scenario.model_dump(), "created": created}


# --- Enforcement gateway's shadow log (docs/plans/09-roadmap-v1.md §5) ------------------------------------


@app.get("/api/gateway")
def get_gateway_log(tail: int = Query(200, ge=1, le=5000), backend: str | None = Query(None)) -> dict:
    """The last `tail` events the gateway (`python -m chaos.gateway`) appended to history/gateway.jsonl, oldest
    first, and the command line that starts it. `events: []` when it has never run. `backend=<url>` keeps only the
    rows a gateway in front of that tools backend wrote (`chaos.gateway.for_backend`, the rule the replay follows) —
    the Agent page passes the agent's `tools_backend` — and the command then names that backend."""
    backend = backend or None
    return {"events": gateway.read_log(tail, backend=backend), "command": gateway.command_line(backend) if backend else gateway.command_line()}


@app.get("/api/gateway/replay")
def get_gateway_replay(version: str = Query("approved"), source: str = Query("live"), tail: int = Query(5000, ge=1, le=50000), backend: str | None = Query(None)) -> dict:
    """Version N's (`approved` for the certified one) `tool_rules` re-run over the last `tail` rows of the real gateway
    log (`chaos.gateway.replay`): the Review page's "would have blocked N of the last M real calls". The log belongs to
    the install, not to a run, so every `source` but `golden` reads the same file; golden has no real traffic and
    replays empty. `backend=<url>` keeps only the rows a gateway in front of that tools backend wrote — the Review
    page passes the agent's `tools_backend`. 400 for a version that is not a number, 404 for one nobody saved."""
    src = _source(source)
    try:
        cfg = gateway.load_policy_config(version)
    except ValueError:
        raise HTTPException(400, "version must be 'approved' or a saved version number")
    except FileNotFoundError:
        raise HTTPException(404, f"no saved config v{version}")
    rows = [] if src == "golden" else gateway.read_log(tail, calls_only=False)
    return gateway.replay(cfg, rows, backend=backend or None)


# --- Schedules (docs/plans/09-roadmap-v1.md §6) ------------------------------------------------------------


@app.get("/api/schedules")
def get_schedules() -> list[dict]:
    return [schedules.describe(r) for r in schedules.list_schedules()]


@app.post("/api/schedules", status_code=201)
def schedule_create(body: schedules.ScheduleBody) -> dict:
    """400 for an unknown agent or `on_change` on the built-in agent (it never changes)."""
    try:
        return schedules.describe(schedules.create(body))
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.patch("/api/schedules/{schedule_id}")
def schedule_update(schedule_id: str, body: schedules.SchedulePatch) -> dict:
    try:
        return schedules.describe(schedules.update(schedule_id, body))
    except LookupError as e:
        raise HTTPException(404, str(e))
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.delete("/api/schedules/{schedule_id}", status_code=204)
def schedule_delete(schedule_id: str) -> None:
    try:
        schedules.delete(schedule_id)
    except LookupError as e:
        raise HTTPException(404, str(e))


@app.post("/api/schedules/{schedule_id}/run")
def schedule_run(schedule_id: str) -> dict:
    """Fire now, whatever the trigger says. Always 200: the outcome (`started` / `skipped` / `failed`) is in `last_result`."""
    row = schedules.get_schedule(schedule_id)
    if row is None:
        raise HTTPException(404, f"no schedule {schedule_id!r}")
    return schedules.describe(schedules.fire(row))


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


def _preview_target() -> str | None:
    """The agent the preview should attack: the running loop's, as a canonical target string; None (the API
    process's own default) when no loop this API started is running, or its agent row is gone."""
    live = loop_ctl.state()
    if not live.get("running") or not live.get("settings"):
        return None
    try:
        return agents.resolve_agent(live["settings"].get("target"))
    except ValueError:
        return None


@app.post("/api/attack")
def attack_preview(body: AttackBody) -> dict:
    # Previews the agent the running loop is hardening, so the run page's preview and the cycles it shows
    # agree; with no loop running, the API process's own target. An external target's tool server lives in
    # the loop process; previewing from here would bind its port under uvicorn and the loop could never
    # start. Refused before the key check: it is unsupported with or without one.
    target = _preview_target()
    unsupported = attack.unsupported_target(target)
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
        return attack.run(cfg, scenario, target)
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
# Must stay last: Starlette matches in registration order, so every /api route above wins over these.
# The dashboard routes by path (`/app/runs/live`, docs/FRONTEND.md "Routes"), and `StaticFiles(html=True)`
# only serves index.html for directory URLs, so a hard refresh on any /app path would 404 through the
# mount alone. The explicit /app routes below are registered *before* the mount so they win; they are
# limited to /app so a missing asset or a typo outside the app is still an honest 404, not an HTML page.
# Skipped when web/dist is absent (dev via Vite, or a clone that never built).
if WEB_DIST.is_dir():

    @app.get("/app", include_in_schema=False)
    @app.get("/app/{rest:path}", include_in_schema=False)
    def spa_index(rest: str = "") -> FileResponse:
        return FileResponse(WEB_DIST / "index.html")

    app.mount("/", StaticFiles(directory=WEB_DIST, html=True), name="web")
