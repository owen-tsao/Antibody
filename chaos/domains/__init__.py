"""Domain packs: the world an episode runs in, loaded from `chaos/domains/<name>/`.

A pack is a directory of data plus one module of code:

  tools.py     `TOOLS` ({name: fn(db, **args)}), `SPECS` (list[ToolSpec]), optional `VALIDATORS`,
               `policy_blocks` (the pack's own flag checks) and `state_view` (what `end_state` compares)
  db.json      the seed records; every session gets `Domain.fresh_db()`
  policy.md    the policy text the built-in target's v0 prompt is (trailing newline dropped)
  tasks.json   legit rows: {id, customer_id, title, message, expected_behavior, expected_calls, forbidden_calls?}
  attacks.json {families: [{name, expected_behavior, faults, forbidden_calls_by_class, default}], seeds: [...]}

`load_domain(name)` builds the `Domain` (chaos.schemas) once per process; `active_domain()` is the one the
loop runs, chosen by `ANTIBODY_DOMAIN` (default `retail`). The loader also derives what the judge needs and
the files should not repeat: a family's forbidden classes become each scenario's `forbidden_calls`, and a
legit task whose expected calls are all exact gets an `expected_state` by replaying them on a fresh db.
"""

from __future__ import annotations

import importlib
import json
import os
from functools import lru_cache
from pathlib import Path

from chaos.schemas import AttackFamily, CallSpec, Domain, Scenario, ToolFault, ToolSpec

DOMAIN_ENV = "ANTIBODY_DOMAIN"
DEFAULT_DOMAIN = "retail"
PACKS_DIR = Path(__file__).resolve().parent


def list_domains() -> list[str]:
    """Every pack directory with a tools module, sorted."""
    return sorted(p.name for p in PACKS_DIR.iterdir() if p.is_dir() and (p / "tools.py").exists())


def domain_name() -> str:
    """The pack the loop runs (`ANTIBODY_DOMAIN`, default `retail`); `list_domains()` says what is valid."""
    return os.environ.get(DOMAIN_ENV, "").strip() or DEFAULT_DOMAIN


def active_domain() -> Domain:
    return load_domain(domain_name())


@lru_cache(maxsize=None)
def load_domain(name: str) -> Domain:
    """The pack by name. ValueError for a name that is not a pack; the files' own errors for a broken one."""
    if name not in list_domains():
        raise ValueError(f"unknown domain {name!r}: set {DOMAIN_ENV} to one of {list_domains()}")
    root = PACKS_DIR / name
    code = importlib.import_module(f"chaos.domains.{name}.tools")
    specs: list[ToolSpec] = list(code.SPECS)
    attacks = json.loads((root / "attacks.json").read_text())
    families = [AttackFamily(**f) for f in attacks.get("families", [])]
    domain = Domain(
        name=name,
        tools={s.name: s for s in specs},
        db=json.loads((root / "db.json").read_text()),
        policy_text=(root / "policy.md").read_text().rstrip("\n"),
        families=families,
        policy_help=getattr(code, "POLICY_HELP", ""),
        validators_help=getattr(code, "VALIDATORS_HELP", ""),
    ).attach(
        funcs=code.TOOLS,
        validators=getattr(code, "VALIDATORS", None),
        policy_hook=getattr(code, "policy_blocks", None),
        state_view=getattr(code, "state_view", None),
    )
    domain.legit = [_legit_scenario(domain, row) for row in json.loads((root / "tasks.json").read_text())]
    domain.seeds = [_seed_scenario(domain, row) for row in attacks.get("seeds", [])]
    _check(domain)
    return domain


def forbidden_calls_for(domain: Domain, kind: str) -> list[CallSpec]:
    """The family's forbidden classes as this pack's tools: `{tool}` with no args (any call of it)."""
    return [CallSpec(tool=name) for cls in domain.family(kind).forbidden_calls_by_class for name in domain.tools_of_class(cls)]


def expected_state_for(domain: Domain, expected_calls: list[CallSpec]) -> str | None:
    """Replay exact expected calls on a fresh db; None when a call leaves an argument open or nothing would change.

    A row whose expected calls are all reads has the seed db as its end state, and comparing that would fail
    every episode where the agent also did something the row does not name — that is the calls check's job.
    """
    if not expected_calls or not all(c.exact() for c in expected_calls):
        return None
    if all(domain.tool_class(c.tool) == "read" for c in expected_calls):
        return None
    db = domain.fresh_db()
    for call in expected_calls:
        try:
            domain.call(db, call.tool, dict(call.args))
        except Exception:  # noqa: BLE001 - a spec that cannot be replayed is judged on calls alone
            return None
    return domain.end_state(db)


def covered_legit(domain: Domain, tasks: list[Scenario], target_tools: list[str] | None) -> list[Scenario]:
    """The legit tasks a target can perform: every expected call names a tool it has, by the pack's name or an alias.

    `target_tools` is what the agent listed on `GET /tools`; None (no list) means every task is judged, as before.
    A task the target cannot perform (the demo has no email tool) is skipped rather than failed, so the legit guard
    measures the agent's behaviour, not the pack's vocabulary.
    """
    if target_tools is None:
        return list(tasks)
    have = set(target_tools)
    return [t for t in tasks if all(have & set(domain.names_of(c.tool)) for c in t.expected_calls)]


def _legit_scenario(domain: Domain, row: dict) -> Scenario:
    # The key must be there even when empty: a refusal-only row says so on purpose, a forgotten one would pass
    # whatever the agent does (the check `tests/test_scenarios.py` used to make against a dict).
    if "expected_calls" not in row:
        raise ValueError(f"domain {domain.name}: task {row.get('id')} has no expected_calls (use [] for a refusal-only row)")
    expected = [CallSpec(**c) for c in row["expected_calls"]]
    return Scenario(
        id=row["id"],
        kind="ambiguous_request",
        title=row["title"],
        user_message=row["message"],
        customer_id=row["customer_id"],
        expected_behavior=row["expected_behavior"],
        expected_calls=expected,
        forbidden_calls=[CallSpec(**c) for c in row.get("forbidden_calls", [])],
        expected_state=expected_state_for(domain, expected),
        origin="legit",
    )


def _seed_scenario(domain: Domain, row: dict) -> Scenario:
    family = domain.family(row["kind"])
    own = [CallSpec(**c) for c in row.get("forbidden_calls", [])]
    return Scenario(
        id=row["id"],
        kind=row["kind"],
        title=row["title"],
        user_message=row["user_message"],
        customer_id=row["customer_id"],
        faults=[ToolFault(**f) for f in row.get("faults", [])],
        expected_behavior=family.expected_behavior,
        forbidden_calls=own + forbidden_calls_for(domain, row["kind"]),
        attacker_goal=row.get("attacker_goal", ""),
        origin="seed",
    )


def _check(domain: Domain) -> None:
    """The pack's own consistency: every task's expected calls name its tools, ids are unique, families cover every seed, aliases collide with nothing."""
    ids = [s.id for s in domain.legit + domain.seeds]
    if len(ids) != len(set(ids)):
        raise ValueError(f"domain {domain.name}: duplicate scenario ids")
    seen: dict[str, str] = {}
    for spec in domain.tools.values():
        for alias in spec.aliases:
            if alias in domain.tools or alias in seen:
                raise ValueError(f"domain {domain.name}: alias {alias!r} of {spec.name} is already a tool or an alias of {seen.get(alias, alias)}")
            seen[alias] = spec.name
    for s in domain.legit:
        for c in s.expected_calls + s.forbidden_calls:
            if c.tool not in domain.tools:
                raise ValueError(f"domain {domain.name}: task {s.id} names a tool the pack does not have: {c.tool}")
        if s.customer_id not in (domain.db.get("customers") or {}):
            raise ValueError(f"domain {domain.name}: task {s.id} names a customer not in db.json: {s.customer_id}")
    for s in domain.seeds:
        for f in s.faults:
            if f.tool not in domain.tools:
                raise ValueError(f"domain {domain.name}: seed {s.id} faults a tool the pack does not have: {f.tool}")
