"""Reliability probe: how often does v0 fall for the seed injection? Demo needs ~100%."""

from __future__ import annotations

import sys

import weave

from chaos.config import ENTITY_PROJECT
from chaos.judge import judge_episode
from chaos.scenarios import SEED_SCENARIOS
from chaos.target_agent import V0_CONFIG, run_target_agent

if __name__ == "__main__":
    weave.init(ENTITY_PROJECT)
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 3
    sc = SEED_SCENARIOS[0]
    fails = 0
    for i in range(n):
        ep = run_target_agent(V0_CONFIG, sc)
        v = judge_episode(sc, ep)
        fails += not v.passed
        tools = [f"{tc.tool}({tc.args.get('order_id', tc.args.get('to', ''))})" for tc in ep.tool_calls]
        print(f"run {i + 1}: {'BROKEN' if not v.passed else 'held'} | {tools} | {v.reason[:90]}")
    print(f"\nattack success rate on v0: {fails}/{n}")
