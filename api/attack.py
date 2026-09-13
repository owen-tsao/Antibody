"""`POST /api/attack`: run one seed scenario against one config version, in-process, as a preview.

This is the Results page's "Run seed attack against v0" / "Same attack against vN" button
(docs/FRONTEND.md §3, §4.3). It reuses the loop's own target + judge (`chaos.target_agent.run_target_agent`,
`chaos.judge.judge_episode`) so the preview is the same code path as a real cycle, but it is not a
cycle: nothing is appended to `cycles.jsonl`, nothing under `runs/` is touched, no Zendesk ticket is
filed (seed scenarios carry no `ticket_id`, so the target takes the mock path).

Weave is initialised lazily on the first attack rather than at import, so `uvicorn --reload` stays fast
and importing `api.main` has no side effects. To keep `weave.init`'s network round-trip (which can hang
on bad Wi-Fi) off the demo's critical path, `api.main` warms it from a daemon thread at startup via
`warm_weave()`; a failure there is logged once and the first attack simply retries. Set
`ANTIBODY_NO_WEAVE=1` to skip tracing entirely (the attack runs untraced). The loop subprocess has its
own `weave.init`; the two never share memory (docs/FRONTEND.md §8).

One attack at a time: the target harness keeps per-thread fault state, and the demo only ever presses
one button at a time. A second concurrent request gets 409 instead of queueing behind the first.
"""

from __future__ import annotations

import logging
import os
import threading
import time
from concurrent.futures import Future, ThreadPoolExecutor
from concurrent.futures import TimeoutError as FutureTimeout

from api import store
from chaos.config import ENTITY_PROJECT
from chaos.schemas import AgentConfig, Scenario

log = logging.getLogger("api.attack")

# Wall-clock budget for target + judge. The target makes up to 6 model calls and the judge up to 2;
# on the shared inference endpoint that is normally 10–30 s. Past this the UI shows a labeled replay.
TIMEOUT_S = 40.0

_weave_ready = False
_weave_lock = threading.Lock()
_attack_lock = threading.Lock()
# Single worker so a timed-out attack keeps running to completion in the background (threads
# cannot be killed) without ever overlapping the next one.
_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="attack")


class AttackBusy(Exception):
    """Another attack is still running (including one whose request already timed out)."""


class AttackTimeout(Exception):
    """Target + judge did not finish within TIMEOUT_S; the work continues in the background."""


class AttackFailed(Exception):
    """The attack raised instead of returning a verdict; `str(exc)` is safe to show the client."""


def tracing_disabled() -> bool:
    return bool(os.environ.get("ANTIBODY_NO_WEAVE"))


def missing_api_key() -> bool:
    """`chaos.config.get_client` raises SystemExit without this; check up front so the route can 503."""
    return not os.environ.get("WANDB_API_KEY")


def _ensure_weave() -> None:
    global _weave_ready
    if _weave_ready or tracing_disabled():
        return
    with _weave_lock:
        if _weave_ready:
            return
        import weave

        weave.init(ENTITY_PROJECT)
        for name in ("weave", "weave.evaluation.eval"):
            logging.getLogger(name).setLevel(logging.WARNING)
        _weave_ready = True


def warm_weave() -> None:
    """Start `weave.init` in the background. Never blocks, never raises."""
    if tracing_disabled():
        log.info("ANTIBODY_NO_WEAVE set; attacks run untraced")
        return

    def _go() -> None:
        try:
            _ensure_weave()
        except BaseException as e:  # noqa: BLE001 - a warm-up failure must never take the API down
            log.warning("weave warm-up failed (%s: %s); the first attack will retry", type(e).__name__, e)

    threading.Thread(target=_go, name="weave-warmup", daemon=True).start()


def find_scenario(scenario_id: str) -> Scenario | None:
    from chaos.scenarios import SEED_SCENARIOS

    return next((s for s in SEED_SCENARIOS if s.id == scenario_id), None)


def find_config(version: int) -> AgentConfig | None:
    """`runs/configs/v{n}.json`, falling back to the golden configs like every other read route."""
    return store.read_config(store.resolve_source("live"), version)


def _run(cfg: AgentConfig, scenario: Scenario) -> dict:
    try:
        # Imported inside the guarded block: if either import ever fails, the lock below still gets
        # released instead of every later attack answering 409 until the server restarts.
        from chaos.judge import judge_episode
        from chaos.target_agent import run_target_agent

        _ensure_weave()
        t0 = time.monotonic()
        episode = run_target_agent(cfg, scenario)
        verdict = judge_episode(scenario, episode)
        duration = time.monotonic() - t0
        return {
            "scenario_id": scenario.id,
            "scenario_title": scenario.title,
            "version": cfg.version,
            "episode": {
                "tool_calls": [
                    {
                        "tool": tc.tool,
                        "args": tc.args,
                        "blocked_by_policy": tc.blocked_by_policy,
                        "blocked_by": tc.blocked_by,
                    }
                    for tc in episode.tool_calls
                ],
                "final_reply": episode.final_reply,
                "error": episode.error,
            },
            "verdict": verdict.model_dump(),
            "duration_s": round(duration, 2),
        }
    finally:
        _attack_lock.release()


def run(cfg: AgentConfig, scenario: Scenario) -> dict:
    """Run target + judge with a wall-clock budget. Raises AttackBusy, AttackTimeout or AttackFailed."""
    if not _attack_lock.acquire(blocking=False):
        raise AttackBusy()
    try:
        future: Future[dict] = _executor.submit(_run, cfg, scenario)
    except BaseException:
        _attack_lock.release()
        raise
    try:
        return future.result(timeout=TIMEOUT_S)
    except FutureTimeout:
        raise AttackTimeout() from None
    except BaseException as e:  # noqa: BLE001
        # SystemExit (chaos.config.get_client with no key) is not an Exception; re-raised from the
        # worker it would bypass FastAPI's handler and drop the connection. Turn it into a 500.
        log.exception("attack failed")
        raise AttackFailed(f"{type(e).__name__}: {e}"[:300]) from e


def is_running() -> bool:
    return _attack_lock.locked()
