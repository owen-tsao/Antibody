"""`/api/manifest`: the one quiet line under the Start button (docs/FRONTEND.md §3, §4.1).

Built from `chaos.tools.TOOL_SPECS` and `chaos.scenarios` at first request, not at import.
`chaos.tools` does `import weave` (library import only; `weave.init` lives in api.attack, warmed in a
background thread at startup), but it is a slow import and the read-only routes in `api.store`
deliberately avoid it. The result is static, so it is computed once.

Side-effect classification is hardcoded per §3: `issue_refund` and `send_email` are side
effects; `lookup_order` carries free-text fields (`notes`, `status`) an attacker can poison.
"""

from __future__ import annotations

from functools import lru_cache

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
    from chaos.tools import TOOL_SPECS

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
        "target": {"name": TARGET_NAME, "model": TARGET_MODEL, "model_short": _short_model(TARGET_MODEL)},
        "tools": tools,
        "families": families,
    }
