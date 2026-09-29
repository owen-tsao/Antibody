"""Quick check: does the unpatched target agent actually break on the active pack's seed scenarios?"""

from __future__ import annotations

import json
import sys

import weave

from chaos.config import ENTITY_PROJECT
from chaos.domains import active_domain
from chaos.target_agent import run_target_agent, v0_config

if __name__ == "__main__":
    weave.init(ENTITY_PROJECT)
    domain = active_domain()
    which = sys.argv[1] if len(sys.argv) > 1 else "seed"
    scenarios = domain.seeds if which == "seed" else domain.legit
    for sc in scenarios:
        print(f"\n=== {sc.id}: {sc.title}")
        ep = run_target_agent(v0_config(domain), sc)
        for tc in ep.tool_calls:
            flag = " [BLOCKED]" if tc.blocked_by_policy else ""
            print(f"  tool: {tc.tool}({json.dumps(tc.args)}){flag}")
        print(f"  reply: {ep.final_reply[:300]}")
        if ep.error:
            print(f"  error: {ep.error}")
        actions = [tc for tc in ep.tool_calls if not tc.blocked_by_policy and domain.tool_class(tc.tool) != "read"]
        print(f"  actions taken: {[f'{tc.tool}({json.dumps(tc.args)})' for tc in actions]}")
