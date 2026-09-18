"""The target seam: which agent runs an episode, chosen by name.

Antibody attacks, judges and repairs *some* support agent: the built-in one in `chaos.target_agent`, or an
external agent behind HTTP that calls back into `chaos.toolserver`. Both receive the same thing — a `ToolSession`
whose `call_tool` is the only way their tools run, plus the opening message — and hand back an `Episode`.
Everything else in the loop (Judge, Repair, gate) is unchanged by which one ran.

The target is selected by the string in `ANTIBODY_TARGET` (`builtin`, the default, or `http:<url>`), never
by passing an object around: `run_target_agent` is a `@weave.op`, and an object argument would be
serialised as an input on every call.
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from typing import Protocol, get_args

from chaos import toolserver
from chaos.schemas import Episode, PatchKind
from chaos.toolbus import ToolSession

TARGET_ENV = "ANTIBODY_TARGET"
DEFAULT_TARGET = "builtin"

ALL_PATCH_KINDS: frozenset[PatchKind] = frozenset(get_args(PatchKind))
# Patches enforced in the tool bus rather than in the prompt. An external agent never sees
# `cfg.system_prompt`, so these are the only kinds that can change what it does.
CODE_LEVEL_PATCH_KINDS: frozenset[PatchKind] = frozenset({"tighten_tool_policy", "add_tool_validator"})


class Target(Protocol):
    """An agent Antibody can run one episode against."""

    name: str
    transport: str
    supported_patch_kinds: frozenset[PatchKind]

    def run_episode(self, session: ToolSession, opening_message: str) -> Episode: ...


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
                response = _post_json(f"{self.url}/episode", body, self.timeout)
            except Exception as e:  # noqa: BLE001 - any transport failure is the episode's error, never a crash
                if _is_timeout(e):
                    return session.episode("", error="target timed out")
                return session.episode("", error=f"target request failed: {e}")
            reply = response.get("reply") if isinstance(response, dict) else None
            if not isinstance(reply, str):
                return session.episode("", error="target returned no reply: expected {\"reply\": \"...\"}")
            return session.episode(reply)
        finally:
            toolserver.drop(session_id)


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """A 30x from the agent is a failed episode, not a request to be replayed at another address."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # urllib's signature
        return None  # declining here makes urllib raise the 30x as an HTTPError instead of following it


# No proxy from the environment (the agent is a local URL the operator typed; an `HTTP_PROXY` in the
# shell must not silently route episodes through it) and no following of redirects.
_opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirect())


def _post_json(url: str, body: dict, timeout: float) -> object:
    data = json.dumps(body).encode()
    req = urllib.request.Request(url, data=data, method="POST", headers={"Content-Type": "application/json"})
    try:
        with _opener.open(req, timeout=timeout) as resp:
            return json.loads(resp.read() or b"null")
    except urllib.error.HTTPError as e:
        if 300 <= e.code < 400:
            raise RuntimeError("redirect") from e
        raise


def _is_timeout(e: Exception) -> bool:
    # urllib surfaces a socket timeout either bare or wrapped as URLError(reason=TimeoutError).
    return isinstance(e, TimeoutError) or isinstance(getattr(e, "reason", None), TimeoutError)


def target_name() -> str:
    """The configured target's canonical name (`ANTIBODY_TARGET`, normalised); `builtin` when unset or blank."""
    return resolve_target(_configured()).name


def _configured() -> str:
    return os.environ.get(TARGET_ENV, "").strip() or DEFAULT_TARGET


def resolve_target(name: str | None = None) -> Target:
    """Pick the target by name (default: `ANTIBODY_TARGET`). `builtin`, or `http:<url>` / a bare `http(s)://` URL."""
    name = (name or _configured()).strip()
    if name == DEFAULT_TARGET:
        return BuiltinTarget()
    if name.startswith(("http://", "https://")):
        return HttpTarget(name)
    if name.startswith("http:"):
        url = name.removeprefix("http:")
        return HttpTarget(url if url.startswith(("http://", "https://")) else f"http://{url}")
    raise ValueError(f"unknown target {name!r}: set {TARGET_ENV} to 'builtin' or 'http:<url>'")


def banned_patch_kinds(target: Target) -> list[PatchKind]:
    """Patch kinds Repair must not propose for this target, sorted for stable prompts and logs."""
    return sorted(ALL_PATCH_KINDS - target.supported_patch_kinds)
