"""The two-of-two gate: a fix must hold on every sample, protected rows are forgiven one flake.

Run with `env -u WANDB_API_KEY uv run pytest -q`. `run_evaluation` is replaced by a scripted stand-in that
answers each evaluation from a queue, so the gate's decisions can be checked without inference or Weave.
"""

from __future__ import annotations

import pytest

from chaos import gate
from chaos.schemas import AgentConfig, CycleRecord, GateResult, Scenario, Verdict
from chaos.state import GOLDEN_DIR

CANDIDATE = AgentConfig(version=1, system_prompt="p", parent_version=0)
NEW = Scenario(id="new-1", kind="social_engineering", title="new", user_message="m", expected_behavior="x")
REG = [Scenario(id="reg-1", kind="social_engineering", title="reg", user_message="m", expected_behavior="x", origin="seed")]
LEGIT = [Scenario(id="legit-1", kind="ambiguous_request", title="legit", user_message="m", expected_behavior="x", origin="legit")]
BASELINE = {"reg-1": True, "legit-1": True}


class FakeRun:
    def __init__(self, verdicts: dict[str, Verdict]):
        self.verdicts = verdicts
        self.url = f"https://weave/{id(self)}"
        self.renamed: str | None = None

    @property
    def pass_rate(self) -> float:
        return sum(v.passed for v in self.verdicts.values()) / len(self.verdicts) if self.verdicts else 0.0

    @property
    def failed_ids(self) -> list[str]:
        return [sid for sid, v in self.verdicts.items() if not v.passed]

    def rename(self, name: str) -> None:
        self.renamed = name


def verdict(sid: str, passed: bool, reason: str = "") -> Verdict:
    return Verdict(scenario_id=sid, config_version=1, passed=passed, reason=reason or ("ok" if passed else f"{sid} failed"), method="deterministic")


@pytest.fixture
def script(monkeypatch: pytest.MonkeyPatch):
    """`script[evaluation_name]` is a queue of `{scenario_id: passed | (passed, reason)}` answers, consumed in order.

    Every call is logged in `script.calls` as `(evaluation_name, display_name, [scenario ids])`.
    """
    class Script(dict):
        calls: list[tuple[str, str, list[str]]]
        runs: list[FakeRun]

    s = Script()
    s.calls = []
    s.runs = []

    def fake_run_evaluation(model, rows, name, display):
        ids = [r["scenario_id"] for r in rows]
        s.calls.append((name, display, ids))
        answers = s[name].pop(0)
        verdicts = {}
        for sid in ids:
            a = answers[sid]
            passed, reason = a if isinstance(a, tuple) else (a, "")
            verdicts[sid] = verdict(sid, passed, reason)
        run = FakeRun(verdicts)
        s.runs.append(run)
        return run

    monkeypatch.setattr(gate, "run_evaluation", fake_run_evaluation)
    return s


def run(**kw) -> GateResult:
    return gate.run_gate(CANDIDATE, NEW, REG, LEGIT, BASELINE, cycle=1, from_version=0, **kw)


def test_two_passing_samples_accept_and_record_two_of_two(script) -> None:
    script["gate-new"] = [{"new-1": True}, {"new-1": True}]
    script["gate-regression"] = [{"reg-1": True}]
    script["gate-legit"] = [{"legit-1": True}]
    g = run(fix_samples=2)
    assert g.accepted and g.fixes_new_failure
    assert (g.fix_samples, g.fix_passes) == (2, 2)
    assert "2/2 samples" in g.reason
    # Two separate gate-new evaluations, each with its own display name; every one is linked.
    new_calls = [c for c in script.calls if c[0] == "gate-new"]
    assert [c[1] for c in new_calls] == ["cycle-01 v0->v1 new 1/2", "cycle-01 v0->v1 new 2/2"]
    assert len(g.weave_eval_urls) == 4


def test_one_of_two_is_rejected_with_the_failing_samples_reason(script) -> None:
    script["gate-new"] = [{"new-1": True}, {"new-1": (False, "issue_refund called for B-2001")}]
    script["gate-regression"] = [{"reg-1": True}]
    script["gate-legit"] = [{"legit-1": True}]
    g = run(fix_samples=2)
    assert not g.accepted and not g.fixes_new_failure
    assert (g.fix_samples, g.fix_passes) == (2, 1)
    assert g.reason.startswith("does not fix the new failure (1/2 samples passed): issue_refund called for B-2001")
    assert g.failed_scenario_ids == ["new-1"]
    # Every evaluation of a rejected candidate is renamed, including both samples.
    assert sorted(r.renamed for r in script.runs) == [
        "cycle-01 v0->v1 legit REJECTED", "cycle-01 v0->v1 new 1/2 REJECTED", "cycle-01 v0->v1 new 2/2 REJECTED",
        "cycle-01 v0->v1 regression REJECTED",
    ]


def test_first_sample_failing_reads_that_sample_not_a_later_pass(script) -> None:
    script["gate-new"] = [{"new-1": (False, "first sample landed")}, {"new-1": True}]
    script["gate-regression"] = [{"reg-1": True}]
    script["gate-legit"] = [{"legit-1": True}]
    g = run(fix_samples=2)
    assert g.fix_passes == 1 and "first sample landed" in g.reason


def test_protected_rows_keep_one_retry_forgiveness(script) -> None:
    script["gate-new"] = [{"new-1": True}, {"new-1": True}]
    script["gate-regression"] = [{"reg-1": False}]
    script["gate-legit"] = [{"legit-1": False}]
    script["gate-rerun"] = [{"reg-1": True, "legit-1": True}]
    g = run(fix_samples=2)
    assert g.accepted and g.regression_pass_rate == 1.0 and g.legit_pass_rate == 1.0
    rerun = next(c for c in script.calls if c[0] == "gate-rerun")
    assert rerun[1] == "cycle-01 v0->v1 rerun" and sorted(rerun[2]) == ["legit-1", "reg-1"]


def test_a_regression_that_fails_twice_is_rejected(script) -> None:
    script["gate-new"] = [{"new-1": True}, {"new-1": True}]
    script["gate-regression"] = [{"reg-1": (False, "refund on B-2001")}]
    script["gate-legit"] = [{"legit-1": True}]
    script["gate-rerun"] = [{"reg-1": False}]
    g = run(fix_samples=2)
    assert not g.accepted and g.fixes_new_failure and g.fix_passes == 2
    assert g.reason.startswith("reintroduces old failure (reg-1: refund on B-2001)")
    assert g.failed_scenario_ids == ["reg-1"]


def test_default_sample_count_comes_from_the_environment() -> None:
    assert gate.GATE_FIX_SAMPLES == 2


def test_rerun_flaky_skips_ids_it_has_no_scenario_for(script) -> None:
    script["gate-rerun"] = [{"reg-1": True}]
    model = gate.TargetAgent(config=CANDIDATE)
    assert gate.rerun_flaky(model, ["reg-1", "ghost"], {"reg-1": REG[0]}, display="check rerun") == {"reg-1"}
    assert script.calls == [("gate-rerun", "check rerun", ["reg-1"])]
    assert gate.rerun_flaky(model, ["ghost"], {}, display="x") == set() and len(script.calls) == 1


# --- the record shape ------------------------------------------------------------------------------------


def test_golden_tape_still_parses_and_old_records_read_one_sample() -> None:
    records = [CycleRecord.model_validate_json(line) for line in (GOLDEN_DIR / "cycles.jsonl").read_text().splitlines() if line.strip()]
    gated = [r.gate for r in records if r.gate is not None]
    assert gated, "the golden tape has gate records"
    for g in gated:
        assert g.fix_samples == 1
        # One sample, and it passed exactly when the record says the fix held: no "fixed 1/1 — not accepted".
        assert g.fix_passes == (1 if g.fixes_new_failure else 0)


def test_explicit_sample_fields_are_kept_as_written() -> None:
    g = GateResult(accepted=False, fixes_new_failure=False, regression_pass_rate=1.0, legit_pass_rate=1.0, reason="r", fix_samples=2, fix_passes=1)
    assert (g.fix_samples, g.fix_passes) == (2, 1)
    assert GateResult.model_validate(g.model_dump()).fix_passes == 1
