"""The orchestrator: one full turn of the self-healing loop.

    scenario -> target agent -> judge -> (if failed) repair -> gate -> accept/reject
              -> failure joins the permanent regression suite -> next scenario

A rejected patch is not final. Within a cycle the Repair Agent gets a few attempts with the gate's
reason fed back; at the end of the run a second pass revisits every failure that stayed unfixed, with
the evolved config and the full repair memory. If the gate still says no, the record says unfixed.

By default the run invents exactly `--chaos-cycles` novel attacks after the seeds. With `--until-quiet N`
it stops inventing them as soon as N in a row were blocked, and `--chaos-cycles` is only the cap.

Every cycle is appended to cycles.jsonl for the dashboard and to Weave for audit.

`chaos.loop check [--version N] [--json]` is the read-only companion: it re-runs the captured regression
suite and the legit suite against one saved config with no new attacks and exits 1 if anything fails —
pytest for the agent, meant for a customer's CI after they change their prompt, model or framework.
"""

from __future__ import annotations

import json
import os
import signal
import sys

import weave

from chaos import zendesk
from chaos.chaos_agent import family_stats, generate_scenario
from chaos.config import ENTITY_PROJECT
from chaos.evals import TargetAgent, publish_dataset, run_evaluation, scenario_rows
from chaos.gate import rerun_flaky, run_gate
from chaos.judge import judge_episode
from chaos.repair_agent import EXHAUSTED_RATIONALE, apply_patch, build_memory, propose_patch
from chaos.scenarios import LEGIT_SCENARIOS, SEED_SCENARIOS
from chaos.schemas import AgentConfig, CycleRecord, GateResult, Scenario
from chaos.state import (
    CYCLES_PATH,
    archive_previous_run,
    load_config,
    load_regression,
    reset,
    save_config,
    save_regression,
    snapshot_golden,
    write_run_manifest,
)
from chaos.status import set_phase, start_run
from chaos.target_agent import V0_CONFIG, run_target_agent

MAX_REPAIR_ATTEMPTS = 3
# Episodes per (version, scenario) pair when measuring vulnerability; an attack lands if it lands in the majority.
VULNERABILITY_SAMPLES = 3


class LoopState:
    def __init__(self, cfg: AgentConfig | None = None, regression_suite: list[Scenario] | None = None):
        self.cfg = cfg or V0_CONFIG
        self.regression_suite: list[Scenario] = list(regression_suite or [])
        self.cycle = _last_cycle_number()
        # Full cycle history: the Chaos Agent's bandit and the Repair Agent's memory both learn from it.
        self.records: list[CycleRecord] = _load_records()
        self.config_history: list[AgentConfig] = [self.cfg]
        self.baseline: dict[str, bool] = {}
        # Legit traffic lives in real tickets too, filed once per run and reused by every evaluation.
        self.legit_suite: list[Scenario] = [zendesk.file_scenario(s) for s in LEGIT_SCENARIOS]
        if zendesk.enabled() and not any(s.ticket_id for s in self.legit_suite):
            # Zendesk answered but refused every ticket (expired trial, revoked token). Mid-run failures fail
            # closed per episode; a world that is dead before the run starts is a different case, and the
            # honest move is one labeled decision up front rather than a run made entirely of crash cycles.
            os.environ["ANTIBODY_NO_ZENDESK"] = "1"
            print("World: Zendesk refused to create tickets; this run uses the mock world instead")
        self.legit_dataset = publish_dataset("legit-users", self.legit_suite)
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

    def refresh_baseline(self, just_fixed: str | None = None) -> list[str]:
        """Measure what production actually passes today: the bar a patch must not lower.

        Both suites are measured, not assumed. A regression scenario that some later patch happened to fix
        incidentally is protected from being un-fixed, because the gate compares against this map.
        `just_fixed` is the scenario the gate just verified; it is recorded as passing even if the
        small target model is flaky on the re-measure, because the gate's evidence is fresher.

        Returns the ids of regression scenarios that were measured failing before and pass now, other than
        `just_fixed`: holes a patch closed without being aimed at them.
        """
        previous = dict(self.baseline)
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
        also_fixed = [
            s.id for s in self.regression_suite
            if s.id != just_fixed and previous.get(s.id) is False and self.baseline.get(s.id) is True
        ]
        if also_fixed:
            print(f"  baseline: this patch also closed {len(also_fixed)} earlier unfixed hole(s): {also_fixed}")
        return also_fixed

    def unfixed_scenarios(self) -> list[tuple[int, Scenario]]:
        """Failures the loop gave up on, oldest first: the latest record for that scenario is a landed attack
        whose patch was rejected. A later patch may have closed the hole incidentally; the second pass still
        replays the attack so that closure is a recorded, visible cycle rather than a silent baseline number.
        """
        latest: dict[str, CycleRecord] = {}
        for rec in self.records:
            latest[rec.scenario.id] = rec
        out: list[tuple[int, Scenario]] = []
        for rec in latest.values():
            if not rec.attack_succeeded or (rec.gate is not None and rec.gate.accepted):
                continue
            captured = next((s for s in self.regression_suite if s.id == rec.scenario.id), rec.scenario)
            out.append((rec.cycle, captured))
        return sorted(out, key=lambda t: t[0])


def _regressed(gate: GateResult, state: LoopState) -> bool:
    """True if the gate found a scenario that production passes but the candidate fails."""
    return any(state.baseline.get(sid, False) for sid in gate.failed_scenario_ids)


def _keep_as_base(gate: GateResult, state: LoopState, evaluated: bool) -> bool:
    """Whether a rejected candidate becomes the base of the next repair attempt, so fixes can stack.

    Yes when it did not fully fix the failure but broke nothing production passes — `_regressed` covers
    regression and legit rows alike, since a newly broken legit row is in `failed_scenario_ids` with a true
    baseline. A legit row v0 already fails does not block stacking (it is not collateral damage). A candidate
    the gate never evaluated (`evaluated=False`, a crash) is not known to be harmless and is dropped.
    """
    return evaluated and not gate.fixes_new_failure and not _regressed(gate, state)


def _last_cycle_number() -> int:
    records = _load_records()
    return records[-1].cycle if records else 0


def _load_records() -> list[CycleRecord]:
    if not CYCLES_PATH.exists():
        return []
    out: list[CycleRecord] = []
    for line in CYCLES_PATH.read_text().splitlines():
        if not line.strip():
            continue
        try:
            out.append(CycleRecord.model_validate_json(line))
        except Exception:  # noqa: BLE001 - a torn write from an interrupted run must not prevent the next run
            continue
    return out


def _log_cycle(record: CycleRecord) -> None:
    with CYCLES_PATH.open("a") as f:
        f.write(record.model_dump_json() + "\n")


def _current_trace_url() -> str | None:
    try:
        call = weave.get_current_call()
        return call.ui_url if call is not None else None
    except Exception:  # noqa: BLE001 - a missing link is cosmetic
        return None


@weave.op
def run_cycle(state: LoopState, scenario: Scenario, retry_of: int | None = None) -> CycleRecord:
    state.cycle += 1
    before = state.cfg.version
    scenario = zendesk.file_scenario(scenario)
    label = f" | second pass on cycle {retry_of}" if retry_of else ""
    print(f"\n{'=' * 70}\nCYCLE {state.cycle} | config v{before} | {scenario.title}{label}")

    set_phase(state.cycle, "target", retry_of=retry_of)
    episode = run_target_agent(state.cfg, scenario)
    set_phase(state.cycle, "judge", retry_of=retry_of)
    verdict = judge_episode(scenario, episode)
    for tc in episode.tool_calls:
        flag = " [BLOCKED BY POLICY]" if tc.blocked_by_policy else ""
        print(f"  target -> {tc.tool}({json.dumps(tc.args)}){flag}")
    print(f"  target reply: {episode.final_reply[:160]!r}")
    print(f"  judge [{verdict.method}]: {'PASS' if verdict.passed else 'FAIL ' + str(verdict.failure_kind)} — {verdict.reason}")

    patch = None
    gate = None
    also_fixed: list[str] = []
    if not verdict.passed:
        state.capture_regression(scenario)
        rejected: list[str] = []
        base = state.cfg
        memory = build_memory(state.records)
        for attempt in range(1, MAX_REPAIR_ATTEMPTS + 1):
            set_phase(state.cycle, "repair", True, attempt=attempt, retry_of=retry_of)
            proposed = propose_patch(base, scenario, episode, verdict, rejected, memory=memory)
            if proposed.rationale == EXHAUSTED_RATIONALE:
                # Every kind this target supports was already rejected this cycle; gating a canned repeat
                # would spend three evaluations to learn nothing. The record keeps the last real attempt.
                print(f"  repair attempt {attempt}: skipped — {proposed.rationale}")
                break
            patch = proposed
            candidate = apply_patch(base, patch)
            candidate.version = state.cfg.version + 1
            candidate.parent_version = state.cfg.version
            if base is not state.cfg:
                # Stacked on a kept partial fix: the note must tell the whole story, not just the last step.
                candidate.patch_note = f"{base.patch_note} + {candidate.patch_note}"
            print(f"  repair attempt {attempt}: {patch.kind} — {patch.rationale[:120]}")
            print(f"    patch detail: {_patch_detail(patch)}")
            # The regression suite includes the new failure, which the gate evaluates on its own,
            # so it is given the rest of the suite as plain rows rather than the published dataset.
            set_phase(state.cycle, "gate", True, attempt=attempt, retry_of=retry_of)
            evaluated = True
            try:
                gate = run_gate(
                    candidate,
                    scenario,
                    [s for s in state.regression_suite if s.id != scenario.id],
                    state.legit_suite,
                    state.baseline,
                    cycle=state.cycle,
                    from_version=state.cfg.version,
                    legit_dataset=state.legit_dataset,
                )
            except Exception as e:  # noqa: BLE001 - a Weave/W&B outage mid-gate rejects the patch; it must not end the run
                print(f"  gate crashed ({type(e).__name__}); treating the candidate as rejected")
                evaluated = False
                gate = GateResult(
                    accepted=False, fixes_new_failure=False, regression_pass_rate=0.0, legit_pass_rate=0.0,
                    failed_scenario_ids=[scenario.id], reason=f"gate crashed: {type(e).__name__}: {e}"[:300],
                )
            print(
                f"  gate: {'ACCEPTED' if gate.accepted else 'REJECTED'} "
                f"(fixes={gate.fix_passes}/{gate.fix_samples}, regression={gate.regression_pass_rate:.0%}, legit={gate.legit_pass_rate:.0%}) — {gate.reason}"
            )
            if gate.accepted:
                state.promote(candidate)
                set_phase(state.cycle, "baseline", False, retry_of=retry_of)
                also_fixed = state.refresh_baseline(just_fixed=scenario.id)
                break
            rejected.append(f"{patch.kind}: {gate.reason}")
            if _keep_as_base(gate, state, evaluated):
                base = candidate
                print("  keeping partial fix as base for next attempt")

    record = CycleRecord(
        cycle=state.cycle,
        scenario=scenario,
        attack_succeeded=not verdict.passed,
        episode=episode,
        verdict=verdict,
        patch=patch,
        gate=gate,
        config_before=before,
        config_after=state.cfg.version,
        regression_suite_size=len(state.regression_suite),
        legit_suite_size=len(state.legit_suite),
        weave_call_url=_current_trace_url(),
        retry_of=retry_of,
        also_fixed=also_fixed,
    )
    _log_cycle(record)
    state.records.append(record)
    set_phase(state.cycle, "idle", not verdict.passed, retry_of=retry_of)
    return record


def main() -> None:
    import argparse
    import logging

    global MAX_REPAIR_ATTEMPTS

    parser = argparse.ArgumentParser(prog="chaos.loop", description="Antibody: the self-healing loop for AI agents")
    sub = parser.add_subparsers(dest="command")

    run_p = sub.add_parser("run", help="run the loop (default)")
    run_p.add_argument(
        "--chaos-cycles", type=int, default=3,
        help="novel scenarios the Chaos Agent should invent after the seeds (with --until-quiet: at most this many)",
    )
    run_p.add_argument(
        "--until-quiet", type=int, default=None, metavar="N",
        help="stop inventing scenarios once N chaos attacks in a row were blocked; --chaos-cycles becomes the cap",
    )
    run_p.add_argument("--no-seeds", action="store_true", help="skip the hand-written seed scenarios")
    run_p.add_argument(
        "--seeds", type=int, default=None, metavar="N",
        help="run only the first N seed scenarios (default: all). --seeds 1 --chaos-cycles 1 is the short recording shape",
    )
    run_p.add_argument(
        "--repair-attempts", type=int, default=MAX_REPAIR_ATTEMPTS, metavar="N",
        help=f"max repair proposals per failed attack before giving up (default {MAX_REPAIR_ATTEMPTS})",
    )
    run_p.add_argument(
        "--from-version", type=int, default=None,
        help="start from a saved config version (0 = fresh v0; omit = fresh v0 too, since the hardened config has nothing left to show)",
    )
    run_p.add_argument("--resume", action="store_true", help="continue from the latest saved config and regression suite")
    run_p.add_argument(
        "--no-second-pass", action="store_true",
        help="skip the end-of-run second pass that revisits failures the loop could not fix",
    )
    run_p.add_argument(
        "--vulnerability", action=argparse.BooleanOptionalAction, default=False,
        help=(
            "after the run, measure how many of the final suite's attacks land on v0 and on the final config "
            f"({VULNERABILITY_SAMPLES} samples each) and write runs/vulnerability.json. Off by default from the "
            "CLI; the dashboard turns it on"
        ),
    )

    sub.add_parser("reset", help="wipe runs/ and cycles.jsonl")
    sub.add_parser("golden", help="snapshot the current run into data/golden/ for demo fallback")
    sub.add_parser(
        "vulnerability",
        help="run every saved config version against the final regression suite; write runs/vulnerability.json",
    )
    sub.add_parser("cleanup", help="solve every Zendesk ticket this harness created")
    check_p = sub.add_parser(
        "check",
        help="re-verify the current config: regression suite + legit suite, no new attacks; exit 1 on any failure",
        description=(
            "pytest for your agent. Runs every captured attack (runs/regression.json) and every legit-user scenario "
            "against one saved config with no new attacks, prints one line per test, and exits 1 if anything fails. "
            "Needs WANDB_API_KEY (every row is a Weave evaluation). Attacks the agent named by ANTIBODY_TARGET."
        ),
    )
    check_p.add_argument("--version", type=int, default=None, metavar="N", help="saved config to check (default: the latest; 0 is always available)")
    check_p.add_argument("--json", action="store_true", help="print one JSON document instead of the per-test lines")

    args = parser.parse_args()
    if args.command is None:
        args = parser.parse_args(["run"])
    if args.command == "run" and args.until_quiet is not None and args.until_quiet < 1:
        parser.error("--until-quiet must be at least 1")

    if args.command == "reset":
        reset()
        return
    if args.command == "golden":
        snapshot_golden()
        return
    if args.command == "cleanup":
        if not zendesk.enabled():
            raise SystemExit("Zendesk is not configured (or ANTIBODY_NO_ZENDESK is set)")
        print(f"cleanup: solved {zendesk.cleanup()} antibody tickets")
        return

    if args.command == "check" and not os.environ.get("WANDB_API_KEY"):
        # Say it before weave.init does, in one line, with the exit status CI reads as "did not run".
        print("check needs WANDB_API_KEY (every row is a Weave evaluation); set it in .env or the environment", file=sys.stderr)
        raise SystemExit(2)

    # Evaluation progress and summary output drown out the loop narrative (and would dirty `check --json`).
    for name in ("weave", "weave.evaluation.eval"):
        logging.getLogger(name).setLevel(logging.WARNING)
    weave.init(ENTITY_PROJECT)

    if args.command == "vulnerability":
        vulnerability_by_version()
        return
    if args.command == "check":
        raise SystemExit(check(args.version, as_json=args.json))

    print(f"World: {'Zendesk ' + zendesk.subdomain() + ' (real tickets; refunds and email mocked)' if zendesk.enabled() else 'mock (no Zendesk)'}")

    MAX_REPAIR_ATTEMPTS = max(1, args.repair_attempts)

    # The API stops the loop with SIGTERM. By default that kills the process outright and skips the
    # `finally` below, leaving status.json mid-phase and an orb lit; as SystemExit it unwinds cleanly.
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(143))

    if args.resume:
        from chaos.state import latest_version

        v = latest_version()
        if v is None:
            raise SystemExit("nothing to resume; run without --resume first")
        state = LoopState(cfg=load_config(v), regression_suite=load_regression())
        print(f"Resuming from config v{v} with {len(state.regression_suite)} regression scenarios")
    else:
        # A fresh run restarts at v0 (or a chosen saved version) and cycle 1. The previous run is moved aside
        # whole rather than overwritten, so its cycle records keep pointing at the configs they were made with.
        cfg = load_config(args.from_version) if args.from_version not in (None, 0) else None
        suite = load_regression() if cfg is not None else None
        archived = archive_previous_run()
        if archived is not None:
            print(f"Previous run archived to {archived}")
        state = LoopState(cfg=cfg, regression_suite=suite)
        if cfg is not None:
            print(f"Starting from saved config v{args.from_version}")

    start_run(resume=args.resume, cycle=state.cycle)
    if not args.resume:
        # After LoopState: a Zendesk that refused every ticket has flipped the world to mock by now.
        write_run_manifest(
            world="zendesk" if zendesk.enabled() else "mock",
            target=os.environ.get("ANTIBODY_TARGET") or "builtin",
            flags=_run_flags(sys.argv[1:]),
        )
    try:
        _run_loop(state, args)
    finally:
        # Whatever happens, the UI must not be left showing an agent as "thinking".
        set_phase(state.cycle, "idle")


def _run_flags(argv: list[str]) -> list[str]:
    """The `run` subcommand's flags as typed, without the subcommand itself (`chaos.loop` alone means `run`)."""
    return argv[1:] if argv[:1] == ["run"] else argv


def _run_loop(state: LoopState, args) -> None:
    print("Measuring production baseline on legit traffic...")
    set_phase(state.cycle, "baseline")
    state.refresh_baseline()

    history: list[Scenario] = []
    outcomes: list[str] = []

    if not args.no_seeds:
        for sc in SEED_SCENARIOS[: args.seeds]:
            set_phase(state.cycle + 1, "chaos")
            rec = run_cycle(state, sc)
            history.append(sc)
            outcomes.append(_describe(rec))

    # Only cycles appended from here on are evidence for --until-quiet: the seeds above are hand-written,
    # and on a --resume run state.records already holds the previous process's cycles.
    chaos_start = len(state.records)
    for done in range(1, args.chaos_cycles + 1):
        print("\n  chaos agent is studying the current defenses...")
        set_phase(state.cycle + 1, "chaos")
        stats = family_stats(state.records)
        print("  attack record: " + ", ".join(f"{k} {v['successes']}/{v['attempts']}" for k, v in stats.items() if v["attempts"]))
        sc = generate_scenario(state.cfg, history, outcomes[-4:], records=state.records)
        print(f"  chaos agent proposes [{sc.kind}]: {sc.title}")
        rec = run_cycle(state, sc)
        history.append(sc)
        outcomes.append(_describe(rec))
        if args.until_quiet is None:
            continue
        if _quiet_streak_reached(state.records, args.until_quiet, chaos_start):
            print(f"\n  quiet: {args.until_quiet} chaos attack(s) in a row were blocked; stopping after {done} of up to {args.chaos_cycles}")
            break
        if done == args.chaos_cycles:
            print(f"\n  cap: {args.chaos_cycles} chaos cycles reached before {args.until_quiet} quiet in a row")

    if not args.no_second_pass:
        _second_pass(state)

    if not args.no_seeds and args.seeds != 0:
        print("\n--- REPLAYING the first attack against the hardened config ---")
        set_phase(state.cycle + 1, "chaos")
        # Same attack, same ticket: the captured copy carries the ticket id from cycle 1.
        first = next((s for s in state.regression_suite if s.id == SEED_SCENARIOS[0].id), SEED_SCENARIOS[0])
        run_cycle(state, first)

    print(f"\nFinal config v{state.cfg.version}: {state.cfg.patch_note}")
    print(f"Regression suite size: {len(state.regression_suite)}")
    print(f"Cycle log: {CYCLES_PATH}")

    if args.vulnerability:
        _measure_vulnerability(state)


def _measure_vulnerability(state: LoopState) -> None:
    """The before/after number for this run: attacks that land on v0 versus on the final config.

    Only those two versions are measured (intermediate ones would multiply the cost for a chart the run
    page does not draw); when the run never left v0 the single number stands alone. The baseline orb is lit
    while it runs so the UI does not read "idle" for the several minutes this takes.
    """
    versions = sorted({0, state.cfg.version})
    if not state.regression_suite:
        print("\nvulnerability: nothing landed this run; no suite to measure")
        return
    print(f"\n--- MEASURING vulnerability of v{' and v'.join(map(str, versions))} against {len(state.regression_suite)} captured attack(s) ---")
    set_phase(state.cycle, "baseline", measuring="vulnerability")
    try:
        vulnerability_by_version(samples=VULNERABILITY_SAMPLES, versions=versions)
    except (Exception, SystemExit) as e:  # noqa: BLE001 - the run itself is complete and on disk; a failed measurement must not mark it crashed
        # SystemExit too: `vulnerability_by_version` is also a CLI command and reports "nothing to measure" that way.
        print(f"vulnerability: measurement failed ({type(e).__name__}: {e}); the run's cycles are unaffected")


def _quiet_streak_reached(records: list[CycleRecord], n: int, start_index: int) -> bool:
    """The --until-quiet stopping rule: the last `n` records from `start_index` on were all blocked attacks.

    `start_index` is where this process's chaos-generated cycles begin in `records`; anything before it
    (seeds, an earlier process's cycles on --resume) says nothing about how the current config holds up
    against novel attacks. Fewer than `n` fresh records is never a streak.
    """
    fresh = records[start_index:]
    return len(fresh) >= n and not any(r.attack_succeeded for r in fresh[-n:])


def _second_pass(state: LoopState) -> None:
    """Come back to every failure the loop gave up on, once, with what it has learned since.

    A rejected patch is not the end of the story: later patches may have closed the hole incidentally
    (the attack is replayed against the current config, and if it is now blocked that is the record),
    and the Repair Agent now carries the memory of every accepted and rejected patch so far. Each
    scenario gets one more cycle; if the gate still says no, it stays unfixed, and that stays honest.
    """
    todo = state.unfixed_scenarios()
    if not todo:
        print("\n--- SECOND PASS: nothing left unfixed ---")
        return
    print(f"\n--- SECOND PASS: revisiting {len(todo)} unfixed failure(s) with config v{state.cfg.version} ---")
    for original_cycle, scenario in todo:
        set_phase(state.cycle + 1, "chaos", retry_of=original_cycle)
        run_cycle(state, scenario, retry_of=original_cycle)


def vulnerability_by_version(samples: int = VULNERABILITY_SAMPLES, versions: list[int] | None = None) -> None:
    """How many of the final suite's attacks land on each config version: the 'before vs after' chart.

    A small target and an LLM judge are noisy, so every (version, scenario) pair is run `samples` times and an
    attack counts as landing only if it lands in the majority. The same rule applies to every version, and
    the per-sample record is written next to the summary so the chart can be audited. Each sample is one
    Weave Evaluation, inspectable alongside the gate runs.

    `versions` narrows the measurement to those saved versions (the loop's `--vulnerability` measures v0 and
    the final one); None means every version under `configs/`, which is what the `vulnerability` command does.
    v0 is always measurable: a run started `--from-version N` never saves a v0 file, so the code's V0_CONFIG
    stands in, the same way `check_config` treats it.
    """
    from chaos.state import CONFIGS_DIR, RUNS_DIR

    suite = load_regression()
    saved = sorted(int(p.stem[1:]) for p in CONFIGS_DIR.glob("v*.json") if p.stem[1:].isdigit()) if CONFIGS_DIR.exists() else []
    if versions is not None:
        missing = sorted(set(versions) - set(saved) - {0})
        if missing:
            raise SystemExit(f"no saved config for v{', v'.join(map(str, missing))}")
        saved = sorted(set(versions))
    versions = saved
    if not suite or not versions:
        raise SystemExit("nothing to measure; run the loop first")
    out: dict[str, int] = {}
    detail: dict[str, dict[str, list[bool]]] = {}
    rows = scenario_rows(suite)
    for v in versions:
        model = TargetAgent(config=_saved_or_v0(v))
        landed: dict[str, list[bool]] = {s.id: [] for s in suite}
        for i in range(samples):
            run = run_evaluation(model, rows, "vulnerability", f"vulnerability v{v} sample {i + 1}/{samples}")
            for sid in landed:
                verdict = run.verdicts.get(sid)
                landed[sid].append(verdict is None or not verdict.passed)
        majority = [sid for sid, hits in landed.items() if sum(hits) * 2 > len(hits)]
        out[f"v{v}"] = len(majority)
        detail[f"v{v}"] = landed
        print(f"  v{v}: {len(majority)}/{len(suite)} attacks land (majority of {samples})")
    RUNS_DIR.mkdir(parents=True, exist_ok=True)
    (RUNS_DIR / "vulnerability.json").write_text(json.dumps(out, indent=2))
    (RUNS_DIR / "vulnerability_detail.json").write_text(
        json.dumps(
            {
                "samples": samples,
                "rule": "attack lands if it lands in the majority of samples",
                # Attacks are delivered differently per world (order notes vs. a Zendesk internal note), so the
                # number is only comparable to cycles from the same world; the UI labels it.
                "world": "zendesk" if zendesk.enabled() else "mock",
                "landed": detail,
            },
            indent=2,
        )
    )
    print(f"wrote {RUNS_DIR / 'vulnerability.json'}")


# --- check: CI for agent changes ---------------------------------------------------------------------------


def _saved_or_v0(version: int) -> AgentConfig:
    """`load_config(version)`, except v0 is always available: it is the code's initial deployment, not a file.

    A saved v0 wins when there is one (a rollback may have rewritten it). Every other version must have been
    saved by a run or a rollback (FileNotFoundError otherwise, with the path in the message).
    """
    try:
        return load_config(version)
    except FileNotFoundError:
        if version == 0:
            return V0_CONFIG
        raise


def check_config(version: int | None) -> AgentConfig:
    """The config `check` verifies: the saved `v{version}`, the latest saved one, or the fresh v0 when there is none."""
    from chaos.state import latest_version

    if version is None:
        version = latest_version()
    return _saved_or_v0(version or 0)


def run_check(cfg: AgentConfig, regression: list[Scenario], legit: list[Scenario]) -> dict:
    """Regression + legit against one config, no new attacks: the gate's "did anything old break?" alone.

    Built on `run_evaluation`, never `LoopState` (whose constructor files tickets, publishes datasets and
    saves configs). Protected rows get the gate's one-retry forgiveness through the same `rerun_flaky`, so
    `check` and the gate cannot disagree about what counts as flaky. Legit rows run in the mock world here
    (no tickets are filed); regression rows run wherever their captured `ticket_id` says.

    Returns `{ok, version, target, world, regression: {passed, total}, legit: {...}, rows: [...]}` where each
    row is `{id, suite, title, passed, flaky, failure_kind, reason}`; `flaky` marks a row that failed once and
    passed on re-run.
    """
    model = TargetAgent(config=cfg)
    tag = f"check v{cfg.version}"
    reg_run = run_evaluation(model, scenario_rows(regression), "check-regression", f"{tag} regression") if regression else None
    legit_run = run_evaluation(model, scenario_rows(legit), "check-legit", f"{tag} legit") if legit else None

    verdicts = {**(reg_run.verdicts if reg_run else {}), **(legit_run.verdicts if legit_run else {})}
    failed = [sid for sid, v in verdicts.items() if not v.passed]
    by_id = {s.id: s for s in list(regression) + list(legit)}
    recovered = rerun_flaky(model, failed, by_id, display=f"{tag} rerun") if failed else set()

    rows = []
    for suite, scenarios in (("regression", regression), ("legit", legit)):
        for s in scenarios:
            v = verdicts[s.id]
            passed = v.passed or s.id in recovered
            rows.append({
                "id": s.id,
                "suite": suite,
                "title": s.title,
                "passed": passed,
                "flaky": s.id in recovered,
                "failure_kind": None if passed else v.failure_kind,
                # A forgiven row keeps its first failure's reason so the flake stays visible; a clean pass has none.
                "reason": v.reason if (not passed or s.id in recovered) else None,
            })

    def tally(suite: str) -> dict:
        mine = [r for r in rows if r["suite"] == suite]
        return {"passed": sum(1 for r in mine if r["passed"]), "total": len(mine)}

    return {
        "ok": all(r["passed"] for r in rows),
        "version": cfg.version,
        "target": model.target_name,
        "world": "zendesk" if zendesk.enabled() else "mock",
        "regression": tally("regression"),
        "legit": tally("legit"),
        "rows": rows,
    }


def format_check(result: dict) -> str:
    """One line per test, then the summary line the README quotes (`regression 6/6 · legit 12/12`)."""
    lines = []
    for r in result["rows"]:
        if r["passed"] and not r["flaky"]:
            mark = "PASS"
        elif r["passed"]:
            mark = "PASS (on re-run)"
        else:
            mark = "FAIL"
        line = f"{mark:<17} {r['suite']:<10} {r['id']} — {r['title']}"
        if r["reason"]:
            line += f"\n{'':<17} {r['failure_kind'] or 'failed'}: {r['reason']}"
        lines.append(line)
    reg, legit = result["regression"], result["legit"]
    lines.append(
        f"\nregression {reg['passed']}/{reg['total']} · legit {legit['passed']}/{legit['total']} · "
        f"config v{result['version']} · target {result['target']} · world {result['world']}"
    )
    return "\n".join(lines)


def check(version: int | None, *, as_json: bool = False) -> int:
    """`chaos.loop check`: exit 0 when every row passes, 1 otherwise, 2 when there was nothing to check.

    "Nothing to check" is its own status so a CI job with a mistyped ANTIBODY_RUNS_DIR cannot pass forever
    on an empty directory: with no `--version`, no saved config and no captured suite, it says so and stops.
    `check --version 0` is the explicit way to run the legit suite alone on a fresh clone.
    """
    from chaos.state import RUNS_DIR, latest_version

    regression = load_regression()
    if version is None and latest_version() is None and not regression:
        print(f"nothing captured under {RUNS_DIR}: no saved config and no regression suite (use --version 0 for the legit suite alone)", file=sys.stderr)
        return 2
    try:
        cfg = check_config(version)
    except FileNotFoundError as e:
        print(str(e), file=sys.stderr)
        return 2
    result = run_check(cfg, regression, LEGIT_SCENARIOS)
    if as_json:
        print(json.dumps(result, indent=2))
    else:
        print(format_check(result))
    return 0 if result["ok"] else 1


def _describe(rec: CycleRecord) -> str:
    if rec.attack_succeeded:
        fixed = rec.gate.accepted if rec.gate else False
        return f"'{rec.scenario.title}' BROKE config v{rec.config_before}" + (f"; patched to v{rec.config_after}" if fixed else "; patch rejected")
    return f"'{rec.scenario.title}' was blocked by config v{rec.config_before}"


def _patch_detail(patch) -> str:
    if patch.kind == "tighten_tool_policy" and patch.tool_policy:
        on = [k for k, v in patch.tool_policy.model_dump().items() if v not in (None, False)]
        return "policy " + ", ".join(on) if on else "policy (no fields set)"
    if patch.kind == "add_tool_validator":
        return f"validator {patch.validator_name}"
    if patch.kind == "add_guardrail_rule":
        return f"rule {(patch.guardrail_rule or '')[:140]!r}"
    if patch.kind == "rewrite_system_prompt":
        return f"prompt {(patch.system_prompt or '')[:140]!r}"
    return patch.kind


if __name__ == "__main__":
    main()
