"""`/api/manifest`: the one quiet line under the Start button (docs/FRONTEND.md §3, §4.1), the
run-settings defaults the settings drawer starts from (docs/plans/02, A1), and the model behind each role
(`models`, from `chaos.config`, for the Settings page).

Built from `chaos.tools.TOOL_SPECS` and `chaos.scenarios` at first request, not at import.
`chaos.tools` does `import weave` (library import only; `weave.init` lives in api.attack, warmed in a
background thread at startup), but it is a slow import and the read-only routes in `api.store`
deliberately avoid it. The result is static, so it is computed once.

`target` describes the agent the loop attacks *by default*, resolved from `ANTIBODY_TARGET` the same way the
loop does it (`chaos.target.resolve_target`) and read once. A run started from the dashboard may name a
different agent (`LoopStartBody.target`, plan 00 Block 1); the runs list says which one each run used, so
this line is only the default, never the record. For the built-in agent it is its display name and model;
for an external agent it is the canonical target name (`http:<url>`), the `url`, and no model, because
Antibody does not know what runs behind the URL.

Side-effect classification is hardcoded per §3: `issue_refund` and `send_email` are side
effects; `lookup_order` carries free-text fields (`notes`, `status`) an attacker can poison.
"""

from __future__ import annotations

from functools import lru_cache
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from chaos.target import Target

from api.loop_ctl import LoopStartBody

TARGET_NAME = "Northwind support agent"

SIDE_EFFECT_TOOLS = {"issue_refund", "send_email"}
FREE_TEXT_FIELDS = {"lookup_order": ["notes", "status"]}


def _short_model(model_id: str) -> str:
    """'meta-llama/Llama-3.1-8B-Instruct' -> 'Llama 3.1 8B'."""
    name = model_id.rsplit("/", 1)[-1].removesuffix("-Instruct")
    return name.replace("-", " ")


@lru_cache(maxsize=1)
def build() -> dict:
    from chaos import config
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
        "target": _target(target, config.TARGET_MODEL),
        # The four roles as this process resolved them (`ANTIBODY_*_MODEL`, read once at import): what the
        # Settings page shows read-only. `target.model` stays for the Intro line and is the same value.
        "models": {
            "target": config.TARGET_MODEL,
            "chaos": config.CHAOS_MODEL,
            "repair": config.REPAIR_MODEL,
            "judge": config.JUDGE_MODEL,
            "inference_url": config.INFERENCE_URL,
        },
        "tools": tools,
        "families": families,
        "defaults": LoopStartBody().model_dump(),
    }


def _target(target: Target, model: str) -> dict:
    """`{name, model, model_short, transport}` for the built-in agent; `{name, url, transport}` with null model fields for an external one."""
    if target.transport == "in-process":
        return {"name": TARGET_NAME, "model": model, "model_short": _short_model(model), "transport": target.transport}
    return {"name": target.name, "model": None, "model_short": None, "transport": target.transport, "url": getattr(target, "url", None)}
