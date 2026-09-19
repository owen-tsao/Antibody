"""`chaos.loop check`: regression + legit against one saved config, no new attacks, exit 1 on any failure.

Run with `env -u WANDB_API_KEY uv run pytest -q`. `run_evaluation` is a scripted stand-in, so the command's
decisions, output shapes (text and `--json`) and exit codes are checked without inference or Weave. The
GitHub Action in examples/ci/check.yml is parsed and its JSON reads are checked against the real shape.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest
import yaml

from chaos import gate, loop, state
from chaos.scenarios import LEGIT_SCENARIOS
from chaos.schemas import AgentConfig, Scenario, Verdict
from chaos.target_agent import V0_CONFIG

REGRESSION = [
    Scenario(id="seed-injection-refund", kind="prompt_injection_via_tool", title="Injected refund", user_message="m", expected_behavior="x", origin="seed"),
    Scenario(id="chaos-1-abc", kind="social_engineering", title="Sympathetic story", user_message="m", expected_behavior="x"),
]


class FakeRun:
    def __init__(self, verdicts: dict[str, Verdict]):
        self.verdicts = verdicts
        self.url = None


@pytest.fixture
def runs(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    monkeypatch.setenv("ANTIBODY_NO_ZENDESK", "1")  # the mock world, whatever the shell has in it
    runs = tmp_path / "runs"
    monkeypatch.setattr(state, "RUNS_DIR", runs)
    monkeypatch.setattr(state, "CONFIGS_DIR", runs / "configs")
    monkeypatch.setattr(state, "REGRESSION_PATH", runs / "regression.json")
    return runs


@pytest.fixture
def scripted(monkeypatch: pytest.MonkeyPatch):
    """`scripted.fail` is the set of ids that fail on first run; `scripted.recover` those that pass on the re-run.

    Both `chaos.loop.run_evaluation` and `chaos.gate.run_evaluation` are replaced: `check` calls the first for
    its two suites and the gate's `rerun_flaky` for the retry.
    """

    class Script:
        fail: set[str] = set()
        recover: set[str] = set()
        calls: list[tuple[str, str, list[str]]] = []

    s = Script()

    def fake(model, rows, name, display):
        ids = [r["scenario_id"] for r in rows]
        s.calls.append((name, display, ids))
        rerun = name == "gate-rerun"
        return FakeRun({
            sid: Verdict(
                scenario_id=sid, config_version=model.config.version,
                passed=(sid in s.recover) if rerun else (sid not in s.fail),
                failure_kind=None if (sid in s.recover if rerun else sid not in s.fail) else "unauthorized_action",
                reason=f"{sid} verdict", method="deterministic",
            )
            for sid in ids
        })

    monkeypatch.setattr(loop, "run_evaluation", fake)
    monkeypatch.setattr(gate, "run_evaluation", fake)
    return s


# --- which config ---------------------------------------------------------------------------------------------


def test_v0_is_always_available(runs: Path) -> None:
    assert loop.check_config(None) == V0_CONFIG
    assert loop.check_config(0) == V0_CONFIG


def test_default_is_the_latest_saved_config(runs: Path) -> None:
    for v in (0, 1, 2):
        state.save_config(AgentConfig(version=v, system_prompt=f"v{v}", parent_version=v - 1 if v else None))
    assert loop.check_config(None).version == 2
    assert loop.check_config(1).system_prompt == "v1"
    # A saved v0 wins over the code's constant (a rollback may have rewritten it).
    assert loop.check_config(0).system_prompt == "v0"


def test_a_version_nobody_saved_is_an_error(runs: Path) -> None:
    with pytest.raises(FileNotFoundError, match="v7"):
        loop.check_config(7)


# --- the verdicts -----------------------------------------------------------------------------------------------


def test_all_passing(runs: Path, scripted) -> None:
    result = loop.run_check(V0_CONFIG, REGRESSION, LEGIT_SCENARIOS)
    assert result["ok"] is True
    assert result["regression"] == {"passed": 2, "total": 2}
    assert result["legit"] == {"passed": len(LEGIT_SCENARIOS), "total": len(LEGIT_SCENARIOS)}
    assert result["version"] == 0 and result["world"] == "mock" and result["target"] == "builtin"
    assert [c[0] for c in scripted.calls] == ["check-regression", "check-legit"]
    assert all(r["passed"] and not r["flaky"] and r["reason"] is None for r in result["rows"])
    assert {r["suite"] for r in result["rows"]} == {"regression", "legit"}


def test_a_landed_attack_fails_the_check_with_its_reason(runs: Path, scripted) -> None:
    scripted.fail = {"seed-injection-refund"}
    result = loop.run_check(V0_CONFIG, REGRESSION, LEGIT_SCENARIOS)
    assert result["ok"] is False and result["regression"] == {"passed": 1, "total": 2}
    row = next(r for r in result["rows"] if r["id"] == "seed-injection-refund")
    assert row == {
        "id": "seed-injection-refund", "suite": "regression", "title": "Injected refund",
        "passed": False, "flaky": False, "failure_kind": "unauthorized_action", "reason": "seed-injection-refund verdict",
    }
    # The failing row got the gate's one re-run, through the same function the gate uses.
    assert scripted.calls[-1] == ("gate-rerun", "check v0 rerun", ["seed-injection-refund"])


def test_a_row_that_passes_on_rerun_is_forgiven_but_marked(runs: Path, scripted) -> None:
    scripted.fail = {"legit-status", "chaos-1-abc"}
    scripted.recover = {"legit-status"}
    result = loop.run_check(V0_CONFIG, REGRESSION, LEGIT_SCENARIOS)
    assert result["ok"] is False
    legit = next(r for r in result["rows"] if r["id"] == "legit-status")
    assert legit["passed"] and legit["flaky"] and legit["reason"] == "legit-status verdict" and legit["failure_kind"] is None
    assert result["legit"]["passed"] == len(LEGIT_SCENARIOS)
    assert not next(r for r in result["rows"] if r["id"] == "chaos-1-abc")["passed"]


def test_no_regression_suite_checks_legit_alone(runs: Path, scripted) -> None:
    result = loop.run_check(V0_CONFIG, [], LEGIT_SCENARIOS)
    assert result["regression"] == {"passed": 0, "total": 0} and result["ok"] is True
    assert [c[0] for c in scripted.calls] == ["check-legit"]


# --- output and exit codes --------------------------------------------------------------------------------------


def test_text_output_is_one_line_per_test_and_a_summary(runs: Path, scripted) -> None:
    scripted.fail = {"chaos-1-abc", "legit-status"}
    scripted.recover = {"legit-status"}
    text = loop.format_check(loop.run_check(V0_CONFIG, REGRESSION, LEGIT_SCENARIOS))
    lines = text.splitlines()
    assert lines[0].startswith("PASS ") and "seed-injection-refund" in lines[0]
    assert lines[1].startswith("FAIL ") and "chaos-1-abc" in lines[1]
    assert "unauthorized_action: chaos-1-abc verdict" in lines[2]
    assert any(line.startswith("PASS (on re-run)") and "legit-status" in line for line in lines)
    assert lines[-1] == f"regression 1/2 · legit {len(LEGIT_SCENARIOS)}/{len(LEGIT_SCENARIOS)} · config v0 · target builtin · world mock"


def test_exit_codes(runs: Path, scripted, capsys: pytest.CaptureFixture[str]) -> None:
    state.save_regression(REGRESSION)
    assert loop.check(None) == 0
    scripted.fail = {"chaos-1-abc"}
    assert loop.check(None) == 1
    assert loop.check(9) == 2
    assert "v9" in capsys.readouterr().err


def test_nothing_captured_is_exit_2_not_a_pass(runs: Path, scripted, capsys: pytest.CaptureFixture[str]) -> None:
    """No --version, no saved config, no suite: a mistyped ANTIBODY_RUNS_DIR in CI must not pass forever."""
    assert loop.check(None) == 2
    err = capsys.readouterr().err
    assert "nothing captured under" in err and str(runs) in err and "--version 0" in err
    assert not scripted.calls


def test_explicit_version_0_runs_the_legit_suite_alone(runs: Path, scripted, capsys: pytest.CaptureFixture[str]) -> None:
    assert loop.check(0) == 0
    assert [c[0] for c in scripted.calls] == ["check-legit"]
    assert "regression 0/0" in capsys.readouterr().out


def test_a_suite_without_configs_is_still_checkable_by_default(runs: Path, scripted) -> None:
    """A committed regression.json with no configs/ (a customer keeps only the suite) checks against v0."""
    state.save_regression(REGRESSION)
    assert loop.check(None) == 0
    assert [c[0] for c in scripted.calls] == ["check-regression", "check-legit"]


def test_check_without_a_key_says_so_before_touching_weave() -> None:
    import os
    import subprocess
    import sys

    # An empty value beats `load_env`'s setdefault, so this holds even in a checkout whose .env has a key.
    env = {**os.environ, "WANDB_API_KEY": ""}
    r = subprocess.run([sys.executable, "-m", "chaos.loop", "check"], cwd=state.ROOT, env=env, capture_output=True, text=True, timeout=120)
    assert r.returncode == 2
    lines = [line for line in r.stderr.strip().splitlines() if line.strip()]
    assert len(lines) == 1 and "WANDB_API_KEY" in lines[0], r.stderr


def test_json_output_is_one_document(runs: Path, scripted, capsys: pytest.CaptureFixture[str]) -> None:
    state.save_regression(REGRESSION)
    scripted.fail = {"seed-injection-refund"}
    assert loop.check(0, as_json=True) == 1
    doc = json.loads(capsys.readouterr().out)
    assert doc["ok"] is False and doc["version"] == 0
    assert set(doc) == {"ok", "version", "target", "world", "regression", "legit", "rows"}
    assert set(doc["rows"][0]) == {"id", "suite", "title", "passed", "flaky", "failure_kind", "reason"}


def test_ci_example_reads_only_fields_the_json_has(runs: Path, scripted) -> None:
    """examples/ci/check.yml parses as a workflow and every `r.<field>` / `.<field>` it reads exists in the result."""
    doc = yaml.safe_load((state.ROOT / "examples" / "ci" / "check.yml").read_text())
    steps = doc["jobs"]["check"]["steps"]
    run_step = next(s for s in steps if s.get("id") == "check")
    assert "chaos.loop check --json" in run_step["run"]
    assert run_step["env"]["ANTIBODY_TARGET"].startswith("http://127.0.0.1:")
    assert "ANTIBODY_RUNS_DIR" in run_step["env"]
    # Exit 2 leaves an empty check.json; the jq lines must be behind a validity check, not fed the empty file.
    assert 'jq -e . "$RUNNER_TEMP/check.json"' in run_step["run"]
    assert run_step["run"].index("jq -e .") < run_step["run"].index("jq -r '.rows[]")

    result = loop.run_check(V0_CONFIG, REGRESSION, LEGIT_SCENARIOS)
    row_keys = set(result["rows"][0])
    text = json.dumps(steps)
    for field in set(re.findall(r"\br\.(\w+)", text)):
        assert field in result, f"check.yml reads r.{field}, which `check --json` does not emit"
    for field in set(re.findall(r"\brow\.(\w+)", text)):
        assert field in row_keys, f"check.yml reads row.{field}, which rows do not carry"
    for field in set(re.findall(r"\.(regression|legit)\.(\w+)", text)):
        assert field[1] in result[field[0]]
    # The failing step keys off the recorded exit status, and the comment is posted even on failure.
    assert any(s.get("if", "").startswith("steps.check.outputs.status") for s in steps)
    assert any("always()" in s.get("if", "") for s in steps)


def test_check_parser(monkeypatch: pytest.MonkeyPatch) -> None:
    import subprocess
    import sys

    r = subprocess.run([sys.executable, "-m", "chaos.loop", "check", "--help"], cwd=state.ROOT, capture_output=True, text=True, timeout=120)
    assert r.returncode == 0, r.stderr
    assert "--version" in r.stdout and "--json" in r.stdout and "WANDB_API_KEY" in r.stdout
