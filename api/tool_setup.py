"""Bring your own tools (docs/plans/09-roadmap-v1.md §4): from a connected agent's tool list to a saved policy.

`proposal(agent)` classifies the agent's tools (chaos.tool_rules) and returns what the Tools panel shows: the
list, the sandbox mapping, each tool's class and the starter rule per tool. `apply(agent, rules)` saves those
rules as the next live config version — the same write rollback makes, under the same lock and refusals — so
the next run against this agent starts from a policy that already knows its tools, and `check` verifies it.
"""

from __future__ import annotations

from api import loop_ctl, store
from api.rollback import RollbackRefused, same_target
from chaos import state
from chaos.loop import check_config
from chaos.schemas import AgentConfig, ToolRule
from chaos.tool_rules import classes, starter_rules


def proposal(agent: dict) -> dict:
    """`{tools, mapping, classes, starter_rules}`; `tools` is None when the agent has not listed any (ping it first).

    Classes come from the one classifier (`chaos.tool_rules.tool_class`) with the agent's pack, so the class shown
    here is the class the gateway will fail open or closed on.
    """
    from api.agents import tool_mapping
    from chaos.domains import domain_name, load_domain

    tools = agent.get("tools")
    if tools is None:
        return {"tools": None, "mapping": None, "classes": {}, "starter_rules": {}}
    domain = load_domain(agent.get("domain") or domain_name())
    return {
        "tools": tools,
        "mapping": tool_mapping(tools),
        "classes": classes(tools, domain),
        "starter_rules": {name: rule.model_dump() for name, rule in starter_rules(tools, domain).items()},
    }


def apply(agent: dict, rules: dict[str, ToolRule]) -> AgentConfig:
    """Save `rules` (merged over the latest live config's) as the next live version. Raises RollbackRefused (409)
    while a loop runs or when the live run was made against another agent; ValueError (400) for no rules."""
    if not rules:
        raise ValueError("no rules to apply")
    from api.agents import BuiltinTarget, canonical
    from chaos.repair_agent import merge_tool_rules

    mine = canonical(agent["url"]) if agent.get("url") else BuiltinTarget.name
    with loop_ctl.runs_lock:
        if loop_ctl.state()["running"]:
            raise RollbackRefused("a loop is running and owns the live config; stop it first")
        manifest = store.run_manifest("live")
        if manifest and not same_target(manifest.get("target") or BuiltinTarget.name, mine):
            raise RollbackRefused(f"the live run was made against {manifest.get('target')!r}, not this agent; Clear it first")
        previous = state.latest_version()
        base = check_config(None)
        merged = {**base.tool_policy.tool_rules}
        for name, rule in rules.items():
            merged[name] = merge_tool_rules(merged.get(name), rule)
        new = base.model_copy(deep=True)
        new.version = previous + 1 if previous is not None else 0
        new.parent_version = previous
        new.patch_note = f"starter tool rules for {agent['name']}: {', '.join(sorted(rules))}"
        new.tool_policy.tool_rules = merged
        try:
            state.save_config(new, exclusive=True)
        except FileExistsError:
            raise RollbackRefused(f"version v{new.version} already exists; retry")
        # A fresh tree now holds configs and nothing else, which the runs list would read as a legacy built-in
        # run: say whose they are, so the next `--resume` run and the next apply both know.
        if manifest is None:
            state.write_run_manifest("mock", mine, [])
    return new
