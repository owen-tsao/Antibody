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
from chaos.config import ENTITY_PROJECT
from chaos.evals import TargetAgent, publish_dataset, run_evaluation
from chaos.gate import run_gate
from chaos.judge import judge_episode
from chaos.repair_agent import apply_patch, propose_patch
from chaos.scenarios import LEGIT_SCENARIOS, SEED_SCENARIOS
from chaos.schemas import AgentConfig, CycleRecord, GateResult, Scenario
from chaos.state import (
    CYCLES_PATH,
    load_config,
    load_regression,
    reset,
    save_config,
    save_regression,
    snapshot_golden,
)
from chaos.target_agent import V0_CONFIG, run_target_agent

MAX_REPAIR_ATTEMPTS = 3


class LoopState:
    def __init__(self, cfg: AgentConfig | None = None, regression_suite: list[Scenario] | None = None):
        self.cfg = cfg or V0_CONFIG
        self.regression_suite: list[Scenario] = list(regression_suite or [])
        self.cycle = _last_cycle_number()
        self.config_history: list[AgentConfig] = [self.cfg]
        self.baseline: dict[str, bool] = {}
        self.legit_dataset = publish_dataset("legit-users", LEGIT_SCENARIOS)
        self.regression_dataset: weave.Dataset | None = (
            publish_dataset("regression-suite", self.regression_suite) if self.regression_suite else None
        )
        save_config(self.cfg)

    def capture_regression(self, scenario: Scenario) -> None:
        """A new failure joins the permanent regression suite; re-publish it as a Weave Dataset version.

        Idempotent by scenario id: the end-of-run replay and --from-version re-runs can hit a scenario
        that is already captured, and a duplicate row would double-count it in every future gate.
        """
        if any(s.id == scenario.id for s in self.regression_suite):
            return
        self.regression_suite.append(scenario)
        # Production just failed this scenario; that is a measurement, and the gate must not treat
        # a missing entry as "protected" before the next full refresh.
        self.baseline[scenario.id] = False
        self.regression_dataset = publish_dataset("regression-suite", self.regression_suite)
        save_regression(self.regression_suite)

    def promote(self, candidate: AgentConfig) -> None:
        self.cfg = candidate
        self.config_history.append(candidate)
        save_config(candidate)

    def refresh_baseline(self, just_fixed: str | None = None) -> None:
        """Measure what production actually passes today: the bar a patch must not lower.

        Both suites are measured, not assumed. A regression scenario that some later patch happened to fix
        incidentally is protected from being un-fixed, because the gate compares against this map.
        `just_fixed` is the scenario the gate just verified; it is recorded as passing even if the
        small target model is flaky on the re-measure, because the gate's evidence is fresher.
        """
        model = TargetAgent(config=self.cfg)
        run = run_evaluation(model, self.legit_dataset, "baseline-legit", f"baseline v{self.cfg.version} legit")
        self.baseline = {sid: v.passed for sid, v in run.verdicts.items()}
        if self.regression_dataset is not None:
            reg = run_evaluation(model, self.regression_dataset, "baseline-regression", f"baseline v{self.cfg.version} regression")
            self.baseline.update({sid: v.passed for sid, v in reg.verdicts.items()})
        if just_fixed:
            self.baseline[just_fixed] = True
        ok = sum(v.passed for v in run.verdicts.values())
        protected = sum(1 for s in self.regression_suite if self.baseline.get(s.id))
        print(
            f"  baseline: config v{self.cfg.version} passes {ok}/{len(run.verdicts)} legit-user scenarios"
            + (f", holds {protected}/{len(self.regression_suite)} captured regressions" if self.regression_suite else "")
        )


def _regressed(gate: GateResult, state: LoopState) -> bool:
    """True if the gate found a scenario that production passes but the candidate fails."""
    return any(state.baseline.get(sid, False) for sid in gate.failed_scenario_ids)


def _last_cycle_number() -> int:
    if not CYCLES_PATH.exists():
        return 0
    last = 0
    for line in CYCLES_PATH.read_text().splitlines():
        if not line.strip():
            continue
        try:
            last = int(json.loads(line).get("cycle", last))
        except (json.JSONDecodeError, TypeError, ValueError):
            continue  # a torn write from an interrupted run must not prevent the next run from starting
    return last


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
            if base is not state.cfg:
                # Stacked on a kept partial fix: the note must tell the whole story, not just the last step.
                candidate.patch_note = f"{base.patch_note} + {candidate.patch_note}"
            print(f"  repair attempt {attempt}: {patch.kind} — {patch.rationale[:120]}")
            # The regression suite includes the new failure, which the gate evaluates on its own,
            # so it is given the rest of the suite as plain rows rather than the published dataset.
            gate = run_gate(
                candidate,
                scenario,
                [s for s in state.regression_suite if s.id != scenario.id],
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
                state.promote(candidate)
                state.refresh_baseline(just_fixed=scenario.id)
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

    parser = argparse.ArgumentParser(prog="chaos.loop", description="Antibody: the self-healing loop for AI agents")
    sub = parser.add_subparsers(dest="command")

    run_p = sub.add_parser("run", help="run the loop (default)")
    run_p.add_argument("--chaos-cycles", type=int, default=3, help="novel scenarios the Chaos Agent should invent after the seeds")
    run_p.add_argument("--no-seeds", action="store_true", help="skip the hand-written seed scenarios")
    run_p.add_argument(
        "--from-version", type=int, default=None,
        help="start from a saved config version (0 = fresh v0; omit = fresh v0 too, since the hardened config has nothing left to show)",
    )
    run_p.add_argument("--resume", action="store_true", help="continue from the latest saved config and regression suite")

    sub.add_parser("reset", help="wipe runs/ and cycles.jsonl")
    sub.add_parser("golden", help="snapshot the current run into data/golden/ for demo fallback")

    args = parser.parse_args()
    if args.command is None:
        args = parser.parse_args(["run"])

    if args.command == "reset":
        reset()
        return
    if args.command == "golden":
        snapshot_golden()
        return

    weave.init(ENTITY_PROJECT)
    # Evaluation progress and summary output drown out the loop narrative.
    for name in ("weave", "weave.evaluation.eval"):
        logging.getLogger(name).setLevel(logging.WARNING)

    if args.resume:
        from chaos.state import latest_version

        v = latest_version()
        if v is None:
            raise SystemExit("nothing to resume; run without --resume first")
        state = LoopState(cfg=load_config(v), regression_suite=load_regression())
        print(f"Resuming from config v{v} with {len(state.regression_suite)} regression scenarios")
    elif args.from_version not in (None, 0):
        state = LoopState(cfg=load_config(args.from_version), regression_suite=load_regression())
        print(f"Starting from saved config v{args.from_version}")
    else:
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
