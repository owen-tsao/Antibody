"""Noise probe: how often does the same (config, scenario) flip verdict across repeated evaluations?

The target is an 8B model and the judge an LLM, so a single verdict is a sample, not a fact. This runs the
golden regression suite and the legit suite N times each (default 5) against one saved config and reports,
per row, how many samples passed. Rows that flipped at least once are the noise the gate's re-run and the
two-of-two rule exist for; the counts go into docs/plans/04-models-and-gate-quality.md.

Needs WANDB_API_KEY (every sample is a Weave evaluation named `noise-probe`, so the project stays filterable).
Mock world unless Zendesk is configured: the golden rows carry ticket ids from the Zendesk world, and with
ANTIBODY_NO_ZENDESK=1 they run as mock with the injection arriving through the lookup_order fault.

    set -a; source .env; set +a
    ANTIBODY_NO_ZENDESK=1 uv run python scripts/measure_noise.py
    ANTIBODY_NO_ZENDESK=1 ANTIBODY_JUDGE_MODEL=deepseek-ai/DeepSeek-V4-Pro uv run python scripts/measure_noise.py

Run each once; a probe of 5 samples over 14 rows is about 70 episodes plus their judge calls.
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import weave  # noqa: E402

from chaos import zendesk  # noqa: E402
from chaos.config import ENTITY_PROJECT, JUDGE_MODEL, TARGET_MODEL  # noqa: E402
from chaos.evals import TargetAgent, run_evaluation, scenario_rows  # noqa: E402
from chaos.domains import active_domain  # noqa: E402
from chaos.schemas import AgentConfig, Scenario  # noqa: E402
from chaos.state import GOLDEN_DIR  # noqa: E402


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument("--config", type=Path, default=GOLDEN_DIR / "runs" / "configs" / "v3.json", help="saved AgentConfig to probe")
    p.add_argument("--regression", type=Path, default=GOLDEN_DIR / "runs" / "regression.json", help="regression suite to probe")
    p.add_argument("--samples", type=int, default=5)
    args = p.parse_args()

    cfg = AgentConfig.model_validate_json(args.config.read_text())
    regression = [Scenario.model_validate(r) for r in json.loads(args.regression.read_text())]
    world = "zendesk" if zendesk.enabled() else "mock"

    for name in ("weave", "weave.evaluation.eval"):
        logging.getLogger(name).setLevel(logging.WARNING)
    weave.init(ENTITY_PROJECT)
    model = TargetAgent(config=cfg)

    print(f"# noise probe · {date.today().isoformat()} · world {world} · config v{cfg.version} · target {model.target_name} ({TARGET_MODEL}) · judge {JUDGE_MODEL} · {args.samples} samples\n")
    for suite, scenarios in (("regression", regression), ("legit", active_domain().legit)):
        passes: dict[str, list[bool]] = {s.id: [] for s in scenarios}
        reasons: dict[str, set[str]] = {s.id: set() for s in scenarios}
        for i in range(args.samples):
            run = run_evaluation(model, scenario_rows(scenarios), "noise-probe", f"noise-probe v{cfg.version} {suite} {i + 1}/{args.samples} judge={JUDGE_MODEL}")
            for sid, v in run.verdicts.items():
                passes[sid].append(v.passed)
                if not v.passed:
                    reasons[sid].add(f"{v.failure_kind or 'failed'}: {v.reason[:90]}")
            print(f"  {suite} sample {i + 1}/{args.samples}: {sum(v.passed for v in run.verdicts.values())}/{len(run.verdicts)} passed", file=sys.stderr)
        flipped = [sid for sid, ps in passes.items() if 0 < sum(ps) < len(ps)]
        print(f"## {suite}: {len(scenarios)} rows, {len(flipped)} flipped at least once in {args.samples}\n")
        print("| Row | Passed | Flipped | Failure reasons seen |")
        print("| --- | --- | --- | --- |")
        for sid, ps in passes.items():
            print(f"| `{sid}` | {sum(ps)}/{len(ps)} | {'yes' if sid in flipped else ''} | {'; '.join(sorted(reasons[sid])) or ''} |")
        print()
        print(f"Measurements-table row: | {date.today().isoformat()} | {world} | {JUDGE_MODEL.split('/')[-1]} | {suite} | {len(scenarios)} | {len(flipped)} | {', '.join(f'`{s}`' for s in flipped) or '—'} |\n")


if __name__ == "__main__":
    main()
