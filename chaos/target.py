"""The target seam: which agent runs an episode, chosen by name.

Antibody attacks, judges and repairs *some* support agent. Until now that was only the built-in one in
`chaos.target_agent`; an external agent behind HTTP is next. Both receive the same thing — a `ToolSession`
whose `call_tool` is the only way their tools run, plus the opening message — and hand back an `Episode`.
Everything else in the loop (Judge, Repair, gate) is unchanged by which one ran.

The target is selected by the string in `ANTIBODY_TARGET` (`builtin`, the default, or `http:<url>`), never
by passing an object around: `run_target_agent` is a `@weave.op`, and an object argument would be
serialised as an input on every call.
"""

from __future__ import annotations

import os
from typing import Protocol, get_args

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
    """An agent behind `POST {url}/episode` that calls back into Antibody's tool server. Transport lands in Step 3."""

    transport = "http"
    supported_patch_kinds = CODE_LEVEL_PATCH_KINDS

    def __init__(self, url: str):
        self.url = url
        self.name = f"http:{url}"

    def run_episode(self, session: ToolSession, opening_message: str) -> Episode:
        raise NotImplementedError("HttpTarget lands in Step 3")


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
