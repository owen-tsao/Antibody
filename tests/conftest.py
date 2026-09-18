"""Shared test scaffolding: a history folder in the loop's flat archive shape, built from the committed golden run.

pytest is not a project dependency (`uv run --with pytest pytest`); nothing here touches inference or a live loop.
"""

from __future__ import annotations

import json
import shutil
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Iterator

import pytest
from fastapi.testclient import TestClient

from chaos.state import GOLDEN_DIR

GOLDEN_CYCLES = 6
SESSION_HEADER = "X-Antibody-Session"


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
    reply body wholesale, for agents that answer with something other than `{reply}`.
    """

    def __init__(self, delay: float = 0.0, tools: list[dict] | None = None, raw_reply: bytes | None = None):
        self.delay = delay
        self.tools = tools
        self.raw_reply = raw_reply
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
                if outer.raw_reply is not None:
                    self._send(200, outer.raw_reply)
                    return
                try:
                    status, order = http_json(
                        "POST", f"{body['tools_url']}/tools/lookup_order", {"order_id": "A-1001"},
                        {SESSION_HEADER: body["session_id"]}, timeout=2.0,
                    )
                    text = f"order {order['order_id']} is {order['status']}" if status == 200 else f"tools said {status}"
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
