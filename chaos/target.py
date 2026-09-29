"""The target seam: which agent runs an episode, chosen by name.

Antibody attacks, judges and repairs *some* support agent: the built-in one in `chaos.target_agent`, an
external agent behind HTTP that calls back into `chaos.toolserver`, or a hosted agent such as Intercom Fin
(`FinTarget`). Each receives the same thing — a `ToolSession` whose `call_tool` is the only way their tools run,
plus the opening message — and hands back an `Episode`. Everything else in the loop (Judge, Repair, gate) is
unchanged by which one ran.

The target is selected by the string in `ANTIBODY_TARGET` (`builtin`, the default, `http:<url>` or `fin:<label>`),
never by passing an object around: `run_target_agent` is a `@weave.op`, and an object argument would be
serialised as an input on every call.
"""

from __future__ import annotations

import html
import ipaddress
import json
import os
import re
import secrets
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from typing import Protocol, get_args

import weave

from chaos import toolserver
from chaos.schemas import Episode, PatchKind
from chaos.toolbus import ToolSession

TARGET_ENV = "ANTIBODY_TARGET"
DEFAULT_TARGET = "builtin"

ALL_PATCH_KINDS: frozenset[PatchKind] = frozenset(get_args(PatchKind))
# Patches enforced in the tool bus rather than in the prompt. An external agent never sees
# `cfg.system_prompt`, so these are the only kinds that can change what it does.
CODE_LEVEL_PATCH_KINDS: frozenset[PatchKind] = frozenset({"tighten_tool_policy", "add_tool_validator"})


def episode_thread(session: ToolSession):
    """The Weave thread one episode's calls join (plan 11 §4.2): `weave.thread(session_id)`, safe without a client.

    The session id is minted here when nothing set one, so every target's episode has a thread, and the tool
    server (`toolserver.register`) keeps it: an external agent's tool calls carry the same id in `X-Antibody-Session`
    and land in the same thread as sibling turns (Weave does not nest across processes; grouping is what it offers).
    """
    session.session_id = session.session_id or secrets.token_urlsafe(16)
    return weave.thread(session.session_id)


class Target(Protocol):
    """An agent Antibody can run one episode against."""

    name: str
    transport: str
    supported_patch_kinds: frozenset[PatchKind]

    def run_episode(self, session: ToolSession, opening_message: str) -> Episode: ...

    def tools(self) -> list[dict] | None:
        """The tools the agent says it has (`GET /tools`, `[{name, description}]`); None when it lists none."""
        ...


class BuiltinTarget:
    """The in-process agent in `chaos.target_agent`: same prompt, same model loop as before this seam existed."""

    name = DEFAULT_TARGET
    transport = "in-process"
    supported_patch_kinds = ALL_PATCH_KINDS

    def run_episode(self, session: ToolSession, opening_message: str) -> Episode:
        # Imported here because target_agent imports this module for resolution; the built-in model loop
        # is the one target that lives on the other side of that edge.
        from chaos.target_agent import run_builtin_episode

        return run_builtin_episode(session, opening_message)

    def tools(self) -> list[dict] | None:
        return None  # it holds the pack's tools, whichever pack is active: every legit task is in reach


class HttpTarget:
    """An agent behind `POST {url}/episode` that calls back into Antibody's tool server for every tool.

    One episode is one request: `{session_id, message, customer_id, customer_email, tools_url}` out,
    `{reply}` back. The agent's tool calls arrive at the tool server (in this process) under that
    session id while we wait, so by the time the reply lands `session.calls` is the full record.
    """

    transport = "http"
    supported_patch_kinds = CODE_LEVEL_PATCH_KINDS

    def __init__(self, url: str, timeout: float = 120.0):
        self.url = url.rstrip("/")
        self.name = f"http:{self.url}"
        self.timeout = timeout

    def run_episode(self, session: ToolSession, opening_message: str) -> Episode:
        # Server first: a port that cannot be bound is an operator error worth raising on the first episode.
        tools_url = toolserver.tools_url()
        session_id = toolserver.register(session)
        try:
            body = {
                "session_id": session_id,
                "message": opening_message,
                "customer_id": session.customer_id,
                "customer_email": session.customer_email,
                "tools_url": tools_url,
            }
            try:
                response = post_json(f"{self.url}/episode", body, self.timeout)
            except Exception as e:  # noqa: BLE001 - any transport failure is the episode's error, never a crash
                if is_timeout(e):
                    return session.episode("", error="target timed out")
                return session.episode("", error=f"target request failed: {e}")
            reply = response.get("reply") if isinstance(response, dict) else None
            if not isinstance(reply, str):
                return session.episode("", error="target returned no reply: expected {\"reply\": \"...\"}")
            return session.episode(reply)
        finally:
            toolserver.drop(session_id)

    def tools(self) -> list[dict] | None:
        return list_tools(self.url)


TOOLS_TIMEOUT_S = 2.0


def list_tools(url: str, timeout: float = TOOLS_TIMEOUT_S) -> list[dict] | None:
    """`GET <url>/tools` as `[{name, description}]`; None on any failure (the route is optional on the agent's side).

    Bare strings are accepted as names. The one reader of an agent's tool list: the connect ping, the schedule
    fingerprint and the loop's legit-coverage check all see the same shape.
    """
    try:
        doc = get_json(f"{url.rstrip('/')}/tools", timeout)
    except Exception:  # noqa: BLE001 - absent route, refused, timed out, not JSON: all mean "does not list tools"
        return None
    if not isinstance(doc, list):
        return None
    out = []
    for item in doc:
        if isinstance(item, dict) and isinstance(item.get("name"), str):
            out.append({"name": item["name"], "description": item.get("description") if isinstance(item.get("description"), str) else ""})
        elif isinstance(item, str):
            out.append({"name": item, "description": ""})
    return out


FIN_TOKEN_ENV = "INTERCOM_FIN_TOKEN"
FIN_URL_ENV = "INTERCOM_FIN_URL"
FIN_DEFAULT_URL = "https://api.intercom.io"
FIN_API_VERSION = "2.16"
FIN_EPISODE_CAP_S = 120.0
# The SSE stream is input from a remote: bounded in total bytes, per line, and in how long it may go silent between
# bytes (a byte-a-time server would otherwise defeat a deadline checked only between events).
FIN_STREAM_CAP_BYTES = 1 << 20
FIN_LINE_CAP_BYTES = 64 * 1024
FIN_IDLE_CAP_S = 60.0
FIN_TERMINAL = frozenset({"awaiting_user_reply", "complete", "escalated"})
TIMED_OUT = "timed out"


class FinTarget:
    """Intercom Fin, driven through the Fin Agent API (docs/plans/10-production-fit.md A7): the hosted-agent shape.

    `ANTIBODY_TARGET=fin:<label>` with `INTERCOM_FIN_TOKEN` (a bearer with `write_conversations`; access to the Fin
    Agent API is granted by Intercom on request; `INTERCOM_FIN_URL` relocates the API for tests). One episode is one
    `POST /fin/start` carrying the customer's message and identity, then the reply read off the
    `sse_subscription_url` the response returns (`fin_replied` parts, HTML stripped, until `fin_status_updated`
    says `awaiting_user_reply`, `complete` or `escalated`), capped at `FIN_EPISODE_CAP_S`. The API has no status
    endpoint and its other channel is a webhook, which cannot reach this process — so a workspace with SSE disabled
    fails the episode with a message saying so.

    Fin's tools are not observable: its Data connectors call the customer's own API directly, never through
    Antibody, so `tool_calls` is always empty, the judge has the transcript only, and the only enforcement point is
    the gateway placed in front of those connectors. `supported_patch_kinds` is therefore `tighten_tool_policy`
    alone — the one patch that reaches the gateway. Legit rows that expect a tool call cannot be satisfied by a Fin
    episode and read as over-refusal; judge Fin on transcript scenarios.
    """

    transport = "fin"
    supported_patch_kinds: frozenset[PatchKind] = frozenset({"tighten_tool_policy"})

    def __init__(self, label: str, *, base_url: str | None = None, token: str | None = None, cap_s: float = FIN_EPISODE_CAP_S):
        self.label = label
        self.name = f"fin:{label}"
        self.base_url = (base_url or os.environ.get(FIN_URL_ENV, "").strip() or FIN_DEFAULT_URL).rstrip("/")
        self._token = token
        self.cap_s = cap_s

    def token(self) -> str:
        return self._token or os.environ.get(FIN_TOKEN_ENV, "").strip()

    def tools(self) -> list[dict] | None:
        return None  # Fin's connectors are not observable, so nothing can be said about which tasks are in reach

    def run_episode(self, session: ToolSession, opening_message: str) -> Episode:
        token = self.token()
        if not token:
            return _fin_episode(session, "", error=f"{FIN_TOKEN_ENV} not set: the Fin Agent API needs a bearer with write_conversations")
        deadline = time.monotonic() + self.cap_s
        conversation_id = session.session_id or f"antibody-{secrets.token_urlsafe(8)}"
        body = {
            "conversation_id": conversation_id,
            "message": {"author": "user", "body": opening_message, "timestamp": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")},
            "user": {"id": session.customer_id or "antibody-customer", "email": session.customer_email},
        }
        headers = {"Authorization": f"Bearer {token}", "Intercom-Version": FIN_API_VERSION}
        try:
            started = post_json(f"{self.base_url}/fin/start", body, min(self.cap_s, 30.0), headers)
        except Exception as e:  # noqa: BLE001 - any transport failure is the episode's error, never a crash
            return _fin_episode(session, "", error=f"fin/start failed: {'timed out' if is_timeout(e) else e}")
        sse_url = started.get("sse_subscription_url") if isinstance(started, dict) else None
        if not isinstance(sse_url, str) or not sse_url:
            return _fin_episode(session, "", error="fin/start returned no sse_subscription_url: enable SSE for the Fin Agent API in Intercom (webhooks cannot reach this process)")
        if not _same_origin(sse_url, self.base_url):
            # The URL is data from the remote. Only the API's own scheme and host are followed: a `file://`, `data:` or
            # third-party URL would put whatever it names into the transcript the judge and history then see.
            return _fin_episode(session, "", error=f"fin/start returned an sse_subscription_url Antibody will not follow: not on {self.base_url}'s scheme and host")
        parts, status, reason, failure = _read_fin_stream(sse_url, deadline)
        reply = "\n\n".join(parts)
        if failure == TIMED_OUT:
            return _fin_episode(session, reply, error=f"Fin did not finish within {self.cap_s:g}s (last status: {status or 'none'})")
        if failure:
            return _fin_episode(session, reply, error=f"Fin stream ended early: {failure} (last status: {status or 'none'})")
        if status == "escalated":
            reply = (reply + "\n\n" if reply else "") + f"(Fin escalated this conversation to a human agent{': ' + reason if reason else ''})"
        return _fin_episode(session, reply)


def _same_origin(url: str, base: str) -> bool:
    """Whether `url` is on `base`'s scheme and host, or on a host under the same domain (`api.intercom.io` and
    `sse.intercom.io` are one API). An IP host is exact; the scheme must match, so https never becomes http."""
    u, b = urllib.parse.urlsplit(url), urllib.parse.urlsplit(base)
    if not u.scheme or u.scheme != b.scheme or not u.hostname or not b.hostname:
        return False
    if u.hostname == b.hostname:
        return True
    try:
        ipaddress.ip_address(b.hostname)
        return False
    except ValueError:
        pass
    labels = b.hostname.split(".")
    return len(labels) >= 2 and u.hostname.endswith("." + ".".join(labels[-2:]))


def _fin_episode(session: ToolSession, reply: str, error: str | None = None) -> Episode:
    """Fin ran no tool Antibody could see, so the record carries no domain state for the judge to compare."""
    episode = session.episode(reply, error=error)
    episode.domain = None
    episode.end_state = None
    return episode


def _read_fin_stream(url: str, deadline: float) -> tuple[list[str], str | None, str | None, str | None]:
    """Read Fin's SSE stream until a terminal status, the deadline or a cap: `(reply parts as text, last status,
    escalation reason, failure)`. `failure` is None on a clean finish, `TIMED_OUT` at the deadline, else what ended it.

    Events are `data: {json}` lines separated by blank lines (the SSE wire format); `fin_replied` carries a reply part
    as HTML, `fin_status_updated` the status. On API 2.16 the reply is done when `awaiting_user_reply` arrives as a
    status update; older versions put it on the reply itself, which is honoured too. `fin_reply_chunk` (streaming
    text) is skipped: the final `fin_replied` supersedes it. A `resolved` status is not the end — `complete` follows.
    """
    parts: list[str] = []
    status: str | None = None
    reason: str | None = None
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        return parts, status, reason, TIMED_OUT
    try:
        # The socket timeout is the idle cap: it fires when nothing at all arrives for that long.
        with _opener.open(urllib.request.Request(url, headers={"Accept": "text/event-stream"}), timeout=min(remaining, FIN_IDLE_CAP_S)) as resp:
            data_lines: list[str] = []
            for raw in _sse_lines(resp, deadline):
                line = raw.decode("utf-8", "replace").rstrip("\r")
                if line.startswith("data:"):
                    data_lines.append(line[5:].strip())
                    continue
                if line or not data_lines:
                    continue  # `event:`/`id:`/comments: the payload names the event itself
                event = _parse_fin_event("\n".join(data_lines))
                data_lines = []
                if event is None:
                    continue
                name = event.get("event_name")
                if name == "fin_replied":
                    message = event.get("message") if isinstance(event.get("message"), dict) else {}
                    text = html_to_text(str(message.get("body") or ""))
                    if text:
                        parts.append(text)
                    if event.get("status") == "awaiting_user_reply":
                        return parts, "awaiting_user_reply", reason, None
                elif name == "fin_status_updated":
                    status = str(event.get("status") or "")
                    if status == "escalated":
                        reason = str(event.get("reason") or "") or None
                    if status in FIN_TERMINAL:
                        return parts, status, reason, None
    except _StreamCap as e:
        return parts, status, reason, str(e)
    except Exception as e:  # noqa: BLE001 - a socket timeout is the idle cap or the deadline; anything else ends the episode with what we have
        if is_timeout(e):
            return parts, status, reason, TIMED_OUT if time.monotonic() >= deadline else f"no bytes for {FIN_IDLE_CAP_S:g}s"
        return parts, status, reason, f"stream failed: {e}"
    # The stream closed (Fin revokes the token on a terminal status).
    return parts, status, reason, None if status in FIN_TERMINAL else TIMED_OUT


class _StreamCap(Exception):
    """The stream went past a size cap; the message says which."""


def _sse_lines(resp, deadline: float):
    """The stream's lines, without their `\\n`, read chunk by chunk so the deadline and the caps hold against a server
    that sends a byte at a time or never sends a newline. Raises `_StreamCap`; `TimeoutError` at the deadline."""
    buf = bytearray()
    total = 0
    while True:
        if time.monotonic() >= deadline:
            raise TimeoutError("deadline")
        chunk = resp.read1(8192)
        if not chunk:
            if buf:
                yield bytes(buf)
            return
        total += len(chunk)
        if total > FIN_STREAM_CAP_BYTES:
            raise _StreamCap(f"exceeded {FIN_STREAM_CAP_BYTES >> 10} KiB")
        buf += chunk
        while (nl := buf.find(b"\n")) != -1:
            yield bytes(buf[:nl])
            del buf[: nl + 1]
        if len(buf) > FIN_LINE_CAP_BYTES:
            raise _StreamCap(f"a line exceeded {FIN_LINE_CAP_BYTES >> 10} KiB")


def _parse_fin_event(data: str) -> dict | None:
    try:
        doc = json.loads(data)
    except ValueError:
        return None
    return doc if isinstance(doc, dict) else None


def html_to_text(body: str) -> str:
    """Fin replies in HTML; the judge and the transcript want words. Block tags become line breaks, entities are decoded."""
    text = re.sub(r"(?i)<\s*br\s*/?>|</\s*(p|div|li|h[1-6]|tr)\s*>", "\n", body)
    text = re.sub(r"<[^>]+>", "", text)
    text = html.unescape(text)
    return "\n".join(" ".join(line.split()) for line in text.splitlines() if line.strip()).strip()


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """A 30x from the agent is a failed episode, not a request to be replayed at another address."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # urllib's signature
        return None  # declining here makes urllib raise the 30x as an HTTPError instead of following it


# No proxy from the environment (the agent is a local URL the operator typed; an `HTTP_PROXY` in the
# shell must not silently route episodes through it), no following of redirects, and http(s) only: the
# handlers are listed rather than defaulted, so `file://`, `data:` and `ftp://` — which urllib would otherwise
# open — are refused as unknown schemes. This is the one HTTP client Antibody points at an agent: the loop's
# episodes, the API's ping and Fin's stream all go through it.
_opener = urllib.request.OpenerDirector()
for _handler in (
    urllib.request.ProxyHandler({}),
    urllib.request.UnknownHandler(),
    urllib.request.HTTPHandler(),
    urllib.request.HTTPSHandler(),
    urllib.request.HTTPDefaultErrorHandler(),
    urllib.request.HTTPErrorProcessor(),
    _NoRedirect(),
):
    _opener.add_handler(_handler)

# A JSON reply bigger than this is not a tool result, a tool list or a Fin start document; read no further.
MAX_JSON_BYTES = 4 << 20


def _fetch_json(req: urllib.request.Request, timeout: float) -> object:
    try:
        with _opener.open(req, timeout=timeout) as resp:
            body = resp.read(MAX_JSON_BYTES + 1)
            if len(body) > MAX_JSON_BYTES:
                raise ValueError(f"response larger than {MAX_JSON_BYTES} bytes")
            return json.loads(body or b"null")
    except urllib.error.HTTPError as e:
        if 300 <= e.code < 400:
            raise RuntimeError("redirect") from e
        raise


def post_json(url: str, body: dict, timeout: float, headers: dict[str, str] | None = None) -> object:
    """`POST url` with a JSON body; the decoded JSON reply. Raises on transport errors, non-2xx and 30x.

    `headers` are added to the request (the tool bus sends `X-Antibody-Session` to a customer's backend this way).
    """
    data = json.dumps(body).encode()
    return _fetch_json(urllib.request.Request(url, data=data, method="POST", headers={"Content-Type": "application/json", **(headers or {})}), timeout)


def get_json(url: str, timeout: float, headers: dict[str, str] | None = None) -> object:
    """`GET url`; the decoded JSON reply. Same opener and error rules as `post_json`."""
    return _fetch_json(urllib.request.Request(url, method="GET", headers={"Accept": "application/json", **(headers or {})}), timeout)


def is_timeout(e: Exception) -> bool:
    # urllib surfaces a socket timeout either bare or wrapped as URLError(reason=TimeoutError).
    return isinstance(e, TimeoutError) or isinstance(getattr(e, "reason", None), TimeoutError)


def target_name() -> str:
    """The configured target's canonical name (`ANTIBODY_TARGET`, normalised); `builtin` when unset or blank."""
    return resolve_target(_configured()).name


def _configured() -> str:
    return os.environ.get(TARGET_ENV, "").strip() or DEFAULT_TARGET


def resolve_target(name: str | None = None) -> Target:
    """Pick the target by name (default: `ANTIBODY_TARGET`). `builtin`, `http:<url>` / a bare `http(s)://` URL, or `fin:<label>`."""
    name = (name or _configured()).strip()
    if name == DEFAULT_TARGET:
        return BuiltinTarget()
    if name.startswith(("http://", "https://")):
        return HttpTarget(name)
    if name.startswith("http:"):
        url = name.removeprefix("http:")
        return HttpTarget(url if url.startswith(("http://", "https://")) else f"http://{url}")
    if name.startswith("fin:") and name[4:].strip():
        return FinTarget(name[4:].strip())
    raise ValueError(f"unknown target {name!r}: set {TARGET_ENV} to 'builtin', 'http:<url>' or 'fin:<label>'")


def banned_patch_kinds(target: Target) -> list[PatchKind]:
    """Patch kinds Repair must not propose for this target, sorted for stable prompts and logs."""
    return sorted(ALL_PATCH_KINDS - target.supported_patch_kinds)
