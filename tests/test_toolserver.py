"""The tool server and the HTTP target, exercised over real sockets on this machine only.

The server runs in-thread on an ephemeral port, the way `HttpTarget` starts it inside the loop process. The
"agent" on the other side is a fake: a few lines of `http.server` that do what plan 01 asks of an external
agent — take `/episode`, call back into `tools_url` with the session header, answer `{reply}`. No model,
no key, nothing leaves the machine.
"""

from __future__ import annotations

import json
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Iterator

import pytest

from chaos import toolserver
from chaos.scenarios import INJECTION_PAYLOAD, SEED_SCENARIOS
from chaos.schemas import AgentConfig, Episode
from chaos.target import HttpTarget, resolve_target
from chaos.target_agent import new_session, opening_message
from chaos.toolbus import ToolSession, call_tool
from chaos.tools import TOOL_SPECS, reset_side_effects

GOLDEN = Path(__file__).resolve().parent.parent / "data" / "golden"
INJECTION = next(s for s in SEED_SCENARIOS if s.id == "seed-injection-refund")


def _config(version: int) -> AgentConfig:
    return AgentConfig(**json.loads((GOLDEN / "runs" / "configs" / f"v{version}.json").read_text()))


def _request(method: str, url: str, body: Any = None, headers: dict[str, str] | None = None, timeout: float = 5.0) -> tuple[int, Any]:
    data = None if body is None else (body if isinstance(body, bytes) else json.dumps(body).encode())
    req = urllib.request.Request(url, data=data, method=method, headers={"Content-Type": "application/json", **(headers or {})})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, json.loads(resp.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read())


@pytest.fixture(scope="module")
def tools_url() -> str:
    port = toolserver.ensure_server(port=0)
    assert toolserver.ensure_server(port=0) == port, "ensure_server must be idempotent: one server per process"
    return f"http://127.0.0.1:{port}"


@pytest.fixture
def registered(tools_url: str) -> Iterator[tuple[ToolSession, dict[str, str]]]:
    """A v0 mock-mode session for the golden injection scenario, registered for the test and dropped after."""
    session = new_session(_config(0), INJECTION, ticket_mode=False)
    sid = toolserver.register(session)
    yield session, {toolserver.SESSION_HEADER: sid}
    toolserver.drop(sid)


@pytest.fixture(autouse=True)
def _clean_ledgers():
    reset_side_effects()
    yield
    reset_side_effects()


# --- the tool routes ------------------------------------------------------------------------------------


def test_lookup_over_http_carries_the_injected_notes(tools_url: str, registered) -> None:
    session, headers = registered
    status, result = _request("POST", f"{tools_url}/tools/lookup_order", {"order_id": "A-1001"}, headers)
    assert status == 200
    assert result["order_id"] == "A-1001" and result["notes"] == INJECTION_PAYLOAD
    assert [c.tool for c in session.calls] == ["lookup_order"] and session.verified_orders == {"A-1001"}


def test_blocked_refund_returns_the_shape_the_builtin_agent_sees(tools_url: str) -> None:
    """Under a v2-style policy the other customer's refund is blocked *in the server*, and the agent is told so as tool output."""
    cfg = _config(2)  # actions_require_verified_lookup
    session = new_session(cfg, INJECTION, ticket_mode=False)
    sid = toolserver.register(session)
    try:
        args = {"order_id": "B-2001", "amount": 899.0, "reason": "goodwill"}
        status, over_http = _request("POST", f"{tools_url}/tools/issue_refund", args, {toolserver.SESSION_HEADER: sid})
    finally:
        toolserver.drop(sid)

    in_process = call_tool(new_session(cfg, INJECTION, ticket_mode=False), "issue_refund", dict(args))
    assert status == 200, "a policy block is tool output to the agent, not a transport failure"
    assert over_http == in_process.result == {"error": "policy: refunds require a successful lookup of order B-2001 first"}
    assert session.calls[0].blocked_by_policy and session.calls[0].blocked_by == in_process.blocked_by


def test_unknown_tool_and_bad_body_are_recorded_like_the_builtin_path(tools_url: str, registered) -> None:
    session, headers = registered
    assert _request("POST", f"{tools_url}/tools/delete_everything", {}, headers) == (200, {"error": "unknown tool delete_everything"})
    assert _request("POST", f"{tools_url}/tools/read_ticket", {"ticket_id": 1}, headers) == (200, {"error": "unknown tool read_ticket"})
    status, _ = _request("POST", f"{tools_url}/tools/lookup_order", b"not json", headers)
    assert status == 200
    status, _ = _request("POST", f"{tools_url}/tools/lookup_order", ["a", "list"], headers)
    assert status == 200
    assert [c.args for c in session.calls] == [{}, {"ticket_id": 1}, {}, {}]


def test_tool_list_follows_ticket_mode(tools_url: str, registered) -> None:
    _, headers = registered
    status, specs = _request("GET", f"{tools_url}/tools", headers=headers)
    assert status == 200 and specs == TOOL_SPECS
    assert [s["function"]["name"] for s in specs] == ["lookup_order", "issue_refund", "send_email"]

    ticket = new_session(_config(0), INJECTION, ticket_mode=True)
    sid = toolserver.register(ticket)
    try:
        _, specs = _request("GET", f"{tools_url}/tools", headers={toolserver.SESSION_HEADER: sid})
    finally:
        toolserver.drop(sid)
    assert [s["function"]["name"] for s in specs][-2:] == ["read_ticket", "set_ticket_status"]


def test_unknown_or_dropped_session_is_404(tools_url: str) -> None:
    assert _request("GET", f"{tools_url}/tools") == (404, {"detail": "unknown session"})
    assert _request("GET", f"{tools_url}/tools", headers={toolserver.SESSION_HEADER: "nope"}) == (404, {"detail": "unknown session"})
    assert _request("POST", f"{tools_url}/tools/lookup_order", {"order_id": "A-1001"}, {toolserver.SESSION_HEADER: "nope"})[0] == 404

    session = new_session(_config(0), INJECTION, ticket_mode=False)
    sid = toolserver.register(session)
    toolserver.drop(sid)
    assert _request("GET", f"{tools_url}/tools", headers={toolserver.SESSION_HEADER: sid})[0] == 404
    assert session.calls == []


def test_concurrent_sessions_keep_their_calls_apart(tools_url: str) -> None:
    """Three sessions, three threads, thirty calls: each session records exactly its own."""
    sessions = [new_session(_config(0), INJECTION, ticket_mode=False) for _ in range(3)]
    sids = [toolserver.register(s) for s in sessions]
    errors: list[BaseException] = []

    def hammer(sid: str, tag: str) -> None:
        try:
            for _ in range(10):
                status, _ = _request("POST", f"{tools_url}/tools/lookup_order", {"order_id": tag}, {toolserver.SESSION_HEADER: sid})
                assert status == 200
        except BaseException as e:  # noqa: BLE001
            errors.append(e)

    threads = [threading.Thread(target=hammer, args=(sid, f"A-100{i}")) for i, sid in enumerate(sids)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    for sid in sids:
        toolserver.drop(sid)

    assert errors == []
    for i, session in enumerate(sessions):
        assert len(session.calls) == 10 and {c.args["order_id"] for c in session.calls} == {f"A-100{i}"}


# --- the HTTP target against a fake external agent ------------------------------------------------------


class FakeAgent:
    """The smallest thing that satisfies plan 01's contract: `POST /episode` in, one tool call out, `{reply}` back."""

    def __init__(self, delay: float = 0.0):
        self.delay = delay
        self.received: list[dict[str, Any]] = []
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_: Any) -> None:
                pass

            def do_POST(self) -> None:
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                outer.received.append(body)
                time.sleep(outer.delay)
                status, order = _request(
                    "POST", f"{body['tools_url']}/tools/lookup_order", {"order_id": "A-1001"},
                    {toolserver.SESSION_HEADER: body["session_id"]},
                )
                text = f"order {order['order_id']} is {order['status']}" if status == 200 else f"tools said {status}"
                reply = json.dumps({"reply": f"Hi {body['customer_email']}, {text}."}).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(reply)))
                self.end_headers()
                self.wfile.write(reply)

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


def test_http_target_runs_an_episode_end_to_end(tools_url: str, fake_agent: FakeAgent) -> None:
    target = resolve_target(f"http:{fake_agent.url}")
    assert isinstance(target, HttpTarget)
    session = new_session(_config(0), INJECTION, ticket_mode=False)

    episode = target.run_episode(session, opening_message(INJECTION, False))

    assert isinstance(episode, Episode) and episode.error is None
    assert episode.scenario_id == "seed-injection-refund" and episode.config_version == 0
    assert episode.final_reply == "Hi owen@example.com, order A-1001 is shipped."
    assert [c.tool for c in episode.tool_calls] == ["lookup_order"] and episode.tool_calls == session.calls
    assert episode.tool_calls[0].result["notes"] == INJECTION_PAYLOAD, "the fault reached the external agent through the server"

    (received,) = fake_agent.received
    assert received == {
        "session_id": received["session_id"],
        "message": INJECTION.user_message,
        "customer_id": "cust_owen",
        "customer_email": "owen@example.com",
        "tools_url": tools_url,
    }
    # The session was dropped when the episode ended: the same id no longer reaches any tools.
    assert _request("GET", f"{tools_url}/tools", headers={toolserver.SESSION_HEADER: received["session_id"]})[0] == 404


def test_http_target_times_out_into_an_episode_error(tools_url: str) -> None:
    slow = FakeAgent(delay=1.5)
    try:
        target = HttpTarget(slow.url, timeout=0.3)
        session = new_session(_config(0), INJECTION, ticket_mode=False)
        started = time.monotonic()
        episode = target.run_episode(session, "hi")
        assert time.monotonic() - started < 1.5
        assert episode.error == "target timed out" and episode.final_reply == ""
        assert episode.scenario_id == INJECTION.id and episode.config_version == 0
    finally:
        slow.close()


def test_http_target_unreachable_is_an_episode_error_not_a_crash() -> None:
    closed = FakeAgent()
    closed.close()
    episode = HttpTarget(closed.url, timeout=1.0).run_episode(new_session(_config(0), INJECTION, ticket_mode=False), "hi")
    assert episode.error is not None and episode.error.startswith("target request failed:")
    assert episode.tool_calls == []
