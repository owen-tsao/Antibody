"""Spawn, watch and stop the self-healing loop as a subprocess of the API.

The API never runs the loop in-process: the loop calls `weave.init` and holds tracing state,
and it can run for minutes. It is started exactly the way the CLI is used by hand:

    PYTHONUNBUFFERED=1 uv run python -m chaos.loop run --chaos-cycles N

`uv run` is the repo's canonical invocation (PLAN.md, docs/FRONTEND.md §3, the golden-run terminal);
when `uv` is not on the API process's PATH we fall back to `sys.executable -m chaos.loop`, which
is the same interpreter when uvicorn itself was started with `uv run`. Output goes to
`runs/loop.log` (append), cwd is the repo root, and the child gets its own session so
`stop()` can SIGTERM the whole process group without touching uvicorn.

Only one loop at a time. The handle lives in module state, so a uvicorn `--reload` restart
forgets a still-running child (it keeps running). Loops we did not spawn — a terminal-started run,
or our own child after a reload — are found with `pgrep -f "chaos.loop run"` and reported as
`running: true, external: true`. `start()` refuses while one exists; `stop()` refuses to kill a
process it does not own. The pattern only matches the documented `python -m chaos.loop run`
invocation; a loop started as `python chaos/loop.py run` is invisible to it.

Only loops running *in this checkout* count. pgrep matches every `chaos.loop run` on the machine,
including one in a second clone (e.g. a test copy under /tmp) that writes to its own runs/ and has
nothing to do with what this API serves. So each candidate's working directory is read with one
`lsof -a -p PID,PID -d cwd -Fn` call and compared, symlinks resolved, to the repo root (`ROOT`).
Nothing is cached: `state()` runs on a 1–2 s poll and costs one pgrep plus at most one lsof
(~10 ms each on macOS). When `lsof` is not installed the cwd filter is skipped and any matching
process counts, as before.

Testing without spending tokens: set `ANTIBODY_LOOP_CMD` in the uvicorn environment to a
shell-style command string (e.g. `ANTIBODY_LOOP_CMD="sleep 30"`) and the API spawns that
instead of the loop. The 409 / stop / log paths behave identically.

Test-only override: `ANTIBODY_IGNORE_EXTERNAL_LOOP=1` disables the pgrep fallback, so a scratch
API on another port does not see (and is not blocked by) a real run started elsewhere. It only
affects loops this process did not spawn; never set it on the demo server, where the whole point of
the fallback is to refuse a second loop.
"""

from __future__ import annotations

import os
import shlex
import shutil
import signal
import subprocess
import sys
import threading
from collections import deque
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Literal

from chaos.state import ROOT, RUNS_DIR

LOG_PATH = RUNS_DIR / "loop.log"

Mode = Literal["fixed", "until_quiet"]


def ignore_external() -> bool:
    return os.environ.get("ANTIBODY_IGNORE_EXTERNAL_LOOP") == "1"


@dataclass
class LoopHandle:
    proc: subprocess.Popen
    started_at: str
    mode: Mode
    chaos_cycles: int

    def running(self) -> bool:
        return self.proc.poll() is None

    def snapshot(self) -> dict:
        return {
            "running": self.running(),
            "pid": self.proc.pid,
            "started_at": self.started_at,
            "exit_code": self.proc.returncode,
            "mode": self.mode,
            "chaos_cycles": self.chaos_cycles,
            "external": False,
        }


_handle: LoopHandle | None = None
# FastAPI runs sync routes on a threadpool, so two Start clicks can race the is_running() check.
_start_lock = threading.Lock()

IDLE = {
    "running": False,
    "pid": None,
    "started_at": None,
    "exit_code": None,
    "mode": None,
    "chaos_cycles": None,
    "external": False,
}

# Anchored on the interpreter flag so an `rg "chaos.loop run"` or an editor grep in this checkout is
# not mistaken for a running loop (which would 409 Heal and Replay for as long as it lived).
LOOP_PATTERN = r"[Pp]ython[0-9.]* -m chaos\.loop run"
# Wrappers that also carry the pattern on their command line (the `uv run` launcher, the shell
# that started it, pgrep itself). The loop is the python process underneath.
_WRAPPER_NAMES = {"uv", "zsh", "bash", "sh", "pgrep", "-zsh", "-bash"}


def _cwd_of(pids: list[int]) -> dict[int, str] | None:
    """{pid: cwd} for the given pids via one lsof call; None when lsof is unavailable or failed.

    `-Fn` output is one field per line: `p<pid>` opens a process block, `n<path>` is the cwd.
    lsof exits 1 when any listed pid has already gone, so the exit code is ignored.
    """
    if not pids or not shutil.which("lsof"):
        return None
    try:
        out = subprocess.run(
            ["lsof", "-a", "-p", ",".join(str(p) for p in pids), "-d", "cwd", "-Fn"],
            capture_output=True,
            text=True,
            timeout=2,
            check=False,
        ).stdout
    except (OSError, subprocess.TimeoutExpired):
        return None
    cwds: dict[int, str] = {}
    pid: int | None = None
    for line in out.splitlines():
        if line.startswith("p") and line[1:].isdigit():
            pid = int(line[1:])
        elif line.startswith("n") and pid is not None:
            cwds[pid] = line[1:]
    return cwds


def _in_this_repo(pids: list[int]) -> list[int]:
    """The pids whose working directory is this checkout. Without lsof, all of them (old behaviour)."""
    cwds = _cwd_of(pids)
    if cwds is None:
        return pids
    root = os.path.realpath(ROOT)
    return [p for p in pids if p in cwds and os.path.realpath(cwds[p]) == root]


def external_pid() -> int | None:
    """PID of a `python -m chaos.loop run` in this checkout that we did not spawn, or None."""
    if ignore_external():
        return None
    try:
        out = subprocess.run(
            ["pgrep", "-fl", LOOP_PATTERN], capture_output=True, text=True, timeout=2, check=False
        ).stdout
    except (OSError, subprocess.TimeoutExpired):
        return None
    candidates: list[int] = []
    for line in out.splitlines():
        pid_s, _, cmd = line.strip().partition(" ")
        if not pid_s.isdigit():
            continue
        argv0 = os.path.basename(cmd.split(" ", 1)[0]) if cmd else ""
        if argv0.lower() in _WRAPPER_NAMES:
            continue
        candidates.append(int(pid_s))
    ours = _in_this_repo(candidates)
    return ours[0] if ours else None


def state() -> dict:
    if _handle is not None and _handle.running():
        return _handle.snapshot()
    pid = external_pid()
    if pid is not None:
        return {**IDLE, "running": True, "pid": pid, "external": True}
    return _handle.snapshot() if _handle is not None else dict(IDLE)


def is_running() -> bool:
    return state()["running"]


def _command(chaos_cycles: int) -> list[str]:
    override = os.environ.get("ANTIBODY_LOOP_CMD")
    if override:
        return shlex.split(override)
    tail = ["-m", "chaos.loop", "run", "--chaos-cycles", str(chaos_cycles)]
    if shutil.which("uv"):
        return ["uv", "run", "python", *tail]
    return [sys.executable, *tail]


def start(mode: Mode, chaos_cycles: int) -> dict:
    """Spawn the loop. Raises RuntimeError("running") if one we started is still alive."""
    global _handle
    if mode != "fixed":
        raise ValueError(mode)
    with _start_lock:
        if is_running():
            raise RuntimeError("running")

        RUNS_DIR.mkdir(parents=True, exist_ok=True)
        env = {**os.environ, "PYTHONUNBUFFERED": "1"}
        with LOG_PATH.open("ab") as log:
            proc = subprocess.Popen(
                _command(chaos_cycles),
                cwd=ROOT,
                env=env,
                stdout=log,
                stderr=subprocess.STDOUT,
                stdin=subprocess.DEVNULL,
                start_new_session=True,
            )
        _handle = LoopHandle(
            proc=proc,
            started_at=datetime.now(timezone.utc).isoformat(),
            mode=mode,
            chaos_cycles=chaos_cycles,
        )
    return {
        "pid": proc.pid,
        "started_at": _handle.started_at,
        "mode": mode,
        "chaos_cycles": chaos_cycles,
    }


def _killpg(pid: int, sig: int) -> None:
    """Signal the child's process group; a child that already exited is not an error."""
    try:
        os.killpg(os.getpgid(pid), sig)
    except ProcessLookupError:
        pass


def stop() -> dict:
    """SIGTERM the loop's process group.

    Raises PermissionError for a loop this API did not spawn (never kill someone else's process)
    and LookupError if nothing is running.
    """
    if _handle is None or not _handle.running():
        if external_pid() is not None:
            raise PermissionError("external")
        raise LookupError("not running")
    _killpg(_handle.proc.pid, signal.SIGTERM)
    try:
        _handle.proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        _killpg(_handle.proc.pid, signal.SIGKILL)
        _handle.proc.wait(timeout=5)
    return _handle.snapshot()


def log_tail(n: int) -> list[str]:
    if not LOG_PATH.exists():
        return []
    with LOG_PATH.open("r", errors="replace") as f:
        return list(deque(f, maxlen=n))
