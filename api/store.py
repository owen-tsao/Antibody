"""Read-side access to run artifacts, with the committed golden run as fallback.

The loop writes files; the UI reads them through here. Nothing in this module imports
`weave` or spawns anything, so the API process stays cheap and cannot collide with the
loop's tracing state (docs/FRONTEND.md §8).

Source resolution: "live" means the files the loop writes (`cycles.jsonl`, `runs/`).
"golden" is `data/golden/`, a known-good run committed on purpose. "run:<id>" is one past run
under `history/<id>/` (a flat folder: `cycles.jsonl`, `configs/`, `regression.json`, `status_log.jsonl`
side by side). Callers ask for a source; `resolve_source("live")` degrades to golden when the live
files are absent, so a fresh checkout or a post-`reset` tree still shows the demo data — labeled as
such. `<id>` arrives in a URL, so `parse_source` is the one door: it accepts only names that match
`RUN_ID` and resolve to an existing folder inside `HISTORY_DIR`.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Literal, NamedTuple

from chaos.schemas import AgentConfig, CycleRecord, Scenario
from chaos.state import CONFIGS_DIR, CYCLES_PATH, GOLDEN_DIR, HISTORY_DIR, REGRESSION_PATH, RUN_MANIFEST_PATH
from chaos.status import STATUS_LOG_PATH, STATUS_PATH

# `"live"`, `"golden"`, or `"run:<id>"`. Wider than the two literals so a history folder can be read
# through the same functions; route handlers get one via `parse_source`, never straight from the URL.
Source = Literal["live", "golden"] | str
RUN_PREFIX = "run:"
# History folder names: the loop's UTC stamps (`20260913T174437Z`) and hand-named copies
# (`continuation-2026-09-13`). No dots, no slashes, so `..` and paths can never match. Capped well
# under NAME_MAX so `resolve()` can never fail with ENAMETOOLONG on a URL nobody could have a folder for.
RUN_ID = re.compile(r"^[A-Za-z0-9T_-]{1,128}$")

# Every reader here must tolerate the loop writing underneath it. `cycles.jsonl`, `status.json`
# and `regression.json` are safe by construction (append / atomic rename); `save_config` in
# chaos.state truncates-then-writes, so a read in that window sees an empty file. pydantic's
# ValidationError and json's JSONDecodeError are both ValueErrors.


class RunPaths(NamedTuple):
    cycles: Path
    configs: Path
    regression: Path
    status_log: Path
    manifest: Path
    status: Path
    approvals: Path


def run_dir(run_id: str) -> Path:
    """`HISTORY_DIR/<run_id>` for a name that came from a URL.

    Raises ValueError for a name outside `RUN_ID` and LookupError when no such folder exists. The
    regex alone rules out traversal; the containment check after `resolve()` is the invariant this
    module promises regardless of what the regex is loosened to later.
    """
    if not RUN_ID.fullmatch(run_id) or Path(run_id).name != run_id:
        raise ValueError(f"invalid run id {run_id!r}")
    root = HISTORY_DIR.resolve()
    path = (HISTORY_DIR / run_id).resolve()
    if path.parent != root or not path.is_relative_to(root):
        raise ValueError(f"run id {run_id!r} escapes the history folder")
    if not path.is_dir():
        raise LookupError(f"no run {run_id!r} in history")
    return path


def parse_source(raw: str) -> Source:
    """Validate a `source` query value. ValueError for a malformed one, LookupError for an unknown run."""
    if raw in ("live", "golden"):
        return raw
    if raw.startswith(RUN_PREFIX):
        run_dir(raw[len(RUN_PREFIX) :])
        return raw
    raise ValueError(f"source must be live, golden or run:<id>, not {raw!r}")


def run_paths(source: Source) -> RunPaths:
    """Where a source keeps its files. Golden nests `runs/`; live and history folders do not.

    The one place the two folder shapes are known: every reader here and the replay loader go through it.
    """
    if source == "golden":
        return RunPaths(
            cycles=GOLDEN_DIR / "cycles.jsonl",
            configs=GOLDEN_DIR / "runs" / "configs",
            regression=GOLDEN_DIR / "runs" / "regression.json",
            status_log=GOLDEN_DIR / "status_log.jsonl",
            manifest=GOLDEN_DIR / "runs" / "run.json",
            status=GOLDEN_DIR / "runs" / "status.json",
            approvals=GOLDEN_DIR / "runs" / "approvals.json",
        )
    if source == "live":
        # approvals.json sits beside regression.json (chaos.state.approvals_path), so a relocated runs/ carries it.
        return RunPaths(CYCLES_PATH, CONFIGS_DIR, REGRESSION_PATH, STATUS_LOG_PATH, RUN_MANIFEST_PATH, STATUS_PATH, REGRESSION_PATH.parent / "approvals.json")
    if source.startswith(RUN_PREFIX):
        d = run_dir(source[len(RUN_PREFIX) :])
        return RunPaths(
            cycles=d / "cycles.jsonl",
            configs=d / "configs",
            regression=d / "regression.json",
            status_log=d / "status_log.jsonl",
            manifest=d / "run.json",
            status=d / "status.json",
            approvals=d / "approvals.json",
        )
    raise ValueError(f"unknown source {source!r}")


def live_exists() -> bool:
    return CYCLES_PATH.exists() or CONFIGS_DIR.exists()


def resolve_source(requested: Source) -> Source:
    if requested == "live" and not live_exists():
        return "golden"
    return requested


def read_cycles(source: Source) -> list[CycleRecord]:
    path = run_paths(source).cycles
    if not path.exists():
        return []
    out: list[CycleRecord] = []
    try:
        text = path.read_text()
    except OSError:
        # A fresh run archives the previous run's files between our exists() and read: not there yet.
        return []
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            out.append(CycleRecord.model_validate_json(line))
        except ValueError:
            # The loop appends mid-run; a torn final line is expected, not an error.
            continue
    return out


def config_versions(source: Source) -> list[int]:
    configs = run_paths(source).configs
    if not configs.exists():
        return []
    # Only `v<int>.json` counts; a stray `v3 copy.json` must not take every read route down.
    return sorted(int(p.stem[1:]) for p in configs.glob("v*.json") if p.stem[1:].isdigit())


def read_config(source: Source, version: int) -> AgentConfig | None:
    """The saved config, or None when absent or caught mid-write (callers treat both as 'not there')."""
    path = run_paths(source).configs / f"v{version}.json"
    if not path.exists():
        return None
    try:
        return AgentConfig.model_validate_json(path.read_text())
    except (OSError, ValueError):
        return None


def eval_call_id(source: Source, version: int) -> str | None:
    """The Weave call id of the gate-new evaluation that admitted `version`: the cycle whose gate promoted the config to
    it, first sample. None for v0 (never gated), records written before ids were stored, or a run without a client."""
    for rec in read_cycles(source):
        if rec.gate is not None and rec.config_after == version and rec.config_before != version:
            return rec.gate.weave_eval_call_ids[0] if rec.gate.weave_eval_call_ids else None
    return None


def read_regression(source: Source) -> list[Scenario]:
    path = run_paths(source).regression
    if not path.exists():
        return []
    try:
        return [Scenario(**row) for row in json.loads(path.read_text())]
    except (OSError, ValueError, TypeError):
        return []


def read_approvals(source: Source) -> dict[int, dict]:
    """A run's review decisions by version (`chaos.state.load_approvals` shape); `{}` when none were made or the file is
    torn. `load_approvals` drops malformed entries itself; a file whose top level is not an object is the one shape
    that gets past it (`AttributeError` on `.items()`), and one hand-edited run must not take the inbox down."""
    from chaos.state import load_approvals

    try:
        return load_approvals(run_paths(source).approvals)
    except (OSError, ValueError, TypeError, AttributeError):
        return {}


def policy_config(source: Source, version: str) -> AgentConfig:
    """The config whose `tool_rules` a source would enforce: `approved` is *that run's* certified version (its own
    approvals.json; v0 when it certified nothing), anything else is `v{N}` from its `configs/`.

    v0 is never a file a run had to save (a fresh run has not written one yet), so it falls back to the pack's initial
    deployment — the run's own domain when its manifest names one, else the active pack. ValueError for a version that
    is not a number; FileNotFoundError for one this run never saved (a torn config file counts as not there).
    """
    from chaos.domains import active_domain, load_domain
    from chaos.state import approved_version
    from chaos.target_agent import v0_config

    n = approved_version(read_approvals(source)) if version == "approved" else int(version)
    cfg = read_config(source, n)
    if cfg is not None:
        return cfg
    if n != 0:
        raise FileNotFoundError(str(run_paths(source).configs / f"v{n}.json"))
    stored = _manifest_file(run_paths(source).manifest)
    return v0_config(load_domain(stored["domain"]) if stored else active_domain())


def read_vulnerability(source: Source) -> dict | None:
    """`runs/vulnerability.json` as `{"landed": {"v0": 6, ...}, "suite_size": 6, "world": "mock"|"zendesk"|None}`,
    plus `by_attack: {"v0": {scenario_id: [bool per sample]}}` and `samples` when `vulnerability_detail.json` has them.

    Written by `chaos.loop vulnerability` (every saved version) or by `chaos.loop run --vulnerability`
    at the end of a run (v0 and the final version only; what the dashboard starts): how many of the final
    regression suite's attacks land on each measured config. The denominator is that final suite, so it comes from
    `regression.json`, not from any one cycle's `regression_suite_size`. `world` is where the
    measurement ran (from the detail file); None when the run predates that field. A cell counts as landed when
    it landed in the majority of samples (the detail file's `rule`), the same rule that produced the counts.
    """
    regression = run_paths(source).regression
    path = regression.parent / "vulnerability.json"
    if not path.exists():
        return None
    try:
        doc = json.loads(path.read_text())
    except (OSError, ValueError):
        return None
    if not isinstance(doc, dict):
        return None
    landed = {
        k: v
        for k, v in doc.items()
        if isinstance(k, str) and k.startswith("v") and k[1:].isdigit() and isinstance(v, int) and not isinstance(v, bool)
    }
    if not landed:
        return None
    out: dict = {"landed": landed, "suite_size": len(read_regression(source)), "world": None}
    try:
        detail = json.loads((regression.parent / "vulnerability_detail.json").read_text())
    except (OSError, ValueError):
        return out
    if not isinstance(detail, dict):
        return out
    if detail.get("world") in WORLDS:
        out["world"] = detail["world"]
    # Per-attack cells (plan 11 §7): `{"v0": {"seed-x": [true, false, true]}}`, one boolean per sample. Only well-formed
    # entries pass; a torn or hand-edited file degrades to counts, never to a 500. Absent for runs measured before the
    # detail file existed, so the payload keeps its old shape and the UI renders counts.
    by_attack = {
        v: {sid: [bool(b) for b in hits] for sid, hits in attacks.items() if isinstance(sid, str) and isinstance(hits, list)}
        for v, attacks in (detail.get("landed") or {}).items()
        if isinstance(v, str) and v in landed and isinstance(attacks, dict)
    }
    if by_attack:
        out["by_attack"] = by_attack
        if isinstance(detail.get("samples"), int) and not isinstance(detail.get("samples"), bool):
            out["samples"] = detail["samples"]
    return out


def read_status() -> dict:
    """Raw contents of `runs/status.json` (written by chaos.status at every phase transition)."""
    if not STATUS_PATH.exists():
        return {"phase": "idle"}
    try:
        doc = json.loads(STATUS_PATH.read_text())
    except (OSError, ValueError):
        # Written atomically via rename (and moved aside by a fresh run), but be tolerant anyway.
        return {"phase": "idle"}
    # Anything that is not an object (a stray `null`, a list) would crash the phase check upstream.
    return doc if isinstance(doc, dict) else {"phase": "idle"}


# --- Run manifests -------------------------------------------------------------------------------

WORLDS = ("mock", "zendesk")


class _LogBounds(NamedTuple):
    first: str | None  # `since` of the first row
    last: str | None  # `since` of the last row
    duration_s: float | None  # largest `t_rel` seen: how long the recorded run took


def status_log_rows(path: Path) -> list[dict]:
    """Every JSON-object row of a phase log, in file order; [] when the file is missing or unreadable.

    The one parser for `status_log.jsonl`: `run_manifest` reads start/end/duration from it and
    `api.replay` plays it, so the two cannot disagree about what a row is. Torn or non-object lines are skipped.
    """
    try:
        lines = path.read_text().splitlines()
    except OSError:
        return []
    rows: list[dict] = []
    for line in lines:
        if not line.strip():
            continue
        try:
            row = json.loads(line)
        except ValueError:
            continue
        if isinstance(row, dict):
            rows.append(row)
    return rows


def timed_rows(rows: list[dict]) -> list[dict]:
    """The rows replay can place on its clock: those with a numeric `t_rel`, sorted by it."""
    return sorted((r for r in rows if isinstance(r.get("t_rel"), (int, float)) and not isinstance(r.get("t_rel"), bool)), key=lambda r: r["t_rel"])


def _status_log_bounds(path: Path) -> _LogBounds:
    """Start, end and length of a phase log; None fields where the log has no such row.

    `duration_s` is the last timed row's `t_rel`, the same number `api.replay` plays to (`Recording.duration_s`).
    """
    rows = status_log_rows(path)
    stamps = [r["since"] for r in rows if isinstance(r.get("since"), str)]
    timed = timed_rows(rows)
    return _LogBounds(stamps[0] if stamps else None, stamps[-1] if stamps else None, float(timed[-1]["t_rel"]) if timed else None)


def _manifest_file(path: Path) -> dict | None:
    """The stored `run.json` fields worth trusting, or None when absent or unreadable."""
    try:
        doc = json.loads(path.read_text())
    except (OSError, ValueError):
        return None
    if not isinstance(doc, dict):
        return None
    world = doc.get("world") if doc.get("world") in WORLDS else "mock"
    target = doc.get("target") if isinstance(doc.get("target"), str) and doc["target"] else "builtin"
    flags = [f for f in doc.get("flags", []) if isinstance(f, str)] if isinstance(doc.get("flags"), list) else []
    started = doc.get("started_at") if isinstance(doc.get("started_at"), str) else None
    domain = doc.get("domain") if isinstance(doc.get("domain"), str) and doc["domain"] else "retail"
    seed = doc.get("seed") if isinstance(doc.get("seed"), int) and not isinstance(doc.get("seed"), bool) else None
    leaderboard = doc.get("weave_leaderboard_url") if isinstance(doc.get("weave_leaderboard_url"), str) and doc["weave_leaderboard_url"].startswith("https://") else None
    return {"world": world, "target": target, "flags": flags, "started_at": started, "domain": domain, "seed": seed, "weave_leaderboard_url": leaderboard}


def _sum_or_none(values: list) -> float | int | None:
    present = [v for v in values if v is not None]
    if not present:
        return None
    total = sum(present)
    return round(total, 6) if isinstance(total, float) else total


def _cost_source(cycles: list[CycleRecord]) -> str | None:
    """Where the run's `cost_usd` came from: `weave` when every priced cycle was read back from Weave, `estimated`
    otherwise (the local price table, or records from before the label existed); None when no cycle has a cost."""
    priced = [rec for rec in cycles if rec.cost_usd is not None]
    if not priced:
        return None
    return "weave" if all(rec.cost_source == "weave" for rec in priced) else "estimated"


def run_manifest(source: Source) -> dict | None:
    """One run described: what its process recorded plus what its files say now.

    `run.json` contributes only `world`, `target`, `domain`, `seed`, `flags` (and `started_at` as a fallback): those
    are facts nobody but the loop process had. Everything countable — `cycles`, `accepted`, `rejected`,
    `versions`, `final_version`, `started_at`, `finished_at`, `recording`, `duration_s` — is read from
    `cycles.jsonl`, `configs/` and `status_log.jsonl` here, because the loop keeps appending to those long
    after any file written at start could be current. Runs made before `run.json` existed get `world: "mock"`,
    `target: "builtin"` and `synthesized: true` so the UI can say it is guessing. None when the source
    has none of its files at all.
    """
    paths = run_paths(source)
    stored = _manifest_file(paths.manifest)
    cycles = read_cycles(source)
    versions = config_versions(source)
    first, last, duration_s = _status_log_bounds(paths.status_log)
    if stored is None and not cycles and not versions and first is None:
        return None
    gated = [rec.gate for rec in cycles if rec.gate is not None]
    if versions:
        final_version: int | None = versions[-1]
    else:
        final_version = cycles[-1].config_after if cycles else None
    if source.startswith(RUN_PREFIX):
        run_id = source[len(RUN_PREFIX) :]
    else:
        run_id = source
    return {
        "id": run_id,
        "started_at": first or (stored or {}).get("started_at"),
        "finished_at": last,
        "world": stored["world"] if stored else "mock",
        "target": stored["target"] if stored else "builtin",
        # Runs recorded before domain packs existed ran the retail world and made unseeded choices.
        "domain": stored["domain"] if stored else "retail",
        "seed": stored["seed"] if stored else None,
        # The run's Weave leaderboard (legit pass rate per version, plan 11 §4.3); null until the loop publishes it at run end.
        "weave_leaderboard_url": stored["weave_leaderboard_url"] if stored else None,
        "cycles": len(cycles),
        "accepted": sum(1 for g in gated if g.accepted),
        "rejected": sum(1 for g in gated if not g.accepted),
        "versions": versions,
        "final_version": final_version,
        "flags": stored["flags"] if stored else [],
        "synthesized": stored is None,
        # pass^k per accepted version: the fix held in `passed` of `k` independent episodes at the gate that made it.
        "pass_k": {str(rec.config_after): rec.gate.pass_k for rec in cycles if rec.gate is not None and rec.gate.accepted},
        # How many of the pack's legit tasks the target could perform, from the latest gate that measured it
        # (None: no gate yet, or a run recorded before coverage existed — every task was judged).
        "legit_covered": next((g.legit_covered for g in reversed(gated) if g.legit_covered is not None), None),
        # The run's bill so far, summed over cycles that recorded one (None when none did: records before the fields existed).
        "cost_usd": _sum_or_none([rec.cost_usd for rec in cycles]),
        "latency_ms": _sum_or_none([rec.latency_ms for rec in cycles]),
        # What `api.replay.load_recording` needs: a phase log with timed rows and the cycles they land.
        # A run whose loop died before its first phase row has files but is not a tape.
        "recording": duration_s is not None and paths.cycles.exists(),
        "duration_s": round(duration_s, 1) if duration_s is not None else None,
        # "weave" only when every priced cycle was priced by Weave; one estimated cycle makes the sum an estimate.
        # Left out, rather than null, when no cycle has a cost (the UI's type says absent).
        **({"cost_source": source} if (source := _cost_source(cycles)) else {}),
    }


def history_runs() -> list[dict]:
    """Manifests of every past run under HISTORY_DIR that has at least one cycle, newest start first.

    A folder with no cycles (a run aborted before cycle 1) is skipped: there is nothing to open. Folders
    whose names would not survive `parse_source` are skipped too, since no URL could ever reach them,
    and so are symlinks (`run_dir` refuses them; one planted in history/ must not take the list down)
    and folders that vanish or turn unreadable between listing and reading.
    """
    if not HISTORY_DIR.is_dir():
        return []
    out: list[dict] = []
    for child in HISTORY_DIR.iterdir():
        if child.is_symlink() or not child.is_dir() or not RUN_ID.fullmatch(child.name):
            continue
        try:
            manifest = run_manifest(f"{RUN_PREFIX}{child.name}")
        except (ValueError, LookupError, OSError):
            continue
        if manifest is not None and manifest["cycles"] > 0:
            out.append(manifest)
    return newest_first(out)


def newest_first(manifests: list[dict]) -> list[dict]:
    """Sort by `started_at` descending. A run with no phase log has no start time and sorts last rather than breaking the sort."""
    return sorted(manifests, key=lambda m: (m["started_at"] is not None, m["started_at"] or "", m["id"]), reverse=True)


# --- Review inbox (plan 11 §7): every version awaiting a decision, per agent, in one read ------------------


def _cycle_that_made(cycles: list[CycleRecord], version: int) -> CycleRecord | None:
    """The cycle whose accepted patch produced `version`, or None (a rollback copy, starter rules)."""
    return next((rec for rec in cycles if rec.config_after == version and rec.config_before < version and rec.gate is not None and rec.gate.accepted), None)


def review_items(run: dict, source: Source) -> list[dict]:
    """One row per saved version past v0 of one run, highest version first, in the inbox's item shape.

    `run` is a runs-list row (`id`, `started_at`, `current`). v0 is the code's own config and is never reviewed.
    `decided_at` is null while the version is pending; a decided row also carries `status` (approved/rejected) and
    `note`. Only the live run's versions can be decided (`POST /api/configs/{v}/review` is live-only), so `live`
    is what tells the UI whether a pending row is a queue item or an archived one.
    """
    cycles = read_cycles(source)
    decisions = read_approvals(source)
    out: list[dict] = []
    for v in reversed([v for v in config_versions(source) if v > 0]):
        cycle = _cycle_that_made(cycles, v)
        cfg = read_config(source, v)
        gate = cycle.gate if cycle is not None else None
        decision = decisions.get(v)
        item = {
            "run": run["id"],
            "run_started": run.get("started_at"),
            "live": run["id"] == "live",
            "version": v,
            "cycle": cycle.cycle if cycle is not None else None,
            # What the version fixes: the cycle's attack, else the saved patch note (a rollback copy, starter rules).
            "title": cycle.scenario.title if cycle is not None else ((cfg.patch_note if cfg is not None else "") or f"v{v}"),
            "gate": {
                "fix_passes": gate.fix_passes,
                "fix_samples": gate.fix_samples,
                "legit_pass_rate": gate.legit_pass_rate,
                "legit_covered": gate.legit_covered,
            } if gate is not None else None,
            "decided_at": decision.get("at") if decision else None,
        }
        if decision:
            item["status"] = decision["status"]
            item["note"] = decision.get("note", "")
        out.append(item)
    return out


def review_inbox(runs: list[dict]) -> list[dict]:
    """`[{agent: {id, name} | null, pending: [...], archived: [...], decided: [...]}]`: the Review page's index, one read.

    `runs` is `GET /api/runs`' list (each row already joined to its `agent`). The golden reference run is skipped: it is
    not anyone's run and nothing on it can be decided. Groups are one per agent in the order the runs list has them
    (current run first, then newest); runs whose agent row is gone group under `agent: null`. `pending` holds only
    the live run's undecided versions — the ones a decision can actually be recorded on — so its length is the
    reviewer's real workload. Undecided versions of archived runs go to `archived` (they can be looked at, not
    decided); `decided` mixes live and archived, newest run first. Every list is highest version first within a run.
    A run that fails to read contributes nothing rather than failing the poll.
    """
    groups: dict[str | None, dict] = {}
    for run in runs:
        if run.get("label") == "reference run" or run["id"] == "golden":
            continue
        source: Source = "live" if run.get("current") else f"{RUN_PREFIX}{run['id']}"
        try:
            items = review_items(run, source)
        except (ValueError, LookupError, OSError):
            continue
        agent = run.get("agent")
        key = agent["id"] if agent else None
        group = groups.setdefault(key, {"agent": agent, "pending": [], "archived": [], "decided": []})
        for item in items:
            bucket = "decided" if item["decided_at"] else "pending" if item["live"] else "archived"
            group[bucket].append(item)
    for group in groups.values():
        # Stable sort: live rows first; run order (and version order within a run) is preserved from `runs`.
        group["decided"].sort(key=lambda item: not item["live"])
    return list(groups.values())
