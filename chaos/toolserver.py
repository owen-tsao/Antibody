"""The tool server: Antibody's tools, served over HTTP to an agent we did not write.

An external agent never imports `chaos`. It receives a `session_id` in its `/episode` request and calls
back here with it in the `X-Antibody-Session` header; every call lands in `call_tool` against that
session, so the policy, the fault and the validators apply exactly as they do for the built-in agent.

HTTP contract (all bodies JSON):

    GET  /tools                 header X-Antibody-Session: <id>
         200  the OpenAI-style tool specs this session may call (ticket tools only in ticket mode)
         404  {"detail": "unknown session"}  header missing or session already dropped

    POST /tools/{name}          header X-Antibody-Session: <id>, body = the tool's arguments as an object
         200  the tool result as the built-in agent would see it. Blocked calls and unknown tools are
              *also* 200 with {"error": "..."}: to the agent they are tool output, not transport failures.
              A body that is not a JSON object — not JSON, not UTF-8, or over MAX_BODY_BYTES — is treated
              as `{}`, the same as the built-in harness does with arguments the model failed to serialise,
              and the call is still recorded.
         404  {"detail": "unknown session"}

The server runs in a daemon thread inside the loop process, started by `HttpTarget` on first use, one per
process, on `ANTIBODY_TOOLS_PORT` (default 8765; 0 picks a free port). It stops when the process does: a
daemon thread dies with the interpreter, there is nothing to flush because sessions live only in memory,
and an episode in flight at that moment was already lost with the loop.

Concurrency: the gate runs ~3 episodes at once, each with its own session; `call_tool` only mutates its
own session, and the registry is guarded by a lock. If that ever looks racy, run the loop with
`WEAVE_PARALLELISM=1` when the target is external (one episode at a time, ~3x slower gate) rather than
debugging it under time pressure.
"""

from __future__ import annotations

import json
import os
import secrets
import socket
import threading
import time
from typing import Any, Callable

import uvicorn
import weave
from fastapi import FastAPI, Header, HTTPException, Request, Response
from starlette.concurrency import run_in_threadpool

from chaos.schemas import ToolCall
from chaos.toolbus import SESSION_HEADER, ToolSession, call_tool
from chaos.tools import serialize_result

PORT_ENV = "ANTIBODY_TOOLS_PORT"
DEFAULT_PORT = 8765
# Tool arguments are a handful of short strings and numbers; anything this large is not arguments.
MAX_BODY_BYTES = 64 * 1024

_sessions: dict[str, ToolSession] = {}
_sessions_lock = threading.Lock()


def register(session: ToolSession) -> str:
    """Make a session reachable over HTTP; returns the id the agent must send back on every tool call.

    The id is `session.session_id` when the episode already minted one (`chaos.target.episode_thread`, so the agent's
    tool calls join the episode's Weave thread), else a fresh token written there, so a pass-through session forwards
    it to the backend either way.
    """
    session_id = session.session_id or secrets.token_urlsafe(16)
    session.session_id = session_id
    with _sessions_lock:
        _sessions[session_id] = session
    return session_id


def drop(session_id: str) -> None:
    with _sessions_lock:
        _sessions.pop(session_id, None)


def _session_or_404(session_id: str | None) -> ToolSession:
    with _sessions_lock:
        session = _sessions.get(session_id) if session_id else None
    if session is None:
        raise HTTPException(status_code=404, detail="unknown session")
    return session


def build_app(
    session_for: Callable[[str | None], ToolSession],
    list_tools: Callable[[ToolSession], list[dict[str, Any]]],
    after_call: Callable[[str, ToolSession, ToolCall], None] | None = None,
    title: str = "Antibody tool server",
) -> FastAPI:
    """The HTTP contract above over any session registry: the loop's (below) or the gateway's (`chaos.gateway`),
    which creates a session on first sight, lists the real backend's tools and logs every call."""
    app = FastAPI(title=title, docs_url=None, redoc_url=None, openapi_url=None)

    @app.get("/tools")
    def _list_tools(x_antibody_session: str | None = Header(default=None, alias=SESSION_HEADER)) -> list[dict[str, Any]]:
        return list_tools(session_for(x_antibody_session))

    @app.post("/tools/{name}")
    async def _run_tool(
        name: str,
        request: Request,
        x_antibody_session: str | None = Header(default=None, alias=SESSION_HEADER),
    ) -> Response:
        session = session_for(x_antibody_session)
        args = _parse_args(await request.body())
        # Tools may block (Zendesk, a faulted timeout, a real backend); off the event loop so concurrent sessions do not queue.
        call = await run_in_threadpool(traced_call_tool, session, name, args, x_antibody_session)
        if after_call is not None:
            after_call(x_antibody_session or "", session, call)
        return Response(content=serialize_result(call.result), media_type="application/json")

    return app


def traced_call_tool(session: ToolSession, name: str, args: dict[str, Any], session_id: str | None) -> ToolCall:
    """`call_tool` inside `weave.thread(session_id)` when this process traces (plan 11 §4.2), plain otherwise.

    The id is the agent's `X-Antibody-Session`, which is the episode's thread id, so an external agent's tool calls
    show up in the same Weave thread as the episode that made them. Threads are contextvars: opened here, on the
    worker thread the tool runs on, or the tool's own ops would not see it. In the loop process the client exists
    (the tool server is a daemon thread of it); the gateway has one only on `ANTIBODY_GATEWAY_WEAVE=1`; with none,
    nothing is entered at all.
    """
    if not session_id or weave.get_client() is None:
        return call_tool(session, name, args)
    with weave.thread(session_id):
        return call_tool(session, name, args)


app = build_app(_session_or_404, lambda s: s.domain.specs(s.ticket_mode))


def _parse_args(raw: bytes) -> dict[str, Any]:
    """The request body as tool arguments; anything that is not a JSON object becomes `{}` (still recorded)."""
    if not raw or len(raw) > MAX_BODY_BYTES:
        return {}
    try:
        args = json.loads(raw)
    except ValueError:  # covers JSONDecodeError and the UnicodeDecodeError a non-UTF-8 body raises
        return {}
    return args if isinstance(args, dict) else {}


# --- lifecycle: one server per process ----------------------------------------------------------------

_server_lock = threading.Lock()
_server: uvicorn.Server | None = None
_server_port: int | None = None


def configured_port() -> int:
    return int(os.environ.get(PORT_ENV, "").strip() or DEFAULT_PORT)


def ensure_server(port: int | None = None, startup_timeout: float = 10.0) -> int:
    """Start the server in a daemon thread if it is not running yet; returns the port it listens on.

    Idempotent: later calls (with any `port`) return the port the first call bound. Blocks until the
    server accepts connections so the first `/episode` never races the agent's first tool call.
    """
    global _server, _server_port
    with _server_lock:
        if _server is not None and _server_port is not None:
            return _server_port
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        sock.bind(("127.0.0.1", configured_port() if port is None else port))
        bound_port = sock.getsockname()[1]
        server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=bound_port, log_level="warning"))
        thread = threading.Thread(target=server.run, kwargs={"sockets": [sock]}, name="antibody-toolserver", daemon=True)
        thread.start()
        deadline = time.monotonic() + startup_timeout
        while not server.started:
            if not thread.is_alive():
                raise RuntimeError("tool server thread exited before it started listening")
            if time.monotonic() > deadline:
                raise RuntimeError(f"tool server did not start listening on port {bound_port} within {startup_timeout}s")
            time.sleep(0.01)
        _server, _server_port = server, bound_port
        return bound_port


def tools_url() -> str:
    """Where a local agent should send tool calls; starts the server if needed."""
    return f"http://127.0.0.1:{ensure_server()}"


# --- standalone, for developing an external agent without running the loop -------------------------------


def _main(argv: list[str] | None = None) -> None:
    import argparse
    import signal
    from pathlib import Path

    from chaos.domains import active_domain
    from chaos.schemas import AgentConfig
    from chaos.target_agent import new_session, v0_config

    parser = argparse.ArgumentParser(description="Serve Antibody's tools for one fixed session, for agent development.")
    parser.add_argument("--config", default="v0", help="'v0' for the initial config, or a path to a config JSON")
    parser.add_argument("--scenario", default="seed-injection-refund", help="seed or legit scenario id")
    parser.add_argument("--session", default="dev", help="the session id to accept (default: dev)")
    args = parser.parse_args(argv)

    domain = active_domain()
    cfg = v0_config(domain) if args.config == "v0" else AgentConfig(**json.loads(Path(args.config).read_text()))
    scenarios = {s.id: s for s in domain.seeds + domain.legit}
    if args.scenario not in scenarios:
        raise SystemExit(f"unknown scenario {args.scenario!r}; one of {sorted(scenarios)}")
    session = new_session(cfg, scenarios[args.scenario], ticket_mode=False, domain=domain)
    session.session_id = args.session
    with _sessions_lock:
        _sessions[args.session] = session

    port = ensure_server()
    print(f"tools_url=http://127.0.0.1:{port}  {SESSION_HEADER}: {args.session}  config=v{cfg.version}  scenario={args.scenario}", flush=True)
    print("Ctrl-C to stop; the recorded calls are printed on exit.", flush=True)
    try:
        signal.pause()
    except KeyboardInterrupt:
        pass
    for i, call in enumerate(session.calls, 1):
        print(f"{i}. {call.model_dump_json()}")


if __name__ == "__main__":
    _main()
