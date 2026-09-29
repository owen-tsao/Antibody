"""`/api/manifest`: the one quiet line under the Start button (docs/FRONTEND.md §3, §4.1), the
run-settings defaults the settings drawer starts from (docs/plans/02, A1), and the model behind each role
(`models`, from `chaos.config`, for the Settings page).

Built from the active domain pack (`chaos.domains.active_domain`, `ANTIBODY_DOMAIN`) at first request, not at
import. The packs do `import weave` (library import only; `weave.init` lives in api.attack, warmed in a
background thread at startup), but it is a slow import and the read-only routes in `api.store`
deliberately avoid it. The result is static, so it is computed once.

`target` describes the agent the loop attacks *by default*, resolved from `ANTIBODY_TARGET` the same way the
loop does it (`chaos.target.resolve_target`) and read once. A run started from the dashboard may name a
different agent (`LoopStartBody.target`, plan 00 Block 1); the runs list says which one each run used, so
this line is only the default, never the record. For the built-in agent it is its display name and model;
for an external agent it is the canonical target name (`http:<url>`), the `url`, and no model, because
Antibody does not know what runs behind the URL.

Side-effect classification comes from the pack's tool classes (§3): every non-read tool is a side effect; a
read tool's free-text fields are the surface an attacker can poison (retail: `lookup_order.notes/status`).
"""

from __future__ import annotations

from functools import lru_cache
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from chaos.target import Target

from api.loop_ctl import LoopStartBody

TARGET_NAMES = {"retail": "Northwind support agent", "airline": "Skyward Air support agent"}

FREE_TEXT_FIELDS = {"lookup_order": ["notes", "status"], "lookup_reservation": ["notes", "status"], "get_flight_status": ["notes", "status"]}


def _short_model(model_id: str) -> str:
    """'meta-llama/Llama-3.1-8B-Instruct' -> 'Llama 3.1 8B'."""
    name = model_id.rsplit("/", 1)[-1].removesuffix("-Instruct")
    return name.replace("-", " ")


@lru_cache(maxsize=1)
def build() -> dict:
    from chaos import config
    from chaos.domains import active_domain
    from chaos.target import resolve_target

    target = resolve_target()
    domain = active_domain()
    tools = [
        {
            "name": spec.name,
            "description": spec.description,
            "class": spec.cls,
            "side_effect": spec.cls != "read",
            "free_text_fields": FREE_TEXT_FIELDS.get(spec.name, []),
        }
        for spec in domain.tools.values()
        if not spec.ticket_only
    ]

    seed_by_kind = {s.kind: s.id for s in domain.seeds}
    families = [
        {
            "kind": f.name,
            "title": f.name.replace("_", " "),
            "seed_id": seed_by_kind.get(f.name),
        }
        for f in domain.families
    ]

    return {
        "target": _target(target, config.TARGET_MODEL, domain.name),
        "domain": domain.name,
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


def _target(target: Target, model: str, domain: str) -> dict:
    """`{name, model, model_short, transport}` for the built-in agent; `{name, url, transport}` with null model fields for an external one."""
    if target.transport == "in-process":
        return {"name": TARGET_NAMES.get(domain, f"{domain} support agent"), "model": model, "model_short": _short_model(model), "transport": target.transport}
    return {"name": target.name, "model": None, "model_short": None, "transport": target.transport, "url": getattr(target, "url", None)}


@lru_cache(maxsize=1)
def domains() -> list[dict]:
    """`GET /api/domains`: each pack by name with its tools by class, its attack families, and how many legit tasks it has."""
    from chaos.domains import list_domains, load_domain

    out = []
    for name in list_domains():
        d = load_domain(name)
        out.append(
            {
                "name": d.name,
                "tools": [{"name": t.name, "class": t.cls} for t in d.tools.values() if not t.ticket_only],
                "families": [f.name for f in d.families],
                "legit": len(d.legit),
            }
        )
    return out
