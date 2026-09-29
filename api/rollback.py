"""Roll the live agent config back to a version from a past run (docs/plans/02, B1).

`rollback(run, version)` copies `<run>/configs/v{version}.json` in as the *next* live version — a copy,
not a pointer move. `GET /api/configs` afterwards shows `v6 (rollback to run X v2)`, never a v2 that
quietly replaced something; the lineage stays readable and `chaos.loop run --resume` (which starts
from `latest_version()`) picks the rolled-back config up as its starting point.

The regression suite goes with it, merged by scenario id: every attack the rolled-back run captured
joins the live suite, and every attack the live suite already had stays (live wins on an id clash).
Copying the old suite over the live one would silently forget tests, and dropping the old suite would
forget what this config was hardened against. The merged suite may hold attacks this config never
saw; `newer_tests` counts them so the UI can say "N tests are newer than this config" and `check`
reports them honestly.

This is the API's one write into `runs/configs`; `runs/regression.json` is also written by `api.incidents`
(an imported transcript) and, later, by the tools panel's starter rules. Every such writer refuses while a loop
is running (the loop owns those files then); rollback also refuses when the run was made against another
target than the current `ANTIBODY_TARGET` (a config tuned for an external agent means nothing to the built-in one).
Never touches history/.

Concurrency: the running-check, the version pick and both writes happen under `loop_ctl.runs_lock`,
the same lock `loop_ctl.start` takes, so a rollback can neither interleave with a starting loop nor
with a second rollback. The config file is created exclusively as a belt to that brace: if a version
somehow exists already, the write fails and the client gets a 409 asking to retry rather than a
silently replaced file.
"""

from __future__ import annotations

from api import loop_ctl, store
from chaos import state
from chaos.schemas import AgentConfig, Scenario
from chaos.target import resolve_target, target_name


class RollbackRefused(Exception):
    """A conflict the client can fix by waiting or choosing another run (HTTP 409)."""


def current_target() -> str:
    """What the loop would record as `target` if it started now, canonical (chaos.loop reads the same variable)."""
    return target_name()


def same_target(recorded: str, current: str) -> bool:
    """Whether a run's stored `target` (verbatim, e.g. the README's bare URL) names the same agent as `current`.

    Both sides are normalised through `resolve_target`; a stored string that resolves to nothing matches nothing.
    """
    try:
        return resolve_target(recorded).name == resolve_target(current).name
    except ValueError:
        return False


def merge_suites(live: list[Scenario], incoming: list[Scenario]) -> tuple[list[Scenario], int]:
    """Union by `Scenario.id`, live entries first and winning on conflict.

    Returns the merged suite and `newer_tests`: how many merged scenarios the incoming suite does not
    have — tests the incoming run's config was never gated against.
    """
    seen = {s.id for s in live}
    merged = [*live, *(s for s in incoming if s.id not in seen)]
    incoming_ids = {s.id for s in incoming}
    newer = sum(1 for s in merged if s.id not in incoming_ids)
    return merged, newer


def rollback(run: str, version: int) -> dict:
    """Copy `run`'s `v{version}` in as the next live config and merge its suite into the live one.

    `run` is a runs-list id: a history folder name or `golden`. Raises ValueError for `live` or a
    malformed name (400), LookupError for an unknown run or version (404), RollbackRefused while a
    loop runs, across targets, when the live suite is unreadable, or when the version slot was taken
    between pick and write (409). Returns `{config, newer_tests}`.
    """
    if run == "live":
        raise ValueError("cannot roll back to the live run: start it with --from-version instead")
    source = store.parse_source(run if run == "golden" else f"{store.RUN_PREFIX}{run}")
    with loop_ctl.runs_lock:
        if loop_ctl.state()["running"]:
            raise RollbackRefused("a loop is running and owns the live config; stop it first")
        manifest = store.run_manifest(source)
        # A folder with no manifest at all is an empty run; a legacy one without run.json reads as builtin.
        target = manifest["target"] if manifest else "builtin"
        if not same_target(target, current_target()):
            raise RollbackRefused(
                f"run {run} was made against target {target!r}; this install targets {current_target()!r}"
            )
        cfg = store.read_config(source, version)
        if cfg is None:
            raise LookupError(f"run {run} has no config v{version}")
        # A torn or hand-edited live suite must not be read as "empty": merging into [] would drop
        # every live test on the floor. Refuse and say what to fix.
        try:
            live_suite = state.load_regression()
        except (ValueError, TypeError) as e:
            raise RollbackRefused(f"live regression.json is unreadable ({e}); fix or remove it first")

        previous = state.latest_version()
        # An empty runs/ has no v0 to build on, so the copy becomes v0: the first saved config of the live run.
        new = AgentConfig(
            **{
                **cfg.model_dump(),
                "version": previous + 1 if previous is not None else 0,
                "parent_version": previous,
                "patch_note": f"rollback to run {run} v{version}",
            }
        )
        merged, newer = merge_suites(live_suite, store.read_regression(source))
        try:
            state.save_config(new, exclusive=True)
        except FileExistsError:
            raise RollbackRefused(f"version v{new.version} already exists; retry")
        state.save_regression(merged)
    return {"config": new.model_dump(), "newer_tests": newer}
