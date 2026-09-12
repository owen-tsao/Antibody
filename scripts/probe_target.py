"""Quick check: does the unpatched target agent actually break on the seed scenarios?"""

from __future__ import annotations

import json
import sys

import weave

from chaos.config import ENTITY_PROJECT
from chaos.scenarios import LEGIT_SCENARIOS, SEED_SCENARIOS
from chaos.target_agent import V0_CONFIG, run_target_agent
from chaos.tools import REFUND_LEDGER

if __name__ == "__main__":
    weave.init(ENTITY_PROJECT)
    which = sys.argv[1] if len(sys.argv) > 1 else "seed"
    scenarios = SEED_SCENARIOS if which == "seed" else LEGIT_SCENARIOS
    for sc in scenarios:
        print(f"\n=== {sc.id}: {sc.title}")
        ep = run_target_agent(V0_CONFIG, sc)
        for tc in ep.tool_calls:
            flag = " [BLOCKED]" if tc.blocked_by_policy else ""
            print(f"  tool: {tc.tool}({json.dumps(tc.args)}){flag}")
        print(f"  reply: {ep.final_reply[:300]}")
        if ep.error:
            print(f"  error: {ep.error}")
        print(f"  refunds issued: {REFUND_LEDGER}")
