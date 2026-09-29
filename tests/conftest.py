"""Shared test scaffolding: a history folder in the loop's flat archive shape, built from the committed golden run.

Nothing here touches inference or a live loop, and nothing may touch the checkout's own state: before `chaos` is
imported for the first time this file points `ANTIBODY_RUNS_DIR` / `ANTIBODY_HISTORY_DIR` at a scratch directory
for the whole session (`chaos.state` resolves both at import, and `api.store` / `api.loop_ctl` copy them at import
too, so a per-test monkeypatch of one module was never enough — a forgotten patch used to rewrite the repo's
`runs/approvals.json`), sets `ANTIBODY_NO_DOTENV=1` so `chaos.config.load_env` leaves `.env` alone, and drops
`WANDB_API_KEY` from the environment. `uv run pytest -q` is therefore keyless as written; no `env -u` needed.
"""

from __future__ import annotations

import json
import os
import shutil
import tempfile
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Iterator

import pytest
from fastapi.testclient import TestClient

SCRATCH = Path(tempfile.mkdtemp(prefix="antibody-tests-")).resolve()
os.environ["ANTIBODY_RUNS_DIR"] = str(SCRATCH / "runs")
os.environ["ANTIBODY_HISTORY_DIR"] = str(SCRATCH / "history")
os.environ["ANTIBODY_NO_DOTENV"] = "1"
os.environ.pop("WANDB_API_KEY", None)

from chaos.state import GOLDEN_DIR  # noqa: E402 - must follow the environment above

GOLDEN_CYCLES = 6
SESSION_HEADER = "X-Antibody-Session"


@pytest.fixture(autouse=True, scope="session")
def _state_lives_in_scratch() -> Iterator[None]:
    """Fail the whole session, not one test, if any module resolved a runs/history path outside the scratch dir."""
    from api import loop_ctl, store
    from chaos import state

    for name, path in (
        ("state.RUNS_DIR", state.RUNS_DIR),
        ("state.HISTORY_DIR", state.HISTORY_DIR),
        ("state.CYCLES_PATH", state.CYCLES_PATH),
        ("store.HISTORY_DIR", store.HISTORY_DIR),
        ("loop_ctl.RUNS_DIR", loop_ctl.RUNS_DIR),
    ):
        assert path.is_relative_to(SCRATCH), f"{name} = {path} is outside the test scratch dir {SCRATCH}; chaos was imported before conftest set the environment"
    assert "WANDB_API_KEY" not in os.environ, "the suite must run keyless"
    yield
    shutil.rmtree(SCRATCH, ignore_errors=True)


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


def http_json(method: str, url: str, body: Any = None, headers: dict[str, str] | None = None, timeout: float = 5.0) -> tuple[int, Any]:
    """A plain urllib request that returns `(status, decoded body)` for 2xx and error responses alike."""
    data = None if body is None else (body if isinstance(body, bytes) else json.dumps(body).encode())
    req = urllib.request.Request(url, data=data, method=method, headers={"Content-Type": "application/json", **(headers or {})})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, json.loads(resp.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read())


class FakeAgent:
    """The smallest thing that satisfies plan 01's contract: `POST /episode` in, one tool call out, `{reply}` back.

    `tools` (a list of `{name, description}`) makes it also answer `GET /tools`, the optional route the connect
    screen uses; `None` means 404 there, like an agent that never heard of it. `raw_reply` replaces the JSON
    reply body wholesale, for agents that answer with something other than `{reply}`. `calls` scripts the tool
    calls the agent makes per episode (`[(name, args), ...]`, each sent with the session header); the default
    is the one `lookup_order` of `A-1001` the connect-screen tests were written against.
    """

    def __init__(
        self,
        delay: float = 0.0,
        tools: list[dict] | None = None,
        raw_reply: bytes | None = None,
        status: int = 200,
        calls: list[tuple[str, dict]] | None = None,
    ):
        self.delay = delay
        self.tools = tools
        self.raw_reply = raw_reply
        self.status = status
        self.calls = calls
        self.received: list[dict[str, Any]] = []
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_: Any) -> None:
                pass

            def _send(self, status: int, payload: bytes) -> None:
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

            def do_GET(self) -> None:
                if self.path == "/tools" and outer.tools is not None:
                    self._send(200, json.dumps(outer.tools).encode())
                else:
                    self._send(404, b'{"detail": "Not Found"}')

            def do_POST(self) -> None:
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                outer.received.append(body)
                time.sleep(outer.delay)
                if outer.status != 200:
                    self._send(outer.status, b'{"detail": "broken"}')
                    return
                if outer.raw_reply is not None:
                    self._send(200, outer.raw_reply)
                    return
                headers = {SESSION_HEADER: body["session_id"]}
                try:
                    if outer.calls is None:
                        status, order = http_json("POST", f"{body['tools_url']}/tools/lookup_order", {"order_id": "A-1001"}, headers, timeout=2.0)
                        text = f"order {order['order_id']} is {order['status']}" if status == 200 else f"tools said {status}"
                    else:
                        results = [http_json("POST", f"{body['tools_url']}/tools/{name}", args, headers, timeout=2.0) for name, args in outer.calls]
                        text = "; ".join(f"{name} -> {json.dumps(result)}" for (name, _), (_, result) in zip(outer.calls, results))
                except OSError as e:
                    # Nothing listening at tools_url (a ping): the tool error is tool output, and the agent still replies.
                    text = f"I could not reach my tools ({type(e).__name__})"
                self._send(200, json.dumps({"reply": f"Hi {body['customer_email']}, {text}."}).encode())

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()


@pytest.fixture
def fake_agent() -> Iterator[FakeAgent]:
    agent = FakeAgent()
    yield agent
    agent.close()


class FakeFin:
    """Intercom's Fin Agent API, as far as `chaos.target.FinTarget` needs it (plan 10 A7; the real one is by request only).

    `POST /fin/start` and `POST /fin/reply` record the body and headers and answer `{conversation_id, user_id,
    status: "thinking", sse_subscription_url}` — or no SSE URL when `sse=False`, like a workspace with SSE off.
    `GET /event-stream` plays `events` (dicts, one `data:` line each, `gap` seconds apart) and then, when `hang` is
    set, keeps the connection open without sending anything until the server closes — the slow-Fin case.
    `sse_url` replaces the URL `/fin/start` hands back (a hostile or mis-set API). `raw` replaces the events with
    exact bytes on the stream; `trickle` is written after it one byte every `drip` seconds (a byte-a-time server).
    """

    def __init__(self, events: list[dict], *, sse: bool = True, gap: float = 0.0, hang: bool = False, sse_url: str | None = None, raw: bytes | None = None, trickle: bytes | None = None, drip: float = 0.5):
        self.events = events
        self.sse = sse
        self.gap = gap
        self.hang = hang
        self.sse_url = sse_url
        self.raw = raw
        self.trickle = trickle
        self.drip = drip
        self.started: list[dict[str, Any]] = []
        self.headers: list[dict[str, str]] = []
        self.stream_hits = 0
        self._closed = False
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_: Any) -> None:
                pass

            def do_POST(self) -> None:
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])) or b"{}")
                outer.started.append({"path": self.path, **body})
                outer.headers.append({k: v for k, v in self.headers.items() if k.lower() in ("authorization", "intercom-version")})
                doc = {"conversation_id": body.get("conversation_id"), "user_id": "user-1", "status": "thinking", "created_at_ms": "2026-01-01T00:00:00.000Z"}
                if outer.sse:
                    doc["sse_subscription_url"] = outer.sse_url or f"{outer.url}/event-stream?channels=fin_agent_api:app:{body.get('conversation_id')}&accessToken=jwt&rewind=2m"
                payload = json.dumps(doc).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

            def do_GET(self) -> None:
                if not self.path.startswith("/event-stream"):
                    self.send_response(404)
                    self.end_headers()
                    return
                outer.stream_hits += 1
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Cache-Control", "no-cache")
                self.end_headers()
                try:
                    if outer.raw is not None:
                        self.wfile.write(outer.raw)
                        self.wfile.flush()
                    for i in range(len(outer.trickle or b"")):
                        if outer._closed:
                            return
                        time.sleep(outer.drip)
                        self.wfile.write(outer.trickle[i : i + 1])
                        self.wfile.flush()
                    for event in outer.events:
                        time.sleep(outer.gap)
                        self.wfile.write(f"event: message\ndata: {json.dumps(event)}\n\n".encode())
                        self.wfile.flush()
                    while outer.hang and not outer._closed:
                        time.sleep(0.05)
                except (BrokenPipeError, ConnectionResetError):
                    pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self) -> None:
        self._closed = True
        self.server.shutdown()
        self.server.server_close()


class FakeToolBackend:
    """A customer's own tool server (plan 09 §4): `POST /tools/{name}` with the args, one JSON result back.

    `results` maps a tool name to what it returns; anything else answers 404. Every call is kept in `received`
    as `(name, args)` so a test can assert what reached the real tool — and what a rule kept from reaching it.
    `sessions` keeps the `X-Antibody-Session` value of every call (None when absent), in the same order, and `auth`
    the `Authorization` header the same way. `tools` makes it answer `GET /tools` (None → 404, like the default).
    `delay` sleeps before every answer (a slow backend); `status_for` overrides the HTTP status per tool (a 500 is a
    backend failure, which the gateway decides by tool class).
    """

    def __init__(self, results: dict[str, Any], *, tools: list[dict] | None = None, delay: float = 0.0, status_for: dict[str, int] | None = None):
        self.results = results
        self.tools = tools
        self.delay = delay
        self.status_for = status_for or {}
        self.received: list[tuple[str, dict]] = []
        self.sessions: list[str | None] = []
        self.auth: list[str | None] = []
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_: Any) -> None:
                pass

            def _send(self, status: int, payload: bytes) -> None:
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

            def do_GET(self) -> None:
                outer.auth.append(self.headers.get("Authorization"))
                if self.path == "/tools" and outer.tools is not None:
                    self._send(200, json.dumps(outer.tools).encode())
                else:
                    self._send(404, b'{"detail": "Not Found"}')

            def do_POST(self) -> None:
                name = self.path.rsplit("/", 1)[-1]
                args = json.loads(self.rfile.read(int(self.headers["Content-Length"])) or b"{}")
                outer.received.append((name, args))
                outer.sessions.append(self.headers.get(SESSION_HEADER))
                outer.auth.append(self.headers.get("Authorization"))
                time.sleep(outer.delay)
                if name in outer.status_for:
                    self._send(outer.status_for[name], b'{"detail": "broken"}')
                elif name not in outer.results:
                    self._send(404, b'{"detail": "no such tool"}')
                else:
                    self._send(200, json.dumps(outer.results[name]).encode())

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()
