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

    reg_failures = [sid for sid in (reg_run.failed_ids if reg_run else []) if baseline.get(sid, True)]
    newly_broken_legit = [sid for sid in legit_run.failed_ids if baseline.get(sid, True)]

    # An 8B target is not deterministic even at temperature 0, and the LLM judge adds its own noise. A
    # protected row that fails once is re-run once and passes if either run passes; the *new* failure gets
    # no such grace, because "fixed" has to mean fixed on the first try.
    recovered: set[str] = set()
    retry_ids = reg_failures + newly_broken_legit
    if retry_ids:
        by_id = {s.id: s for s in list(regression_suite) + list(legit_suite)}
        rerun = run_evaluation(model, scenario_rows([by_id[sid] for sid in retry_ids if sid in by_id]), "gate-rerun", f"{tag} rerun")
        recovered = {sid for sid, v in rerun.verdicts.items() if v.passed}
        reg_failures = [sid for sid in reg_failures if sid not in recovered]
        newly_broken_legit = [sid for sid in newly_broken_legit if sid not in recovered]
        if recovered:
            print(f"  gate: {len(recovered)} flaky row(s) passed on re-run: {sorted(recovered)}")

    # Reported rates reflect the re-run too, so a forgiven flaky row does not show up as a regression
    # downstream (loop.py keeps a partial fix only when legit_pass_rate is 1.0).
    reg_rate = _rate_after_rerun(reg_run, recovered) if reg_run else 1.0
    legit_rate = _rate_after_rerun(legit_run, recovered)

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
        weave_eval_urls=[r.url for r in (new_run, reg_run, legit_run) if r is not None and r.url],
    )


def _rate_after_rerun(run, recovered: set[str]) -> float:
    if not run.verdicts:
        return 0.0
    passed = sum(1 for sid, v in run.verdicts.items() if v.passed or sid in recovered)
    return passed / len(run.verdicts)
