"""Import a real support conversation as a regression scenario (docs/plans/09-roadmap-v1.md §3).

A team's worst incidents are its best tests. The transcript becomes a `Scenario` with `origin="imported"`
(chaos.scenarios.from_transcript), lands in the live `runs/regression.json`, and from then on every run's
gate and every `check` must pass it. Like rollback, this is a write into the live suite: it refuses while a
loop runs (the loop owns that file), takes `runs_lock`, and refuses a torn suite rather than merging into [].

Unlike `merge_suites`, the incoming row wins on an id clash: the id is a hash of the customer text, so a clash
is the same incident re-imported — usually with a corrected title or family — and the newer row is the fix.
"""

from __future__ import annotations

from api import loop_ctl
from chaos import state
from chaos.scenarios import from_transcript
from chaos.schemas import Scenario, ScenarioKind


class ImportRefused(Exception):
    """Cannot write the live suite right now (a loop runs, or the file is torn); the message says why. Maps to 409."""


def import_incident(text: str, *, kind: ScenarioKind, title: str = "", customer_id: str | None = None) -> tuple[Scenario, bool]:
    """Parse, then add to (or replace in) the live suite. Returns `(scenario, created)`; ValueError for a bad paste."""
    scenario = from_transcript(text, kind=kind, title=title, customer_id=customer_id)
    with loop_ctl.runs_lock:
        if loop_ctl.state()["running"]:
            raise ImportRefused("a loop is running and owns the regression suite; stop it first")
        try:
            suite = state.load_regression()
        except (ValueError, TypeError) as e:
            raise ImportRefused(f"live regression.json is unreadable ({e}); fix or remove it first")
        created = all(s.id != scenario.id for s in suite)
        merged = [s for s in suite if s.id != scenario.id] + [scenario]
        state.save_regression(merged)
    return scenario, created
