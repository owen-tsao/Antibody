"""The enforcement gateway: the approved policy's per-tool rules, in front of a customer's real tools.

    python -m chaos.gateway --backend http://tools.internal [--port 8766] [--version approved|N] [--shadow | --enforce]

The attack loop proves a policy in the sandbox; this runs the same rules in production. The agent points its
tool calls here instead of at its tools (the same HTTP contract as the loop's tool server: `GET /tools`,
`POST /tools/{name}`, `X-Antibody-Session`), and every call goes through `chaos.toolbus.call_tool` in
pass-through mode: only the world-agnostic `ToolRule`s run (chaos/schemas.py) — the sandbox's seven flags
and its validators know Northwind's records and never touch real traffic — then the call is forwarded.

Shadow first. `--shadow` (the default) means a rule that would block logs `would_block` and the call still runs, so
a team can watch a week of traffic, read the Review page's shadow-replay panel, and only then start with
`--enforce`. Every call is appended to `history/gateway.jsonl` (`ANTIBODY_HISTORY_DIR` relocates it), which
`GET /api/gateway` reads for the dashboard and `GET /api/gateway/replay` re-runs a version's rules over; the file
is in history/, not runs/, because it survives `reset` and is written by this process while the API reads it.

The contract a customer runs it under (docs/plans/10-production-fit.md §5b):

- **Auth.** `ANTIBODY_GATEWAY_TOKEN` set → every route but `/health` wants `Authorization: Bearer <token>` (the same
  check as the API's `ANTIBODY_API_TOKEN`, `api.auth`). The backend receives `X-Antibody-Session` and, when
  `ANTIBODY_BACKEND_AUTH` is set, that value as its own `Authorization` — never the agent's token.
  `X-Antibody-Customer` is an unauthenticated log field: whoever holds the bearer can write any name there.
- **Failure semantics by tool class** (`chaos.toolbus._call_passthrough`): a check that raises or a backend that is
  unreachable refuses money/mutate/unknown tools (`decision: blocked`, `reason: failure:…`) and lets read/message
  through with `degraded: true`. `ToolRule.on_failure` overrides per tool; `ToolRule.timeout_s` sets the wait.
- **Timing.** Every log row and `ToolCall` carries `elapsed_ms` (rule check plus backend).
- **Policy version live.** `GET /health` → `{ok, version, approved_at, rules, stale, …}`; the config is re-read every
  `RELOAD_INTERVAL_S` and on `SIGHUP`, so an approval on the Review page reaches production without a restart. Under
  `--version approved` the policy only ever moves *up*: version numbers restart at v0 with every run and a new run (or
  `reset`) archives `approvals.json`, so a reload that reads a lower or same-numbered "approved" version keeps the
  live policy, says so on stdout and reports `stale: true` until a higher version is approved or the gateway is
  restarted. Restart (or pin `--version N`) to move to a new run's lineage on purpose.

Sessions are keyed by whatever the agent sends in `X-Antibody-Session` (one per customer conversation) and
created on first sight; `POST /sessions/{id}/turn {"text"}` feeds the customer's words for the intent rule and
is logged as a `turn` row so the replay can rebuild the conversation; a session idle for an hour is dropped.
Turns are capped (`MAX_TURNS_PER_SESSION`, `MAX_TURN_CHARS`, `MAX_TURN_BODY_BYTES` → 429/413). By design, whoever
holds the bearer can satisfy `requires_user_intent` by posting a turn: the rule trusts the agent to relay the
customer's words, and the log keeps what it relayed.

Weave is opt-in (plan 11 §4.4): `ANTIBODY_GATEWAY_WEAVE=1` with a `WANDB_API_KEY` makes this process `weave.init`
and trace every forwarded call as `gateway.tool_call` inside the session's thread, scored by `ToolRuleScorer`. The
op takes primitives only (`trace_inputs`) — never the session, the request, a header, the backend bearer or the
customer id — so a customer's gateway never phones home unless asked, and what it sends is what `gateway.jsonl`
already holds, minus anything that looks like a credential.
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import json
import os
import re
import signal
import threading
import time
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import uvicorn
import weave
from fastapi import HTTPException, Request

from api import auth
from chaos import state
from chaos.config import ENTITY_PROJECT
from chaos.domains import active_domain
from chaos.schemas import AgentConfig, Scenario, ToolCall, ToolClass, ToolRule
from chaos.target import get_json
from chaos.tool_rules import classes
from chaos.toolbus import ToolSession, verified_by
from chaos.tools import tool_rule_blocks
from chaos.toolserver import SESSION_HEADER, build_app

CUSTOMER_HEADER = "X-Antibody-Customer"
TOKEN_ENV = "ANTIBODY_GATEWAY_TOKEN"
BACKEND_AUTH_ENV = "ANTIBODY_BACKEND_AUTH"
WEAVE_ENV = "ANTIBODY_GATEWAY_WEAVE"
SESSION_IDLE_S = 3600.0
RELOAD_INTERVAL_S = 60.0
BACKEND_TOOLS_TIMEOUT_S = 10.0
REPLAY_SAMPLES = 20
LOG_NAME = "gateway.jsonl"
DEFAULT_PORT = 8766
# The `turn` route's caps, together: a customer conversation is a few hundred short messages, and every turn is held
# in memory for the session's lifetime and written to the log. Past them the route answers 429 (turns) or 413 (size).
MAX_TURNS_PER_SESSION = 200
MAX_TURN_CHARS = 16 * 1024
MAX_TURN_BODY_BYTES = 64 * 1024

# The one scenario every production session runs under: no faults, no attacker, a customer with no sandbox id.
PRODUCTION = Scenario(
    id="production",
    kind="ambiguous_request",
    title="production traffic",
    user_message="",
    customer_id="",
    expected_behavior="Serve the customer within the approved policy.",
    origin="legit",
)


def log_path() -> Path:
    """`history/gateway.jsonl`, resolved at call time so a relocated history/ (tests, ANTIBODY_HISTORY_DIR) carries it."""
    return state.HISTORY_DIR / LOG_NAME


def read_log(tail: int = 200, path: Path | None = None, *, calls_only: bool = True, backend: str | None = None) -> list[dict]:
    """The last `tail` rows as dicts, oldest first; a torn line is skipped. `[]` when the gateway has never run.

    Call rows (the ones with a `tool`) are what the dashboard shows; `calls_only=False` also returns the `turn` rows
    the replay needs, interleaved in the order they happened. `backend` keeps one agent's traffic (`for_backend`),
    applied before the tail so the last `tail` rows are that backend's, not the install's.
    """
    path = path or log_path()
    if not path.exists():
        return []
    out: list[dict] = []
    for line in path.read_text().splitlines():
        with contextlib.suppress(ValueError):
            doc = json.loads(line)
            if isinstance(doc, dict) and (not calls_only or "tool" in doc):
                out.append(doc)
    return for_backend(out, backend)[-tail:]


def load_policy_config(version: str) -> AgentConfig:
    """`approved` → the certified version (`chaos.state.approved_version`, 0 when none); else `v{N}`."""
    from chaos.loop import check_config

    if version == "approved":
        return check_config(None, approved=True)
    return check_config(int(version))


def approved_at(version: int) -> str | None:
    """When a person approved this version, or None (pending, rejected, or v0 with nobody's signature)."""
    entry = state.load_approvals().get(version)
    return entry.get("at") if entry and entry.get("status") == "approved" else None


def decision_of(call: ToolCall) -> str:
    """What the gateway did with a call: `blocked`, `would_block` (shadow mode let it run) or `allowed`."""
    return "blocked" if call.blocked_by_policy else "would_block" if call.shadowed else "allowed"


def log_line(session_id: str, customer: str, cfg_version: int, call: ToolCall, shadow: bool, verified: list[str] = (), backend: str | None = None) -> dict:
    """One gateway event, compact enough to tail: what was called, what the rule said, whether it ran, how long it took.

    `backend` is which real tools the call went to: the log is one file per install, so it is what lets the Review
    page replay only the traffic of the agent it is showing (`replay(backend=…)`).
    """
    line = {
        "at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "session": session_id,
        "customer": customer,
        "backend": backend,
        "config_version": cfg_version,
        "tool": call.tool,
        "args": call.args,
        "decision": decision_of(call),
        "reason": call.blocked_by,
        "mode": "shadow" if shadow else "enforce",
        "degraded": call.degraded,
        "elapsed_ms": call.elapsed_ms,
    }
    if verified:
        line["verified"] = list(verified)
    return line


# --- Weave, opt-in ---------------------------------------------------------------------------------------------

# Keys that name a credential are dropped before anything enters the trace. Weave's own redaction covers only
# `api_key` / `authorization` / `auth_headers`; a customer's tool may call its bearer anything.
SECRET_KEY = re.compile(r"token|auth|password|passwd|secret|bearer|cookie|credential|api[_-]?key", re.IGNORECASE)
MAX_TRACED_CHARS = 500


def weave_enabled() -> bool:
    """Whether this process should trace: the opt-in flag *and* a key, both from the environment, never a request."""
    return os.environ.get(WEAVE_ENV, "").strip() == "1" and bool(os.environ.get("WANDB_API_KEY"))


def tracing() -> bool:
    """Whether a call may be traced right now: opted in and `weave.init` succeeded (a failed init traces nothing)."""
    return weave_enabled() and weave.get_client() is not None


def redact(value: Any) -> Any:
    """A copy fit for a trace: credential-looking keys dropped at every depth, strings cut to `MAX_TRACED_CHARS`."""
    if isinstance(value, dict):
        return {k: redact(v) for k, v in value.items() if not SECRET_KEY.search(str(k))}
    if isinstance(value, (list, tuple)):
        return [redact(v) for v in value]
    if isinstance(value, str) and len(value) > MAX_TRACED_CHARS:
        return value[:MAX_TRACED_CHARS] + "…"
    return value


def trace_inputs(session: ToolSession, call: ToolCall) -> dict[str, Any]:
    """The op's keyword arguments, and the only path into it: primitives the rule check needs and the decision.

    `turns`, `verified` and `ran` are the session as the rule saw it *before* this call (the call is already
    recorded when `after_call` runs), so `ToolRuleScorer` can re-run `tool_rule_blocks` on exactly those inputs.
    Nothing here comes from a header: not the customer id, not the gateway token, not `backend_auth`.
    """
    just_verified = set(verified_by(session, call))
    return {
        "tool": call.tool,
        "args": redact(call.args),
        "result": redact(call.result) if isinstance(call.result, dict) else {"value": redact(call.result)},
        "decision": decision_of(call),
        "elapsed_ms": call.elapsed_ms or 0,
        "turns": redact(list(session.customer_turns)),
        "verified": sorted(session.verified_orders - just_verified),
        "ran": max(0, session.prior_calls(call.tool) - (0 if call.blocked_by_policy else 1)),
    }


@weave.op(name="gateway.tool_call")
def _traced_tool_call(tool: str, args: dict, result: dict, decision: str, elapsed_ms: int, turns: list[str], verified: list[str], ran: int) -> dict:
    """The one op this process records; a plain function when no client is set. Signature is the leak guard:
    add a parameter here only if `tests/test_weave_integration.py::test_gateway_trace_never_carries_secrets` still holds."""
    return {"decision": decision, "ok": decision != "blocked", "error": result.get("error") if isinstance(result, dict) else None}


class ToolRuleScorer(weave.Scorer):
    """`tool_rule_blocks` as a Weave scorer, attached to every `gateway.tool_call` as feedback.

    Deterministic: it re-runs the live version's rule on the op's own inputs and reports whether the rule blocks and
    whether the gateway's decision agreed (`would_block` in shadow mode counts as agreement — the rule fired, the
    mode let it run). One scorer per policy version, so the feedback names which rules judged the call.
    """

    rules: dict[str, ToolRule]

    @weave.op
    def score(self, *, output: dict, tool: str, args: dict, turns: list[str], verified: list[str], ran: int) -> dict:
        rule = self.rules.get(tool)
        reason = tool_rule_blocks(tool, args, rule, turns, set(verified), ran) if rule is not None else None
        decision = output.get("decision") if isinstance(output, dict) else None
        return {
            "has_rule": rule is not None,
            "blocks": reason is not None,
            "reason": reason,
            "agrees": (reason is not None) == (decision in ("blocked", "would_block")),
        }


def _score_call(traced: Any, scorer: ToolRuleScorer) -> None:
    """Attach the scorer's verdict to the traced call without holding the tool answer back.

    `apply_scorer` is a coroutine; `after_call` runs on the server's event loop, and a task parked on that loop is
    cancelled when the loop stops (seen with the test client's per-request loops). So the coroutine runs to
    completion on its own thread, and a caller with no loop (a test, a script) gets it inline.

    The backlog is bounded: if Weave hangs, every tool call would otherwise park a Call and a scorer in the worker's
    queue for as long as the outage lasts. Past `SCORE_BACKLOG` waiting scores the newest is dropped — feedback on
    a trace is the one thing here that may be lost; the trace itself and the gateway's decision are not affected.
    """
    coro = traced.apply_scorer(scorer)
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        asyncio.run(coro)
        return
    if not _SCORE_SLOTS.acquire(blocking=False):
        coro.close()
        return

    def run() -> None:
        try:
            asyncio.run(coro)
        finally:
            _SCORE_SLOTS.release()

    _SCORING.submit(run)


# One worker: scores land in call order and a burst of tool calls cannot fan out into a thread per call.
_SCORING = ThreadPoolExecutor(max_workers=1, thread_name_prefix="antibody-gateway-score")
SCORE_BACKLOG = 64
_SCORE_SLOTS = threading.BoundedSemaphore(SCORE_BACKLOG)


def init_weave() -> str:
    """`weave.init(ENTITY_PROJECT)` when opted in; the one-line status `_main` prints. Fails soft: an init that
    raises (bad key, no network) leaves the gateway running untraced."""
    if not weave_enabled():
        return f"off (set {WEAVE_ENV}=1 and WANDB_API_KEY to trace and score calls)"
    try:
        weave.init(ENTITY_PROJECT)
    except Exception as e:  # noqa: BLE001
        return f"init failed, running untraced: {type(e).__name__}: {e}"
    return f"tracing gateway.tool_call to {ENTITY_PROJECT} (scored by ToolRuleScorer)"


def turn_line(session_id: str, customer: str, text: str, backend: str | None = None) -> dict:
    return {"at": datetime.now(timezone.utc).isoformat(timespec="seconds"), "session": session_id, "customer": customer, "backend": backend, "turn": text}


class Gateway:
    """The session registry, the policy holder and the log writer; `app` is the HTTP surface built over them.

    `version` is what `reload()` re-reads: `"approved"` (follow the certified version) or a pinned number.
    """

    def __init__(
        self,
        backend: str,
        cfg: AgentConfig,
        *,
        enforce: bool = False,
        log: Path | None = None,
        version: str = "approved",
        backend_auth: str | None = None,
    ):
        self.backend = backend.rstrip("/")
        self.cfg = cfg
        self.enforce = enforce
        self.log = log or log_path()
        self.version = version
        self.backend_auth = backend_auth if backend_auth is not None else (os.environ.get(BACKEND_AUTH_ENV, "").strip() or None)
        self._sessions: dict[str, tuple[ToolSession, str, float]] = {}
        self._lock = threading.Lock()
        # Why the last reload kept the live policy instead of following `approved` (None when it is following).
        self._held: str | None = None
        # The class of every tool the backend lists (`GET /tools`, name and description, pack override): what decides
        # fail-open/fail-closed, resolved once here and again on every reload so it is the class the Tools panel shows.
        self.tool_classes: dict[str, ToolClass] = self._resolve_tool_classes()
        self.app = build_app(self._session_for, self._list_tools, self._after_call, title="Antibody gateway")

        @self.app.post("/sessions/{session_id}/turn")
        async def _turn(session_id: str, request: Request) -> dict:
            # Size before parsing, and both before the session exists: a refused turn leaves nothing behind.
            raw = await request.body()
            if len(raw) > MAX_TURN_BODY_BYTES:
                raise HTTPException(413, f"body is larger than {MAX_TURN_BODY_BYTES} bytes")
            try:
                body = json.loads(raw)
            except ValueError:
                body = None
            text = body.get("text") if isinstance(body, dict) else None
            if not isinstance(text, str) or not text.strip():
                raise HTTPException(400, "body must be {\"text\": \"what the customer said\"}")
            if len(text) > MAX_TURN_CHARS:
                raise HTTPException(413, f"text is longer than {MAX_TURN_CHARS} characters")
            session = self._session_for(session_id)
            with self._lock:
                if len(session.customer_turns) >= MAX_TURNS_PER_SESSION:
                    raise HTTPException(429, f"session {session_id} has reached {MAX_TURNS_PER_SESSION} turns; start a new session")
                session.customer_turns.append(text)
            self._append(turn_line(session_id, self._customer_of(session_id), text, backend=self.backend))
            return {"turns": len(session.customer_turns)}

        @self.app.get("/health")
        def _health() -> dict:
            return self.health()

        @self.app.middleware("http")
        async def _front_door(request: Request, call_next):
            # /health is the one open route, and it is not a conversation: no bearer, and no session — an
            # unauthenticated caller must not be able to grow the session map (only authenticated calls sweep it).
            if request.url.path == "/health":
                return await call_next(request)
            # Bearer first: nothing below (not even the customer name) is remembered for a caller without the token.
            token = auth.configured(TOKEN_ENV)
            if token and not auth.bearer_ok(request.headers.get("authorization"), token):
                return auth.refusal("missing or wrong gateway token")
            sid = request.headers.get(SESSION_HEADER)
            customer = request.headers.get(CUSTOMER_HEADER)
            if sid and customer:
                self._session_for(sid, customer)
            return await call_next(request)

    def _new_session(self, session_id: str) -> ToolSession:
        return ToolSession(cfg=self.cfg, scenario=PRODUCTION, customer_turns=[], tools_backend=self.backend, shadow=not self.enforce, session_id=session_id, backend_auth=self.backend_auth, tool_classes=self.tool_classes)

    def _session_for(self, session_id: str | None, customer: str | None = None) -> ToolSession:
        """The session for this conversation, created on first sight; every call sweeps idle ones and marks this one seen.
        `customer` (the `X-Antibody-Customer` header) is recorded when given and kept otherwise."""
        if not session_id:
            raise HTTPException(status_code=400, detail=f"{SESSION_HEADER} header required: one id per customer conversation")
        now = time.monotonic()
        with self._lock:
            for sid, (_, _, seen) in list(self._sessions.items()):
                if now - seen > SESSION_IDLE_S:
                    del self._sessions[sid]
            entry = self._sessions.get(session_id)
            if entry is None:
                entry = (self._new_session(session_id), "", now)
            self._sessions[session_id] = (entry[0], customer if customer is not None else entry[1], now)
            return entry[0]

    def _customer_of(self, session_id: str) -> str:
        with self._lock:
            entry = self._sessions.get(session_id)
        return entry[1] if entry else ""

    def _list_tools(self, _session: ToolSession) -> list[dict[str, Any]]:
        return self._backend_tools()

    def _backend_tools(self) -> list[dict[str, Any]]:
        """The backend's own tool list (`GET /tools`), `[]` when it has none: a backend without /tools is not an error."""
        try:
            doc = get_json(f"{self.backend}/tools", BACKEND_TOOLS_TIMEOUT_S, {"Authorization": self.backend_auth} if self.backend_auth else None)
        except Exception:  # noqa: BLE001 - absent route, refused, timed out, not JSON: the agent knows its tools
            return []
        return doc if isinstance(doc, list) else []

    def _resolve_tool_classes(self) -> dict[str, ToolClass]:
        return classes(self._backend_tools(), active_domain())

    def _after_call(self, session_id: str, session: ToolSession, call: ToolCall) -> None:
        self._append(log_line(session_id, self._customer_of(session_id), self.cfg.version, call, shadow=not self.enforce, verified=verified_by(session, call), backend=self.backend))
        if tracing():
            self._trace(session_id, session, call)

    def _trace(self, session_id: str, session: ToolSession, call: ToolCall) -> None:
        """One `gateway.tool_call` op in the session's thread, scored by the live version's rules. Fails soft: a trace
        that cannot be sent is one line on stdout, never a failed tool call."""
        try:
            with weave.thread(session_id):
                _, traced = _traced_tool_call.call(**trace_inputs(session, call))
            _score_call(traced, ToolRuleScorer(rules=dict(self.cfg.tool_policy.tool_rules)))
        except Exception as e:  # noqa: BLE001
            print(f"gateway: weave trace skipped: {type(e).__name__}: {e}", flush=True)

    def _append(self, line: dict) -> None:
        self.log.parent.mkdir(parents=True, exist_ok=True)
        with self._lock, self.log.open("a") as f:
            f.write(json.dumps(line) + "\n")

    def session_count(self) -> int:
        with self._lock:
            return len(self._sessions)

    def health(self) -> dict:
        """`{ok, version, approved_at, rules, stale, backend, mode, sessions}`: which policy is live, and since when.

        `version` is what this process is enforcing right now. `stale` says the approvals file no longer certifies
        it (archived by a new run or `reset`, or the last reload refused to follow a lower version): production is
        still protected by what was last approved, but the Review page and this gateway have parted ways.
        """
        return {
            "ok": True,
            "version": self.cfg.version,
            "approved_at": approved_at(self.cfg.version),
            "rules": len(self.cfg.tool_policy.tool_rules),
            "stale": self.stale(),
            "backend": self.backend,
            "mode": "enforce" if self.enforce else "shadow",
            "sessions": self.session_count(),
        }

    def stale(self) -> bool:
        if self.version != "approved":
            return False
        return self._held is not None or state.approved_version() != self.cfg.version

    def reload(self) -> bool:
        """Re-read the policy (`self.version`) and swap it in, for new and open sessions alike; True when it changed.

        A config that cannot be loaded (a pinned version whose file went away, a torn write) leaves the live one in
        place: production keeps enforcing what it was enforcing rather than falling open. So does an `approved`
        version that is not above the live one: `approved_version()` reads 0 the moment a new run or `reset` archives
        approvals.json, and the next run's v1 is not this run's v1. A certified policy only moves up (rollback lands
        as a new, higher pending version); anything else is held and reported `stale` on /health.

        The backend's tool list is re-read on the same tick, so a tool added (or described) since start gets the class
        the Tools panel would show it with; a list that cannot be fetched keeps the classes already resolved.
        """
        self.refresh_tool_classes()
        try:
            fresh = load_policy_config(self.version)
        except Exception as e:  # noqa: BLE001
            print(f"gateway: reload failed, keeping v{self.cfg.version}: {type(e).__name__}: {e}", flush=True)
            return False
        if fresh == self.cfg:
            self._held = None
            return False
        if self.version == "approved" and fresh.version <= self.cfg.version:
            why = "approvals.json is gone (archived by a new run or reset)" if not state.approvals_path().exists() else f"approved is v{fresh.version}, not above the live version"
            self._held = f"refusing to follow approved v{fresh.version} ({len(fresh.tool_policy.tool_rules)} rules) from live v{self.cfg.version}: {why}"
            print(f"gateway: {self._held}; keeping v{self.cfg.version} ({len(self.cfg.tool_policy.tool_rules)} rules)", flush=True)
            return False
        with self._lock:
            self.cfg = fresh
            self._held = None
            for session, _, _ in self._sessions.values():
                session.cfg = fresh
        print(f"gateway: policy now v{fresh.version} ({len(fresh.tool_policy.tool_rules)} rules)", flush=True)
        return True

    def refresh_tool_classes(self) -> None:
        resolved = self._resolve_tool_classes()
        if not resolved or resolved == self.tool_classes:
            return
        with self._lock:
            self.tool_classes = resolved
            for session, _, _ in self._sessions.values():
                session.tool_classes = resolved

    def start_reloading(self, interval_s: float = RELOAD_INTERVAL_S) -> threading.Thread:
        """A daemon thread calling `reload()` every `interval_s`; `SIGHUP` (installed by `_main`) does it at once."""

        def _loop() -> None:
            while True:
                time.sleep(interval_s)
                self.reload()

        thread = threading.Thread(target=_loop, name="antibody-gateway-reload", daemon=True)
        thread.start()
        return thread


def same_backend(a: str | None, b: str | None) -> bool:
    """Whether two backend URLs name the same tools: trailing slashes aside (the gateway strips its own)."""
    return (a or "").rstrip("/") == (b or "").rstrip("/")


def for_backend(rows: list[dict], backend: str | None) -> list[dict]:
    """The rows a gateway in front of `backend` wrote; every row when there is no filter (None or empty).

    The log is one file per install, so this is what scopes it to one agent — the Agent page's Shadow log and the
    Review page's replay both go through here. Rows written before the field existed carry no `backend` and match
    no filter: nobody can say whose they were, so they must not leak into any agent's view.
    """
    if not backend:
        return rows
    return [row for row in rows if same_backend(row.get("backend"), backend)]


def replay(cfg: AgentConfig, rows: list[dict], samples: int = REPLAY_SAMPLES, backend: str | None = None) -> dict:
    """What `cfg`'s per-tool rules would have said about the recorded real traffic (the Review page's shadow-replay panel).

    `{version, calls, would_block, by_tool: {name: {calls, would_block}}, samples: [{tool, args, reason, at}]}`.
    Each session's state is rebuilt from its rows in order: `turn` rows feed the intent rule, a call the replayed
    rules would have let run counts toward `max_calls` and its `verified` ids satisfy `requires_verified_lookup`.
    Deterministic and pure: the same log and the same version always give the same numbers.

    `backend` narrows the log to one agent's traffic (`for_backend`): a retail version replayed over an airline
    agent's calls is noise.
    """
    rules = cfg.tool_policy.tool_rules
    turns: dict[str, list[str]] = {}
    verified: dict[str, set[str]] = {}
    ran: dict[str, Counter] = {}
    by_tool: dict[str, dict[str, int]] = {}
    out_samples: list[dict] = []
    calls = would_block = 0
    for row in for_backend(rows, backend):
        sid = str(row.get("session") or "")
        if "turn" in row and "tool" not in row:
            if isinstance(row["turn"], str):
                turns.setdefault(sid, []).append(row["turn"])
            continue
        tool = row.get("tool")
        if not isinstance(tool, str):
            continue
        args = row.get("args") if isinstance(row.get("args"), dict) else {}
        rule = rules.get(tool)
        reason = None
        if rule is not None:
            try:
                reason = tool_rule_blocks(tool, args, rule, turns.get(sid, []), verified.get(sid, set()), ran.setdefault(sid, Counter())[tool])
            except Exception as e:  # noqa: BLE001 - the live gateway would have refused too
                reason = f"policy: check failed on malformed arguments ({type(e).__name__})"
        calls += 1
        bucket = by_tool.setdefault(tool, {"calls": 0, "would_block": 0})
        bucket["calls"] += 1
        if reason:
            would_block += 1
            bucket["would_block"] += 1
            if len(out_samples) < samples:
                out_samples.append({"tool": tool, "args": args, "reason": reason, "at": row.get("at")})
            continue
        ran.setdefault(sid, Counter())[tool] += 1
        ids = row.get("verified")
        if isinstance(ids, list):
            verified.setdefault(sid, set()).update(str(v) for v in ids)
    return {"version": cfg.version, "calls": calls, "would_block": would_block, "by_tool": by_tool, "samples": out_samples}


def command_line(backend: str = "http://127.0.0.1:8791", *, enforce: bool = False, version: str = "approved") -> str:
    """The line Settings → Environment shows: how to start the gateway for this install, shadow spelled out."""
    return f"python -m chaos.gateway --backend {backend} --version {version} " + ("--enforce" if enforce else "--shadow")


def _main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description="Run the approved policy's rules in front of an agent's real tools.")
    parser.add_argument("--backend", required=True, help="where the real tools live: POST <backend>/tools/{name}")
    parser.add_argument("--port", type=int, default=int(os.environ.get("ANTIBODY_GATEWAY_PORT", DEFAULT_PORT)))
    parser.add_argument("--version", default="approved", help="'approved' (the certified version; default) or a saved version number")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--shadow", action="store_true", help="log what would be blocked and let every call run (the default; run this for a week first)")
    mode.add_argument("--enforce", action="store_true", help="block instead of logging what would have been blocked")
    args = parser.parse_args(argv)

    cfg = load_policy_config(args.version)
    gw = Gateway(args.backend, cfg, enforce=args.enforce, version=args.version)
    rules = ", ".join(sorted(cfg.tool_policy.tool_rules)) or "(none — every call is allowed and logged)"
    print(f"gateway on http://127.0.0.1:{args.port}  backend={gw.backend}  config=v{cfg.version}  mode={'enforce' if args.enforce else 'shadow'}", flush=True)
    print(f"rules for: {rules}", flush=True)
    print(f"log: {gw.log}", flush=True)
    print(f"auth: {'bearer required' if auth.configured(TOKEN_ENV) else 'open (set ' + TOKEN_ENV + ')'}  backend auth: {'forwarded' if gw.backend_auth else 'none'}", flush=True)
    print(f"weave: {init_weave()}", flush=True)
    gw.start_reloading()
    signal.signal(signal.SIGHUP, lambda *_: gw.reload())
    uvicorn.run(gw.app, host="127.0.0.1", port=args.port, log_level="warning")


if __name__ == "__main__":
    _main()
