"""Weave-native evaluation layer.

- `TargetAgent` is a weave.Model whose only attribute is the AgentConfig, so every
  accepted config version shows up as a distinct Model version in Weave.
- The regression suite and legit set are weave.Datasets (regression is re-published
  every time a new failure is captured).
- `judge_scorer` wraps the Judge as a Weave scorer and also records per-row verdicts
  in an in-process collector, because `Evaluation.evaluate()` only returns a summary
  and the gate needs to know *which* scenarios failed.
"""

from __future__ import annotations

import asyncio
import threading
from typing import Any

import weave

from chaos.judge import judge_episode
from chaos.schemas import AgentConfig, Episode, Scenario, Verdict
from chaos.target_agent import WRITE_REPLY_BACK, run_target_agent


class TargetAgent(weave.Model):
    config: AgentConfig

    @weave.op
    def predict(self, scenario: dict) -> dict:
        token = WRITE_REPLY_BACK.set(False)
        try:
            return run_target_agent(self.config, Scenario(**scenario)).model_dump()
        finally:
            WRITE_REPLY_BACK.reset(token)


# --- per-row verdict collector ---------------------------------------------------

_lock = threading.Lock()
_collector: dict[str, Verdict] = {}


def _collect(verdict: Verdict) -> None:
    with _lock:
        _collector[verdict.scenario_id] = verdict


def _drain() -> dict[str, Verdict]:
    with _lock:
        out = dict(_collector)
        _collector.clear()
    return out


@weave.op
def judge_scorer(scenario: dict, output: dict) -> dict:
    sc = Scenario(**scenario)
    ep = Episode(**output)
    verdict = judge_episode(sc, ep)
    _collect(verdict)
    blocked = [tc.tool for tc in ep.tool_calls if tc.blocked_by_policy]
    return {
        "passed": verdict.passed,
        "failure_kind": verdict.failure_kind,
        "blocked_by": blocked or None,
    }


# --- datasets ----------------------------------------------------------------------


def scenario_rows(scenarios: list[Scenario]) -> list[dict[str, Any]]:
    return [{"scenario_id": s.id, "kind": s.kind, "title": s.title, "scenario": s.model_dump()} for s in scenarios]


def publish_dataset(name: str, scenarios: list[Scenario]) -> weave.Dataset:
    ds = weave.Dataset(name=name, rows=scenario_rows(scenarios))
    weave.publish(ds)
    return ds


# --- running one evaluation ---------------------------------------------------------


class EvalRun:
    def __init__(self, summary: dict, verdicts: dict[str, Verdict], call: Any):
        self.summary = summary
        self.verdicts = verdicts
        self.call = call

    @property
    def pass_rate(self) -> float:
        if not self.verdicts:
            return 0.0
        return sum(v.passed for v in self.verdicts.values()) / len(self.verdicts)

    @property
    def failed_ids(self) -> list[str]:
        return [sid for sid, v in self.verdicts.items() if not v.passed]

    def rename(self, display_name: str) -> None:
        try:
            self.call.set_display_name(display_name)
        except Exception:  # noqa: BLE001 - renaming is cosmetic; never fail the gate over it
            pass

    @property
    def url(self) -> str | None:
        try:
            return self.call.ui_url
        except Exception:  # noqa: BLE001 - a missing link is cosmetic
            return None


def run_evaluation(
    model: TargetAgent,
    dataset: weave.Dataset | list[dict],
    evaluation_name: str,
    display_name: str,
) -> EvalRun:
    """Run one Weave Evaluation and return per-row verdicts.

    Fails closed: Weave swallows exceptions from predict() and from scorers, so a row whose target or
    judge crashed would otherwise silently vanish from the denominator and inflate the pass rate. Any row
    that did not produce a verdict is recorded as a 'crash' failure instead.
    """
    _drain()
    evaluation = weave.Evaluation(dataset=dataset, scorers=[judge_scorer], evaluation_name=evaluation_name)

    async def _go():
        return await evaluation.evaluate.call(evaluation, model, __weave={"display_name": display_name})

    summary, call = asyncio.run(_go())
    verdicts = _drain()

    rows = dataset if isinstance(dataset, list) else list(dataset.rows)
    for row in rows:
        sid = row["scenario_id"]
        if sid not in verdicts:
            verdicts[sid] = Verdict(
                scenario_id=sid,
                config_version=model.config.version,
                passed=False,
                failure_kind="crash",
                reason="target agent or judge raised an exception during evaluation; treated as a failure",
                method="deterministic",
            )
    return EvalRun(summary=summary or {}, verdicts=verdicts, call=call)
