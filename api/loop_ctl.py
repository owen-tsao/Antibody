"""Spawn, watch and stop the self-healing loop as a subprocess of the API.

The API never runs the loop in-process: the loop calls `weave.init` and holds tracing state,
and it can run for minutes. It is started exactly the way the CLI is used by hand:

    PYTHONUNBUFFERED=1 uv run python -m chaos.loop run --chaos-cycles 3 --repair-attempts 3 [...]

`LoopStartBody` is the settings contract (docs/plans/02, A1): every field is one `chaos.loop run`
flag, so the UI cannot offer a knob the loop does not have; `world: "mock"` becomes
`ANTIBODY_NO_ZENDESK=1` in the child's environment only. Cross-field rules (`until_quiet` needs chaos
cycles to count; a body with no seeds and no cycles is nothing to run) live on the model as a
`model_validator`, so any code constructing a body gets them; `api.main` turns those into 400s.

`start()` records what it spawned in `runs/loop_settings.json` (`{body, pid, started_at, cmd}`),
written only after `Popen` succeeded so the file can never describe a run that did not start. That
sidecar is how `GET /api/loop` still reports the last API-started run's settings after the API itself
has restarted; `saved_settings()` reads it. The same `$ ...` command line is also appended to
`runs/loop.log` — a human note so the log reads like a terminal session, never parsed. The loop
process writes its own start-of-run document, `runs/run.json` (world, target, argv); the two files
have different authors and are deliberately not merged (see `chaos.state`). Both move to history/
with the run.

`settings` is null when the sidecar is missing, when the loop that is running is not ours
(`external: true`: a terminal-started run has no sidecar of its own, and echoing an older one under
it would be a lie), or when the run on disk is no longer the one we spawned: a fresh terminal run
archives the sidecar with the old run, and `saved_settings` also checks the loop's own `run.json`
flags against the ones we passed, so a run started by hand with different settings never wears ours.

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
instead of the loop. The 409 / stop / log paths behave identically. `settings` is the body that was
asked for, from both `POST /api/loop/start` and `GET /api/loop`: the sidecar records the request, and
its `cmd` field is honest about what actually ran.

Test-only override: `ANTIBODY_IGNORE_EXTERNAL_LOOP=1` disables the pgrep fallback, so a scratch
API on another port does not see (and is not blocked by) a real run started elsewhere. It only
affects loops this process did not spawn; never set it on the demo server, where the whole point of
the fallback is to refuse a second loop.
"""

from __future__ import annotations

import json
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

from pydantic import BaseModel, Field, ValidationError, model_validator

from chaos.state import LOOP_SETTINGS_PATH, ROOT, RUN_MANIFEST_PATH, RUNS_DIR

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

    @model_validator(mode="after")
    def _rules(self) -> LoopStartBody:
        if self.chaos_cycles == 0 and self.seeds == 0:
            raise ValueError("nothing to run: no seeds and no chaos cycles")
        # The streak is counted over chaos cycles only, so it can never be reached past the cap.
        if self.until_quiet is not None and self.until_quiet > self.chaos_cycles:
            raise ValueError("until_quiet cannot exceed chaos_cycles")
        return self


def ignore_external() -> bool:
    return os.environ.get("ANTIBODY_IGNORE_EXTERNAL_LOOP") == "1"


@dataclass
class LoopHandle:
    proc: subprocess.Popen
    started_at: str
    # The body this run was started with; reported while it runs, no file involved.
    settings: dict

    def running(self) -> bool:
        return self.proc.poll() is None

    def snapshot(self) -> dict:
        return {
            "running": self.running(),
            "pid": self.proc.pid,
            "started_at": self.started_at,
            "exit_code": self.proc.returncode,
            "settings": self.settings,
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

    While our child runs, `settings` is the body it was started with (memory). Once it has exited the
    sidecar is the one source of truth, so a later terminal-started run (which archives or outdates
    the sidecar) makes `settings` null instead of echoing a run that is no longer the one on disk.
    """
    if _handle is not None and _handle.running():
        return _handle.snapshot()
    pid = external_pid()
    if pid is not None:
        return {**IDLE, "running": True, "pid": pid, "external": True}
    if _handle is not None:
        return {**_handle.snapshot(), "settings": saved_settings()}
    return {**IDLE, "settings": saved_settings()}


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
    """`$ KEY=VAL cmd ...`: what a person would have typed to start this run. A note in the log, never parsed."""
    return "$ " + " ".join([*(f"{k}={v}" for k, v in overrides.items()), shlex.join(cmd)])


def _write_settings(body: LoopStartBody, pid: int, started_at: str, cmd: list[str]) -> None:
    """The sidecar, written whole via rename so a poll never reads a torn file."""
    doc = {"body": body.model_dump(), "pid": pid, "started_at": started_at, "cmd": cmd}
    tmp = LOOP_SETTINGS_PATH.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(doc, indent=2))
    os.replace(tmp, LOOP_SETTINGS_PATH)


def _run_on_disk_is_ours(doc: dict, body: LoopStartBody) -> bool:
    """False when `runs/run.json` says the run on disk was started with other flags than we spawned.

    The loop records its argv in `run.json` at start; if a terminal-started run has replaced ours since
    the sidecar was written, those flags differ from `_flags(body)`. A `--resume` continues the run on
    disk, whose `run.json` is the original's, so it is not compared. No `run.json`, or a spawned command
    that is not the loop (`ANTIBODY_LOOP_CMD`), leaves nothing to contradict the sidecar.
    """
    cmd = doc.get("cmd")
    if body.resume or not isinstance(cmd, list) or "chaos.loop" not in cmd:
        return True
    try:
        flags = json.loads(RUN_MANIFEST_PATH.read_text()).get("flags")
    except (OSError, ValueError, AttributeError):
        return True
    return not isinstance(flags, list) or flags == _flags(body)


def saved_settings() -> dict | None:
    """The body of the last run this API spawned, from the sidecar; None when absent, unreadable or outdated.

    Outdated means the run on disk is not the one the sidecar describes (`_run_on_disk_is_ours`).
    """
    try:
        doc = json.loads(LOOP_SETTINGS_PATH.read_text())
        body = LoopStartBody.model_validate(doc["body"])
    except (OSError, ValueError, KeyError, TypeError, ValidationError):
        return None
    if not isinstance(doc, dict) or not _run_on_disk_is_ours(doc, body):
        return None
    return body.model_dump()


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
        started_at = datetime.now(timezone.utc).isoformat()
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
        # After Popen: a spawn that raised must not leave a sidecar describing a run that never began.
        _write_settings(body, proc.pid, started_at, cmd)
        _handle = LoopHandle(proc=proc, started_at=started_at, settings=body.model_dump())
    return {"pid": proc.pid, "started_at": started_at, "settings": body.model_dump()}


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
