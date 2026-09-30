"""Spawn, watch and stop the bundled example agents (`examples/agents/*/agent.py`).

The onboarding path should never need a terminal: the connect screen offers "start the example agent for
me", and this module is what that button does. It is `api.loop_ctl` in miniature — one child per example,
started the way each README says (`uv run python agent.py` from the example's own folder, so its own venv
syncs on first use), in its own process group so `stop()` can signal the whole thing, output appended to
`runs/example_agent<suffix>.log`.

Two examples (`EXAMPLES`): `support`, the stock OpenAI Agents SDK agent on 8790 that speaks the retail world, and
`airline`, OpenAI's customer-service airline demo on 8792 whose real tools live on a second port (8793) — the
`tools_backend` the loop forwards to — and whose world is the `airline` pack. Each is a row in `GET /api/agents`.

`running` is not "our child is alive" but "the port answers `GET /tools`": the first start runs `uv sync`
and can take a minute, during which the process exists and the port does not; and an agent started by
hand from a shell is just as running as one we spawned. `start()` therefore refuses (409) whenever the port
is bound, whoever bound it, and `stop()` only ever signals a process this module spawned or left a pid
file for. The pid file (`runs/example_agent<suffix>.pid`) is how a restarted API still owns the child; it is
removed when the child is stopped or seen dead. A pid read from the file is trusted only if it still looks
like our child — a session leader (we spawn with `start_new_session=True`) whose command line names
`agent.py` — because after a reboot the same number can belong to anything.

The agents need `WANDB_API_KEY` (they call inference); the route answers 503 without one, like every other
route that would spawn work destined to fail.
"""

from __future__ import annotations

import os
import shutil
import signal
import subprocess
import sys
import threading
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from api import loop_ctl
from chaos import state
from chaos.state import ROOT
from chaos.target import get_json

EXAMPLES_DIR = ROOT / "examples" / "agents"
# A readiness probe on a 1–2 s poll must be cheap; both agents answer /tools without a model call.
PROBE_TIMEOUT_S = 1.0


@dataclass(frozen=True)
class Example:
    """One bundled agent: where its code is, which ports it takes, which world it speaks."""

    name: str
    title: str
    folder: str
    port: int
    tools_port: int | None = None
    domain: str | None = None

    @property
    def row_id(self) -> str:
        # The first example was `example` before there was a second; its id stays so saved runs and the UI keep working.
        return "example" if self.name == "support" else f"example-{self.name}"

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    @property
    def tools_backend(self) -> str | None:
        return f"http://127.0.0.1:{self.tools_port}" if self.tools_port else None

    @property
    def dir(self) -> Path:
        return EXAMPLES_DIR / self.folder

    def _file(self, ext: str) -> Path:
        suffix = "" if self.name == "support" else f"-{self.name}"
        return state.RUNS_DIR / f"example_agent{suffix}.{ext}"

    @property
    def log_path(self) -> Path:
        return self._file("log")

    @property
    def pid_path(self) -> Path:
        return self._file("pid")

    def env(self) -> dict[str, str]:
        out = {"AGENT_PORT": str(self.port)}
        if self.tools_port:
            out["TOOLS_PORT"] = str(self.tools_port)
        return out


EXAMPLES: dict[str, Example] = {
    "support": Example("support", "Northwind Support (Agents SDK)", "openai_agents_support", 8790),
    "airline": Example("airline", "Skyward Air Support (Agents SDK)", "openai_cs_airline", 8792, tools_port=8793, domain="airline"),
}
DEFAULT = "support"

_lock = threading.Lock()
_procs: dict[str, subprocess.Popen] = {}


class PortBusy(Exception):
    """Something already answers on the agent's port; starting a second one would fail to bind."""


def example(name: str | None) -> Example:
    """The example by name (`None` = the original `support`); `KeyError` names the valid ones."""
    try:
        return EXAMPLES[name or DEFAULT]
    except KeyError:
        raise KeyError(f"unknown example {name!r}: one of {', '.join(EXAMPLES)}") from None


def by_row_id(row_id: str) -> Example | None:
    return next((e for e in EXAMPLES.values() if e.row_id == row_id), None)


def port_answers(ex: Example) -> bool:
    """True when `GET /tools` on the example's port returns a list. That is the one definition of `running`."""
    try:
        return isinstance(get_json(f"{ex.url}/tools", PROBE_TIMEOUT_S), list)
    except Exception:  # noqa: BLE001 - refused, timed out, not JSON: all mean "not up"
        return False


def _read_pid(ex: Example) -> int | None:
    try:
        return int(ex.pid_path.read_text().strip())
    except (OSError, ValueError):
        return None


def _alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        # Alive, but not ours to signal: treated as "not our child" so we never try to.
        return False
    return True


def _looks_like_our_child(pid: int) -> bool:
    """A pid from the file is ours only if it leads its own session and its command line names `agent.py`.

    `start_new_session=True` makes our child the session (and group) leader, so `getpgid(pid) == pid`;
    the command-line check catches a recycled pid after a reboot. One `ps` call, like `loop_ctl._cwd_of`.
    """
    try:
        if os.getpgid(pid) != pid:
            return False
        out = subprocess.run(["ps", "-o", "command=", "-p", str(pid)], capture_output=True, text=True, timeout=2, check=False).stdout
    except (ProcessLookupError, PermissionError, OSError, subprocess.TimeoutExpired):
        return False
    return "agent.py" in out


def _owned_pid(ex: Example) -> int | None:
    """The pid of a child this API (or a previous instance of it) spawned for `ex` and has not seen exit."""
    proc = _procs.get(ex.name)
    if proc is not None:
        if proc.poll() is None:
            return proc.pid
        return None
    pid = _read_pid(ex)
    if pid is not None and _alive(pid) and _looks_like_our_child(pid):
        return pid
    if pid is not None:
        ex.pid_path.unlink(missing_ok=True)
    return None


def _command() -> list[str]:
    # Same fallback as loop_ctl: without `uv` the example's own venv cannot be synced, so the API's
    # interpreter runs it and the example's dependencies had better be importable there.
    if shutil.which("uv"):
        return ["uv", "run", "python", "agent.py"]
    return [sys.executable, "agent.py"]


def state_of(ex: Example) -> dict:
    """`{running, url, pid, starting}`: `running` is the port answering; `starting` is a spawned child with no port yet."""
    pid = _owned_pid(ex)
    running = port_answers(ex)
    return {"running": running, "url": ex.url, "pid": pid, "starting": pid is not None and not running}


def start(ex: Example) -> dict:
    """Spawn the example. Raises PortBusy when its port already answers or a child of ours is still starting."""
    with _lock:
        if port_answers(ex) or _owned_pid(ex) is not None:
            raise PortBusy(f"something is already listening on {ex.url}")
        state.RUNS_DIR.mkdir(parents=True, exist_ok=True)
        cmd = _command()
        env = {**os.environ, "PYTHONUNBUFFERED": "1", **ex.env()}
        started_at = datetime.now(timezone.utc).isoformat()
        with ex.log_path.open("ab") as log:
            log.write(f"$ (cd {ex.dir.relative_to(ROOT)} && {' '.join(cmd)})\n".encode())
            log.flush()
            proc = subprocess.Popen(
                cmd,
                cwd=ex.dir,
                env=env,
                stdout=log,
                stderr=subprocess.STDOUT,
                stdin=subprocess.DEVNULL,
                start_new_session=True,
            )
        _procs[ex.name] = proc
        ex.pid_path.write_text(str(proc.pid))
    return {"pid": proc.pid, "started_at": started_at, "url": ex.url, "running": False, "starting": True, "example": ex.name}


def stop(ex: Example) -> dict:
    """SIGTERM the child we spawned (SIGKILL after 5 s). LookupError when we own no running one.

    An agent on the port that we did not start is left alone: `running` stays true and the caller is told
    it is not ours (`owned: false`) rather than seeing a stranger's process killed.
    """
    with _lock:
        pid = _owned_pid(ex)
        if pid is None:
            if port_answers(ex):
                return {**state_of(ex), "stopped": False, "owned": False}
            raise LookupError(f"the {ex.name} example agent is not running")
        loop_ctl._killpg(pid, signal.SIGTERM)
        proc = _procs.get(ex.name)
        if proc is not None:
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                loop_ctl._killpg(pid, signal.SIGKILL)
                proc.wait(timeout=5)
        else:
            # A child from a previous API process: not ours to wait() on, so poll it instead.
            for _ in range(50):
                if not _alive(pid):
                    break
                threading.Event().wait(0.1)
            else:
                loop_ctl._killpg(pid, signal.SIGKILL)
        _procs.pop(ex.name, None)
        ex.pid_path.unlink(missing_ok=True)
    return {**state_of(ex), "stopped": True, "owned": True}


def log_tail(ex: Example, n: int) -> list[str]:
    return loop_ctl.tail_lines(ex.log_path, n)
