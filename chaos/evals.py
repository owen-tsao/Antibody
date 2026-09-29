"""Weave-native evaluation layer.

- `TargetAgent` is a weave.Model over the AgentConfig plus the target's name, so every accepted
  config version (and the agent it was evaluated against) shows up as a distinct Model version in Weave.
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
from pydantic import Field, model_validator

from chaos.judge import judge_episode
from chaos.schemas import AgentConfig, Episode, Scenario, Verdict
from chaos.target import target_name
from chaos.target_agent import WRITE_REPLY_BACK, run_target_agent


class TargetAgent(weave.Model):
    config: AgentConfig
    # Which agent this model version was evaluated against. Defaults to the configured target so existing
    # `TargetAgent(config=…)` call sites evaluate the same agent the loop's cycle episodes ran on.
    target_name: str = Field(default_factory=target_name)
    # The published `StringPrompt` this config's system prompt is (plan 11 §4.5), when the loop published it; None
    # in a process that never did (the API, keyless tests). Filled below so no call site has to know about it.
    system_prompt_ref: str | None = None

    @model_validator(mode="after")
    def _reference_the_published_prompt(self) -> TargetAgent:
        if self.system_prompt_ref is None:
            self.system_prompt_ref = prompt_ref_for(self.config.system_prompt)
        return self

    @weave.op
    def predict(self, scenario: dict) -> dict:
        token = WRITE_REPLY_BACK.set(False)
        try:
            return run_target_agent(self.config, Scenario(**scenario), target_name=self.target_name).model_dump()
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
    # `reason` and `method` are what a monitor over this op judges the verdict by (docs/SMOKE.md, the judge monitor);
    # strings are left out of Weave's summary, so the leaderboard's `passed.true_fraction` is unchanged.
    return {
        "passed": verdict.passed,
        "failure_kind": verdict.failure_kind,
        "blocked_by": blocked or None,
        "reason": verdict.reason,
        "method": verdict.method,
    }


# --- datasets ----------------------------------------------------------------------


def scenario_rows(scenarios: list[Scenario]) -> list[dict[str, Any]]:
    return [{"scenario_id": s.id, "kind": s.kind, "title": s.title, "scenario": s.model_dump()} for s in scenarios]


def publish_dataset(name: str, scenarios: list[Scenario]) -> weave.Dataset:
    ds = weave.Dataset(name=name, rows=scenario_rows(scenarios))
    weave.publish(ds)
    return ds


# --- prompts as objects (plan 11 §4.5) ------------------------------------------------------------------------------

SYSTEM_PROMPT_NAME = "system-prompt"
JUDGE_PROMPT_NAME = "judge-system"

# Prompt text → the ref of its published `StringPrompt`, for this process. Filled by `publish_prompt` (the loop is the
# only process that publishes) and read by every `TargetAgent` built afterwards, so the Model version carries the
# prompt version it was evaluated with without any call site having to pass it along.
_prompt_refs: dict[str, str] = {}


def publish_prompt(name: str, text: str) -> str | None:
    """Publish `text` as a `weave.StringPrompt` named `name` and return its ref URI; Weave versions it by content, so
    re-publishing an unchanged prompt is the same version. None without a client or when Weave refuses: the loop and
    the judge use the text itself either way."""
    if weave.get_client() is None:
        return None
    try:
        ref = weave.publish(weave.StringPrompt(text), name=name).uri()
    except Exception as e:  # noqa: BLE001 - display feature; never blocks a cycle
        print(f"weave: could not publish prompt {name!r} ({type(e).__name__})")
        return None
    with _lock:
        _prompt_refs[text] = ref
    return ref


def prompt_ref_for(text: str) -> str | None:
    with _lock:
        return _prompt_refs.get(text)


# Not "legit-users": that is the Dataset's name, and Weave refuses two object types under one name (400 on publish).
LEGIT_EVALUATION_NAME = "legit-users-evaluation"


def legit_evaluation(dataset: weave.Dataset) -> tuple[weave.Evaluation, str | None]:
    """The one Evaluation object every legit leg of a run shares, plus its ref URI (plan 11 §4.3).

    Weave's leaderboard groups `Evaluation.evaluate` calls by the Evaluation object they ran and by the model they
    scored, so versions are only comparable when each was evaluated with the *same* object. The legit suite is the
    one leg whose dataset and scorer never change within a run, so it gets one object, published at run start and
    handed to `run_evaluation` in place of the dataset; `Leaderboard` then points at `ref`. Without a client (or
    when publishing fails) the object still works as an evaluation and `ref` is None: no leaderboard, same gates.
    """
    evaluation = weave.Evaluation(dataset=dataset, scorers=[judge_scorer], evaluation_name=LEGIT_EVALUATION_NAME)
    if weave.get_client() is None:
        return evaluation, None
    try:
        return evaluation, weave.publish(evaluation, name=LEGIT_EVALUATION_NAME).uri()
    except Exception as e:  # noqa: BLE001 - the leaderboard is a display feature; the gate must still run
        print(f"weave: could not publish the legit evaluation ({type(e).__name__}); no leaderboard this run")
        return evaluation, None


def publish_leaderboard(name: str, evaluation_ref: str, description: str) -> str | None:
    """One-column leaderboard over the shared legit evaluation: legit pass rate per config version. Returns its
    URL, or None when there is no client or Weave refused; either way the run is unaffected."""
    client = weave.get_client()
    if client is None:
        return None
    try:
        from weave.flow.leaderboard import Leaderboard, LeaderboardColumn
        from weave.trace.urls import leaderboard_path

        board = Leaderboard(
            name=name,
            description=description,
            columns=[LeaderboardColumn(evaluation_object_ref=evaluation_ref, scorer_name="judge_scorer", summary_metric_path="passed.true_fraction")],
        )
        ref = weave.publish(board, name=name)
        return leaderboard_path(ref.entity, ref.project, ref.name)
    except Exception as e:  # noqa: BLE001
        print(f"weave: could not publish the leaderboard ({type(e).__name__})")
        return None


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

    @property
    def call_id(self) -> str | None:
        """The Evaluation call's id, what a later decision attaches feedback to (plan 11 §4.6); None without a client."""
        try:
            return self.call.id or None
        except Exception:  # noqa: BLE001
            return None


def run_evaluation(
    model: TargetAgent,
    dataset: weave.Dataset | list[dict] | weave.Evaluation,
    evaluation_name: str,
    display_name: str,
) -> EvalRun:
    """Run one Weave Evaluation and return per-row verdicts.

    `dataset` may be a published Dataset, plain rows, or an existing `weave.Evaluation` (the run's shared legit
    evaluation, `legit_evaluation`), which is then run as is so the leaderboard can compare versions over it;
    `evaluation_name` only names a new object.

    Fails closed: Weave swallows exceptions from predict() and from scorers, so a row whose target or
    judge crashed would otherwise silently vanish from the denominator and inflate the pass rate. Any row
    that did not produce a verdict is recorded as a 'crash' failure instead.
    """
    _drain()
    if isinstance(dataset, weave.Evaluation):
        evaluation, dataset = dataset, dataset.dataset
    else:
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
