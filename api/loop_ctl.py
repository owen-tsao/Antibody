"""Spawn, watch and stop the self-healing loop as a subprocess of the API.

The API never runs the loop in-process: the loop calls `weave.init` and holds tracing state,
and it can run for minutes. It is started exactly the way the CLI is used by hand:

    PYTHONUNBUFFERED=1 uv run python -m chaos.loop run --chaos-cycles 3 --repair-attempts 3 [...]

`LoopStartBody` is the settings contract (docs/plans/02, A1): every field is one `chaos.loop run`
flag, so the UI cannot offer a knob the loop does not have; `world: "mock"` becomes
`ANTIBODY_NO_ZENDESK=1` in the child's environment only. `start()` writes the exact command to
`runs/loop.log` as a `$ ...` line, env overrides first, so the log reads like a terminal session and
the line can be pasted back into one. `last_settings()` parses that line back out, which is how
`GET /api/loop` still reports the settings of the last run after the API itself has restarted.

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
instead of the loop. The 409 / stop / log paths behave identically; `settings` is null because the
`$` line is not a loop command.

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

from pydantic import BaseModel, Field

from chaos.state import ROOT, RUNS_DIR

LOG_PATH = RUNS_DIR / "loop.log"

World = Literal["auto", "mock"]


class LoopStartBody(BaseModel):
    """Run settings: the body of POST /api/loop/start and, as defaults, part of GET /api/manifest.

    Every field is one `chaos.loop run` flag (see `_flags`); no flag, no field. `target` is deliberately
    absent: which agent the loop attacks is an environment decision (plan 01) the UI shows read-only.
    Unknown keys are ignored rather than rejected, so a UI still sending the retired `mode` works.
    """

    chaos_cycles: int = Field(3, ge=0, le=10)
    # None = all seeds; 0 = `--no-seeds`.
    seeds: int | None = Field(None, ge=0, le=10)
    repair_attempts: int = Field(3, ge=1, le=5)
    second_pass: bool = True
    resume: bool = False
    # Stop once N consecutive chaos-generated attacks were blocked; `chaos_cycles` becomes the cap.
    until_quiet: int | None = Field(None, ge=1, le=10)
    world: World = "auto"

    def nothing_to_run(self) -> bool:
        return self.chaos_cycles == 0 and self.seeds == 0


def ignore_external() -> bool:
    return os.environ.get("ANTIBODY_IGNORE_EXTERNAL_LOOP") == "1"


@dataclass
class LoopHandle:
    proc: subprocess.Popen
    started_at: str

    def running(self) -> bool:
        return self.proc.poll() is None

    def snapshot(self) -> dict:
        return {
            "running": self.running(),
            "pid": self.proc.pid,
            "started_at": self.started_at,
            "exit_code": self.proc.returncode,
            "settings": last_settings(),
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
    "settings": None,
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
    """`{running, pid, started_at, exit_code, settings, external}`.

    `settings` are those of the last run this API spawned (parsed from loop.log, so they survive an API
    restart). They are null for an external loop: a terminal-started run left no `$` line, and echoing
    the previous API-started run's settings under it would be a lie.
    """
    if _handle is not None and _handle.running():
        return _handle.snapshot()
    pid = external_pid()
    if pid is not None:
        return {**IDLE, "running": True, "pid": pid, "external": True}
    if _handle is not None:
        return _handle.snapshot()
    return {**IDLE, "settings": last_settings()}


def is_running() -> bool:
    return state()["running"]


def _flags(body: LoopStartBody) -> list[str]:
    """The `chaos.loop run` flags for a body. Numbers are always spelled out so the `$` line is self-describing."""
    flags = ["--chaos-cycles", str(body.chaos_cycles), "--repair-attempts", str(body.repair_attempts)]
    if body.seeds == 0:
        flags.append("--no-seeds")
    elif body.seeds is not None:
        flags += ["--seeds", str(body.seeds)]
    if not body.second_pass:
        flags.append("--no-second-pass")
    if body.resume:
        flags.append("--resume")
    if body.until_quiet is not None:
        flags += ["--until-quiet", str(body.until_quiet)]
    return flags


def _env_overrides(body: LoopStartBody) -> dict[str, str]:
    """Variables the child gets on top of the API's own environment. `auto` inherits whatever is set."""
    return {"ANTIBODY_NO_ZENDESK": "1"} if body.world == "mock" else {}


def _command(body: LoopStartBody) -> list[str]:
    override = os.environ.get("ANTIBODY_LOOP_CMD")
    if override:
        return shlex.split(override)
    tail = ["-m", "chaos.loop", "run", *_flags(body)]
    if shutil.which("uv"):
        return ["uv", "run", "python", *tail]
    return [sys.executable, *tail]


def _shell_line(cmd: list[str], overrides: dict[str, str]) -> str:
    """`$ KEY=VAL cmd ...`: what a person would have typed to start this run."""
    return "$ " + " ".join([*(f"{k}={v}" for k, v in overrides.items()), shlex.join(cmd)])


def _settings_from_line(line: str) -> dict | None:
    """Inverse of `_flags` + `_env_overrides` for one `$` line; None when it is not a `chaos.loop run`.

    Flags this body does not cover (`--from-version` from a terminal run) are skipped, not an error.
    """
    try:
        argv = shlex.split(line[2:])
        run_at = argv.index("run", argv.index("chaos.loop"))
    except ValueError:
        return None
    out = LoopStartBody().model_dump()
    out["world"] = "mock" if "ANTIBODY_NO_ZENDESK=1" in argv[:run_at] else "auto"
    tokens = iter(argv[run_at + 1 :])
    try:
        for tok in tokens:
            if tok == "--chaos-cycles":
                out["chaos_cycles"] = int(next(tokens))
            elif tok == "--seeds":
                out["seeds"] = int(next(tokens))
            elif tok == "--no-seeds":
                out["seeds"] = 0
            elif tok == "--repair-attempts":
                out["repair_attempts"] = int(next(tokens))
            elif tok == "--no-second-pass":
                out["second_pass"] = False
            elif tok == "--resume":
                out["resume"] = True
            elif tok == "--until-quiet":
                out["until_quiet"] = int(next(tokens))
    except (StopIteration, ValueError):
        return None
    return out


_SCAN_CHUNK = 64 * 1024
_SCAN_LIMIT = 2 * 1024 * 1024


def _last_command_line() -> str | None:
    """The most recent `$` line in loop.log, read backwards from the end so a long log costs one chunk.

    Gives up after `_SCAN_LIMIT`: a log written entirely before `$` lines existed would otherwise be
    read whole on every poll.
    """
    if not LOG_PATH.exists():
        return None
    with LOG_PATH.open("rb") as f:
        end = f.seek(0, os.SEEK_END)
        buf = b""
        while end > 0 and len(buf) < _SCAN_LIMIT:
            start = max(0, end - _SCAN_CHUNK)
            f.seek(start)
            buf = f.read(end - start) + buf
            end = start
            lines = buf.split(b"\n")
            # The first piece is a partial line until the file start has been reached.
            complete = lines if start == 0 else lines[1:]
            for raw in reversed(complete):
                if raw.startswith(b"$ "):
                    return raw.decode(errors="replace").rstrip("\r")
    return None


def last_settings() -> dict | None:
    """Settings of the last loop this API spawned, from the log rather than memory so they outlive a restart."""
    line = _last_command_line()
    return _settings_from_line(line) if line else None


def start(body: LoopStartBody) -> dict:
    """Spawn the loop. Raises RuntimeError("running") if one we started is still alive."""
    global _handle
    with _start_lock:
        if is_running():
            raise RuntimeError("running")

        RUNS_DIR.mkdir(parents=True, exist_ok=True)
        cmd = _command(body)
        overrides = _env_overrides(body)
        env = {**os.environ, "PYTHONUNBUFFERED": "1", **overrides}
        with LOG_PATH.open("ab") as log:
            log.write((_shell_line(cmd, overrides) + "\n").encode())
            log.flush()
            proc = subprocess.Popen(
                cmd,
                cwd=ROOT,
                env=env,
                stdout=log,
                stderr=subprocess.STDOUT,
                stdin=subprocess.DEVNULL,
                start_new_session=True,
            )
        _handle = LoopHandle(proc=proc, started_at=datetime.now(timezone.utc).isoformat())
    return {"pid": proc.pid, "started_at": _handle.started_at, "settings": body.model_dump()}


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
