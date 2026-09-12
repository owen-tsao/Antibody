"""The Eval Gate: the only way a patch gets into production.

A candidate config is accepted only if it
  (a) fixes the scenario that just broke,
  (b) still passes every previously-captured regression scenario, and
  (c) does not make any legit-user scenario worse than the current production config
      (so the repair agent cannot "win" by refusing everything).

"Regression" means worse than what is deployed today, not worse than perfect: the
gate must not reject a good patch because of a pre-existing flaw it did not cause.

Every check runs through Weave so the gate decision is auditable.
"""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor

import weave

from chaos.judge import judge_episode
from chaos.schemas import AgentConfig, GateResult, Scenario, Verdict
from chaos.target_agent import run_target_agent


@weave.op
def evaluate_config_on(cfg: AgentConfig, scenario: Scenario) -> Verdict:
    episode = run_target_agent(cfg, scenario)
    return judge_episode(scenario, episode)


def run_suite(cfg: AgentConfig, scenarios: list[Scenario]) -> list[Verdict]:
    if not scenarios:
        return []
    with ThreadPoolExecutor(max_workers=min(6, len(scenarios))) as pool:
        return list(pool.map(lambda s: evaluate_config_on(cfg, s), scenarios))


@weave.op
def run_gate(
    candidate: AgentConfig,
    new_failure: Scenario,
    regression_suite: list[Scenario],
    legit_suite: list[Scenario],
    baseline_legit: dict[str, bool],
) -> GateResult:
    """baseline_legit maps legit scenario id -> whether the CURRENT production config passes it."""
    new_verdict = evaluate_config_on(candidate, new_failure)
    fixes = new_verdict.passed

    reg_verdicts = run_suite(candidate, regression_suite)
    legit_verdicts = run_suite(candidate, legit_suite)

    reg_rate = (sum(v.passed for v in reg_verdicts) / len(reg_verdicts)) if reg_verdicts else 1.0
    legit_rate = (sum(v.passed for v in legit_verdicts) / len(legit_verdicts)) if legit_verdicts else 1.0

    newly_broken_legit = [v for v in legit_verdicts if not v.passed and baseline_legit.get(v.scenario_id, True)]
    reg_failures = [v for v in reg_verdicts if not v.passed]

    failed = [v.scenario_id for v in reg_failures + newly_broken_legit]
    if not fixes:
        failed.insert(0, new_failure.id)

    accepted = fixes and not reg_failures and not newly_broken_legit
    if accepted:
        reason = "fixes the new failure, no regressions, legit users unaffected"
    elif not fixes:
        reason = f"does not fix the new failure: {new_verdict.reason}"
    elif newly_broken_legit:
        b = newly_broken_legit[0]
        reason = f"breaks a legit user flow that worked before ({b.scenario_id}: {b.reason})"
    else:
        b = reg_failures[0]
        reason = f"reintroduces old failure ({b.scenario_id}: {b.reason})"

    return GateResult(
        accepted=accepted,
        fixes_new_failure=fixes,
        regression_pass_rate=reg_rate,
        legit_pass_rate=legit_rate,
        failed_scenario_ids=failed,
        reason=reason,
    )
