"""`/api/manifest`: the one quiet line under the Start button (docs/FRONTEND.md §3, §4.1).

Built from `chaos.tools.TOOL_SPECS` and `chaos.scenarios` at first request, not at import.
`chaos.tools` does `import weave` (library import only; `weave.init` lives in api.attack, warmed in a
background thread at startup), but it is a slow import and the read-only routes in `api.store`
deliberately avoid it. The result is static, so it is computed once.

`target` describes the agent the loop attacks, resolved from `ANTIBODY_TARGET` the same way the loop
does it (`chaos.target.resolve_target`). The API and the loop must therefore run with the same value of
that variable: the manifest reports what *this process* would attack, and it is read once. For the
built-in agent that is its display name and model; for an external agent it is the canonical target
name (`http:<url>`), the `url`, and no model, because Antibody does not know what runs behind the URL.

Side-effect classification is hardcoded per §3: `issue_refund` and `send_email` are side
effects; `lookup_order` carries free-text fields (`notes`, `status`) an attacker can poison.
"""

from __future__ import annotations

from functools import lru_cache
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from chaos.target import Target

TARGET_NAME = "Northwind support agent"

SIDE_EFFECT_TOOLS = {"issue_refund", "send_email"}
FREE_TEXT_FIELDS = {"lookup_order": ["notes", "status"]}


def _short_model(model_id: str) -> str:
    """'meta-llama/Llama-3.1-8B-Instruct' -> 'Llama 3.1 8B'."""
    name = model_id.rsplit("/", 1)[-1].removesuffix("-Instruct")
    return name.replace("-", " ")


@lru_cache(maxsize=1)
def build() -> dict:
    from chaos.config import TARGET_MODEL
    from chaos.scenarios import ATTACK_FAMILIES, SEED_SCENARIOS
    from chaos.target import resolve_target
    from chaos.tools import TOOL_SPECS

    target = resolve_target()
    tools = []
    for spec in TOOL_SPECS:
        fn = spec["function"]
        tools.append(
            {
                "name": fn["name"],
                "description": fn["description"],
                "side_effect": fn["name"] in SIDE_EFFECT_TOOLS,
                "free_text_fields": FREE_TEXT_FIELDS.get(fn["name"], []),
            }
        )

    seed_by_kind = {s.kind: s.id for s in SEED_SCENARIOS}
    families = [
        {
            "kind": kind,
            "title": kind.replace("_", " "),
            "seed_id": seed_by_kind.get(kind),
        }
        for kind in ATTACK_FAMILIES
    ]

    return {
        "target": _target(target, TARGET_MODEL),
        "tools": tools,
        "families": families,
    }


def _target(target: Target, model: str) -> dict:
    """`{name, model, model_short, transport}` for the built-in agent; `{name, url, transport}` with null model fields for an external one."""
    if target.transport == "in-process":
        return {"name": TARGET_NAME, "model": model, "model_short": _short_model(model), "transport": target.transport}
    return {"name": target.name, "model": None, "model_short": None, "transport": target.transport, "url": getattr(target, "url", None)}
