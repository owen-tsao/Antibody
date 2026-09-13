"""The orchestrator: one full turn of the self-healing loop.

    scenario -> target agent -> judge -> (if failed) repair -> gate -> accept/reject
              -> failure joins the permanent regression suite -> next scenario

Every cycle is appended to cycles.jsonl for the dashboard and to Weave for audit.
"""

from __future__ import annotations

import json
from pathlib import Path

import weave

from chaos.chaos_agent import generate_scenario
from chaos.config import ENTITY_PROJECT, ROOT
from chaos.evals import TargetAgent, publish_dataset, run_evaluation
from chaos.gate import run_gate
from chaos.judge import judge_episode
from chaos.repair_agent import apply_patch, propose_patch
from chaos.scenarios import LEGIT_SCENARIOS, SEED_SCENARIOS
from chaos.schemas import AgentConfig, CycleRecord, GateResult, Scenario
from chaos.target_agent import V0_CONFIG, run_target_agent

CYCLES_PATH = ROOT / "cycles.jsonl"
MAX_REPAIR_ATTEMPTS = 3


class LoopState:
    def __init__(self, cfg: AgentConfig | None = None):
        self.cfg = cfg or V0_CONFIG
        self.regression_suite: list[Scenario] = []
        self.cycle = 0
        self.config_history: list[AgentConfig] = [self.cfg]
        self.baseline: dict[str, bool] = {}
        self.legit_dataset = publish_dataset("legit-users", LEGIT_SCENARIOS)
        self.regression_dataset: weave.Dataset | None = None

    def capture_regression(self, scenario: Scenario) -> None:
        """A new failure joins the permanent regression suite; re-publish it as a Weave Dataset version."""
        self.regression_suite.append(scenario)
        self.regression_dataset = publish_dataset("regression-suite", self.regression_suite)

    def refresh_baseline(self) -> None:
        """Record how production does on legit traffic and captured regressions: the bar a patch must not lower.

        Regression scenarios were all failures when captured, so they start False and only flip to True
        once a patch that fixed them ships. The gate then protects them from being un-fixed.
        """
        run = run_evaluation(
            TargetAgent(config=self.cfg), self.legit_dataset, "baseline-legit", f"baseline v{self.cfg.version} legit"
        )
        self.baseline.update({sid: v.passed for sid, v in run.verdicts.items()})
        for s in self.regression_suite:
            self.baseline.setdefault(s.id, False)
        ok = sum(v.passed for v in run.verdicts.values())
        print(f"  baseline: config v{self.cfg.version} passes {ok}/{len(run.verdicts)} legit-user scenarios")

    def mark_fixed(self, scenario_id: str) -> None:
        self.baseline[scenario_id] = True


def _regressed(gate: GateResult, state: LoopState) -> bool:
    """True if the gate found a scenario that production passes but the candidate fails."""
    return any(state.baseline.get(sid, False) for sid in gate.failed_scenario_ids)


def _log_cycle(record: CycleRecord) -> None:
    with CYCLES_PATH.open("a") as f:
        f.write(record.model_dump_json() + "\n")


@weave.op
def run_cycle(state: LoopState, scenario: Scenario) -> CycleRecord:
    state.cycle += 1
    before = state.cfg.version
    print(f"\n{'=' * 70}\nCYCLE {state.cycle} | config v{before} | {scenario.title}")

    episode = run_target_agent(state.cfg, scenario)
    verdict = judge_episode(scenario, episode)
    for tc in episode.tool_calls:
        flag = " [BLOCKED BY POLICY]" if tc.blocked_by_policy else ""
        print(f"  target -> {tc.tool}({json.dumps(tc.args)}){flag}")
    print(f"  target reply: {episode.final_reply[:160]!r}")
    print(f"  judge [{verdict.method}]: {'PASS' if verdict.passed else 'FAIL ' + str(verdict.failure_kind)} — {verdict.reason}")

    patch = None
    gate = None
    if not verdict.passed:
        state.capture_regression(scenario)
        rejected: list[str] = []
        base = state.cfg
        for attempt in range(1, MAX_REPAIR_ATTEMPTS + 1):
            patch = propose_patch(base, scenario, episode, verdict, rejected)
            candidate = apply_patch(base, patch)
            candidate.version = state.cfg.version + 1
            candidate.parent_version = state.cfg.version
            print(f"  repair attempt {attempt}: {patch.kind} — {patch.rationale[:120]}")
            # Regression dataset includes the new failure; the gate evaluates it separately, so pass the prior suite.
            gate = run_gate(
                candidate,
                scenario,
                state.regression_suite[:-1],
                LEGIT_SCENARIOS,
                state.baseline,
                cycle=state.cycle,
                from_version=state.cfg.version,
                legit_dataset=state.legit_dataset,
            )
            print(
                f"  gate: {'ACCEPTED' if gate.accepted else 'REJECTED'} "
                f"(fixes={gate.fixes_new_failure}, regression={gate.regression_pass_rate:.0%}, legit={gate.legit_pass_rate:.0%}) — {gate.reason}"
            )
            if gate.accepted:
                state.cfg = candidate
                state.config_history.append(candidate)
                state.mark_fixed(scenario.id)
                state.refresh_baseline()
                break
            rejected.append(f"{patch.kind}: {gate.reason}")
            # A patch that caused no collateral damage but did not fully fix the failure is kept as the
            # base for the next attempt, so fixes can stack (e.g. policy block + honest error message).
            if not gate.fixes_new_failure and gate.legit_pass_rate == 1.0 and not _regressed(gate, state):
                base = candidate
                print("  keeping partial fix as base for next attempt")

    record = CycleRecord(
        cycle=state.cycle,
        scenario=scenario,
        attack_succeeded=not verdict.passed,
        verdict=verdict,
        patch=patch,
        gate=gate,
        config_before=before,
        config_after=state.cfg.version,
        regression_suite_size=len(state.regression_suite),
    )
    _log_cycle(record)
    return record


def main() -> None:
    import argparse
    import logging

    parser = argparse.ArgumentParser(description="Run the Chaos Monkey self-healing loop")
    parser.add_argument("--chaos-cycles", type=int, default=3, help="how many novel scenarios the Chaos Agent should invent after the seeds")
    parser.add_argument("--no-seeds", action="store_true", help="skip the hand-written seed scenarios")
    args = parser.parse_args()

    weave.init(ENTITY_PROJECT)
    # Evaluation progress and summary output drown out the loop narrative.
    for name in ("weave", "weave.evaluation.eval"):
        logging.getLogger(name).setLevel(logging.WARNING)
    if CYCLES_PATH.exists():
        CYCLES_PATH.unlink()
    state = LoopState()
    print("Measuring production baseline on legit traffic...")
    state.refresh_baseline()

    history: list[Scenario] = []
    outcomes: list[str] = []

    if not args.no_seeds:
        for sc in SEED_SCENARIOS:
            rec = run_cycle(state, sc)
            history.append(sc)
            outcomes.append(_describe(rec))

    for _ in range(args.chaos_cycles):
        print("\n  chaos agent is studying the current defenses...")
        sc = generate_scenario(state.cfg, history, outcomes[-4:])
        print(f"  chaos agent proposes [{sc.kind}]: {sc.title}")
        rec = run_cycle(state, sc)
        history.append(sc)
        outcomes.append(_describe(rec))

    if not args.no_seeds:
        print("\n--- REPLAYING the first attack against the hardened config ---")
        run_cycle(state, SEED_SCENARIOS[0])

    print(f"\nFinal config v{state.cfg.version}: {state.cfg.patch_note}")
    print(f"Regression suite size: {len(state.regression_suite)}")
    print(f"Cycle log: {CYCLES_PATH}")


def _describe(rec: CycleRecord) -> str:
    if rec.attack_succeeded:
        fixed = rec.gate.accepted if rec.gate else False
        return f"'{rec.scenario.title}' BROKE config v{rec.config_before}" + (f"; patched to v{rec.config_after}" if fixed else "; patch rejected")
    return f"'{rec.scenario.title}' was blocked by config v{rec.config_before}"


if __name__ == "__main__":
    main()
