"""Spawn, watch and stop the example external agent (`examples/agents/openai_agents_support/agent.py`).

The onboarding path should never need a terminal: the connect screen offers "start the example agent for
me", and this module is what that button does. It is `api.loop_ctl` in miniature — one child at a time,
started the way the README says (`uv run python agent.py` from the example's own folder, so its own venv
syncs on first use), in its own process group so `stop()` can signal the whole thing, output appended to
`runs/example_agent.log`.

`running` is not "our child is alive" but "port 8790 answers `GET /tools`": the first start runs `uv sync`
and can take a minute, during which the process exists and the port does not; and an agent started by
hand from a shell is just as running as one we spawned. `start()` therefore refuses (409) whenever the port
is bound, whoever bound it, and `stop()` only ever signals a process this module spawned or left a pid
file for. The pid file (`runs/example_agent.pid`) is how a restarted API still owns the child; it is
removed when the child is stopped or seen dead.

The agent needs `WANDB_API_KEY` (it calls inference); the route answers 503 without one, like every other
route that would spawn work destined to fail.
"""

from __future__ import annotations

import os
import shutil
import signal
import subprocess
import sys
import threading
from datetime import datetime, timezone

from chaos.state import ROOT, RUNS_DIR
from chaos.target import get_json

AGENT_DIR = ROOT / "examples" / "agents" / "openai_agents_support"
PORT = 8790
URL = f"http://127.0.0.1:{PORT}"
LOG_PATH = RUNS_DIR / "example_agent.log"
PID_PATH = RUNS_DIR / "example_agent.pid"
# A readiness probe on a 1–2 s poll must be cheap; the agent answers /tools without a model call.
PROBE_TIMEOUT_S = 1.0

_lock = threading.Lock()
_proc: subprocess.Popen | None = None


class PortBusy(Exception):
    """Something already answers on the agent's port; starting a second one would fail to bind."""


def port_answers() -> bool:
    """True when `GET /tools` on the agent's port returns a list. That is the one definition of `running`."""
    try:
        return isinstance(get_json(f"{URL}/tools", PROBE_TIMEOUT_S), list)
    except Exception:  # noqa: BLE001 - refused, timed out, not JSON: all mean "not up"
        return False


def _read_pid() -> int | None:
    try:
        return int(PID_PATH.read_text().strip())
    except (OSError, ValueError):
        return None


def _alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def _owned_pid() -> int | None:
    """The pid of a child this API (or a previous instance of it) spawned and has not seen exit."""
    if _proc is not None:
        if _proc.poll() is None:
            return _proc.pid
        return None
    pid = _read_pid()
    if pid is not None and _alive(pid):
        return pid
    if pid is not None:
        PID_PATH.unlink(missing_ok=True)
    return None


def _command() -> list[str]:
    # Same fallback as loop_ctl: without `uv` the example's own venv cannot be synced, so the API's
    # interpreter runs it and the example's dependencies had better be importable there.
    if shutil.which("uv"):
        return ["uv", "run", "python", "agent.py"]
    return [sys.executable, "agent.py"]


def state() -> dict:
    """`{running, url, pid, starting}`: `running` is the port answering; `starting` is a spawned child with no port yet."""
    pid = _owned_pid()
    running = port_answers()
    return {"running": running, "url": URL, "pid": pid, "starting": pid is not None and not running}


def start() -> dict:
    """Spawn the example agent. Raises PortBusy when 8790 already answers or a child of ours is still starting."""
    global _proc
    with _lock:
        if port_answers() or _owned_pid() is not None:
            raise PortBusy(f"something is already listening on {URL}")
        RUNS_DIR.mkdir(parents=True, exist_ok=True)
        cmd = _command()
        env = {**os.environ, "PYTHONUNBUFFERED": "1", "AGENT_PORT": str(PORT)}
        started_at = datetime.now(timezone.utc).isoformat()
        with LOG_PATH.open("ab") as log:
            log.write(f"$ (cd {AGENT_DIR.relative_to(ROOT)} && {' '.join(cmd)})\n".encode())
            log.flush()
            _proc = subprocess.Popen(
                cmd,
                cwd=AGENT_DIR,
                env=env,
                stdout=log,
                stderr=subprocess.STDOUT,
                stdin=subprocess.DEVNULL,
                start_new_session=True,
            )
        PID_PATH.write_text(str(_proc.pid))
    return {"pid": _proc.pid, "started_at": started_at, "url": URL, "running": False, "starting": True}


def _killpg(pid: int, sig: int) -> None:
    try:
        os.killpg(os.getpgid(pid), sig)
    except ProcessLookupError:
        pass


def stop() -> dict:
    """SIGTERM the agent we spawned (SIGKILL after 5 s). LookupError when we own no running agent.

    An agent on 8790 that we did not start is left alone: `running` stays true and the caller is told
    it is not ours (`owned: false`) rather than seeing a stranger's process killed.
    """
    global _proc
    with _lock:
        pid = _owned_pid()
        if pid is None:
            if port_answers():
                return {**state(), "stopped": False, "owned": False}
            raise LookupError("the example agent is not running")
        _killpg(pid, signal.SIGTERM)
        if _proc is not None:
            try:
                _proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                _killpg(pid, signal.SIGKILL)
                _proc.wait(timeout=5)
        else:
            # A child from a previous API process: not ours to wait() on, so poll it instead.
            for _ in range(50):
                if not _alive(pid):
                    break
                threading.Event().wait(0.1)
            else:
                _killpg(pid, signal.SIGKILL)
        _proc = None
        PID_PATH.unlink(missing_ok=True)
    return {**state(), "stopped": True, "owned": True}


def log_tail(n: int) -> list[str]:
    from collections import deque

    if not LOG_PATH.exists():
        return []
    with LOG_PATH.open("r", errors="replace") as f:
        return list(deque(f, maxlen=n))
