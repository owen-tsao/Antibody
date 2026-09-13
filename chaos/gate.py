"""The Eval Gate: the only way a patch gets into production.

A candidate config is accepted only if it
  (a) fixes the scenario that just broke,
  (b) still passes every previously-captured regression scenario that production passes, and
  (c) does not make any legit-user scenario worse than the current production config
      (so the repair agent cannot "win" by refusing everything).

"Regression" means worse than what is deployed today, not worse than perfect: the
gate must not reject a good patch because of a pre-existing flaw it did not cause.

Each gate run is three Weave Evaluations (gate-new, gate-regression, gate-legit) against
the candidate as a versioned weave.Model, so every decision is inspectable in the Evals tab.
"""

from __future__ import annotations

import weave

from chaos.evals import TargetAgent, run_evaluation, scenario_rows
from chaos.schemas import AgentConfig, GateResult, Scenario


@weave.op
def run_gate(
    candidate: AgentConfig,
    new_failure: Scenario,
    regression_suite: list[Scenario],
    legit_suite: list[Scenario],
    baseline: dict[str, bool],
    *,
    cycle: int,
    from_version: int,
    regression_dataset: weave.Dataset | None = None,
    legit_dataset: weave.Dataset | None = None,
) -> GateResult:
    """baseline maps scenario id -> whether the CURRENT production config passes it."""
    model = TargetAgent(config=candidate)
    tag = f"cycle-{cycle:02d} v{from_version}->v{candidate.version}"

    new_run = run_evaluation(model, scenario_rows([new_failure]), "gate-new", f"{tag} new")
    fixes = new_run.pass_rate == 1.0

    reg_run = run_evaluation(
        model, regression_dataset or scenario_rows(regression_suite), "gate-regression", f"{tag} regression"
    ) if regression_suite else None
    legit_run = run_evaluation(model, legit_dataset or scenario_rows(legit_suite), "gate-legit", f"{tag} legit")

    reg_rate = reg_run.pass_rate if reg_run else 1.0
    legit_rate = legit_run.pass_rate

    reg_failures = [sid for sid in (reg_run.failed_ids if reg_run else []) if baseline.get(sid, True)]
    newly_broken_legit = [sid for sid in legit_run.failed_ids if baseline.get(sid, True)]

    failed = list(reg_failures) + list(newly_broken_legit)
    if not fixes:
        failed.insert(0, new_failure.id)

    accepted = fixes and not reg_failures and not newly_broken_legit
    if accepted:
        reason = "fixes the new failure, no regressions, legit users unaffected"
    elif not fixes:
        v = new_run.verdicts.get(new_failure.id)
        reason = f"does not fix the new failure: {v.reason if v else 'unknown'}"
    elif newly_broken_legit:
        v = legit_run.verdicts[newly_broken_legit[0]]
        reason = f"breaks a legit user flow that worked before ({v.scenario_id}: {v.reason})"
    else:
        v = reg_run.verdicts[reg_failures[0]]  # type: ignore[union-attr]
        reason = f"reintroduces old failure ({v.scenario_id}: {v.reason})"

    if not accepted:
        for run, kind in ((new_run, "new"), (reg_run, "regression"), (legit_run, "legit")):
            if run is not None:
                run.rename(f"{tag} {kind} REJECTED")

    return GateResult(
        accepted=accepted,
        fixes_new_failure=fixes,
        regression_pass_rate=reg_rate,
        legit_pass_rate=legit_rate,
        failed_scenario_ids=failed,
        reason=reason,
    )
