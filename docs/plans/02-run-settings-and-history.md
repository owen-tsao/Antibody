# 02 — Run settings, run history, and versions

**Budget:** ~18 hours. Part A (settings) ~9 h; Part B (run history, replay any run, rollback) ~9 h.
A1 and B-backend are lane B; A2, Part C, and B-UI are UI chats (`handoffs/`).
**Outcome:** Heal has a settings drawer wired to the flags the CLI already has, and below it a list of
past runs. Each run opens to its details, can be replayed with the transport controls, and its agent
version can be rolled back to. The dashboard fails politely when the API is down, the key is missing,
or the loop dies.

## The model this plan implements

- **A run is the unit of history.** Every `chaos.loop run` starts fresh from v0 unless told otherwise,
  and archives the previous run. Inside a run are cycles; each accepted patch is a config version.
- **The current agent config is the latest live version.** The loop advances it; `rollback` copies any
  version of any past run in as a new version; `check` (plan 04 Step 5) verifies whatever it is.
- **Runs record their world and target** so history can say "Sep 14 · 6 cycles · v0→v3 · built-in · mock"
  and rollback refuses to apply a built-in config to a run made against an external target.

## Facts this plan rests on

- The CLI already has the knobs (`chaos/loop.py:281–300`): `--chaos-cycles` (3), `--seeds N`,
  `--no-seeds`, `--repair-attempts N` (3), `--from-version N`, `--resume`, `--no-second-pass`.
  There is **no** `--until-quiet`; the API's `until_quiet` mode returns 400 (`api/main.py:198`).
- The API exposes **only** `--chaos-cycles` (`api/loop_ctl.py:181–188`). `LoopStartBody`
  (`api/main.py:187–194`) accepts `quiet_streak`/`max_cycles` but ignores them.
- `POST /api/loop/start` spawns the loop even with no `WANDB_API_KEY`; the child dies at `weave.init`
  (`loop.py:326`). `loop.log` is append-mode and nothing prints the command (`loop_ctl.py:202`).
- Fresh runs archive to `runs/archive/<UTC ts>/` (`state.py:71–89`); `--resume` does not; `chaos.loop reset`
  deletes `runs/` **including the archive** (`state.py:58–65`). Archive folders are **flat**
  (`cycles.jsonl`, `configs/`, `regression.json`, `status.json`, `status_log.jsonl`) — a different shape
  from `data/golden/` (`cycles.jsonl` at top, the rest under `runs/`). Some archives lack `cycles.jsonl`
  (aborted before cycle 1) or `configs/`.
- Replay (`api/replay.py`) reads exactly one recording, `data/golden/`. Every archive already contains
  the two files it needs (`status_log.jsonl`, `cycles.jsonl`).
- `Source = Literal["live","golden"]` (`store.py:23`) is a FastAPI `Query` type; a third source needs a parser.
- `web/src` has no settings and no `localStorage`; `App.tsx:18` hardcodes `DEMO_CHAOS_CYCLES = 1`.
- `api.loopStop` exists and is never called from any page (`api.ts:306`).

## Part A — Settings (~9 h)

### A1. API (~3 h, lane B)

```python
class LoopStartBody(BaseModel):
    chaos_cycles: int = Field(3, ge=0, le=10)
    seeds: int | None = Field(None, ge=0, le=10)      # None = all seeds
    repair_attempts: int = Field(3, ge=1, le=5)
    second_pass: bool = True
    resume: bool = False
    until_quiet: int | None = Field(None, ge=1, le=10) # stop after N consecutive cycles with no landed attack
    world: Literal["auto", "mock"] = "auto"           # mock → ANTIBODY_NO_ZENDESK=1 in the child env
```

- `chaos_cycles == 0 and seeds == 0` → 400 "nothing to run". Missing `WANDB_API_KEY` → **503** with a
  message the UI shows verbatim (ships with 03 Step 1 regardless).
- `loop_ctl._command(body)` builds the flag list; env overrides go in the **child** env only.
- `loop_ctl.start` writes a `$ <shlex.join(cmd)>` line to `loop.log` at spawn; the check is "the last `$` line".
- `GET /api/loop` echoes the settings of the running/last run. `GET /api/manifest` adds `defaults`.
- **`--until-quiet N`** is new in `chaos/loop.py` (lane A, ~2 h). Semantics, decided: when set,
  `--chaos-cycles` **changes meaning from "exactly N" to "at most N"** — the loop keeps generating chaos
  cycles until N consecutive *chaos-generated cycles from this process* have `attack_succeeded == False`
  (`state.records` on a `--resume` run already holds old cycles; count only records appended after start),
  or the cap is hit. Seeds, the second pass, and the closing replay never count toward the streak.
  The drawer's estimate must say "up to N minutes" when until-quiet is on. Remove the dead
  `quiet_streak`/`max_cycles`/`mode` fields.
- `target` is **not** a field. Plan 01's `ANTIBODY_TARGET` is an env decision shown read-only.

### A2. UI (shipped in `f36098f`; ~1 h follow-up — see `handoffs/ui-1-settings-drawer.md`)

**Status:** the drawer exists (`SettingsDrawer.tsx`, `lib/settings.ts`). It was delivered **without** the
"Until quiet" field; that is a one-hour follow-up in the same chat once A1 lands, plus the "up to" estimate
wording above.

- Quiet "settings" text link under the Heal orb; solid right-side panel, no backdrop blur.
- Fields: Seeds (0–all), Chaos cycles (0–10), Repair attempts (1–5), Second pass (toggle),
  Until quiet (off / 1–10), World (auto / mock). Read-only line: target and models from the manifest.
- Steppers are text buttons with the `u-line` wipe. "about N minutes" from one documented constant.
- Persist to `localStorage["antibody.settings.v1"]`; clamp and drop unknowns on read.
- Heal label becomes "Heal · 1 seed · 2 cycles" when settings differ from defaults.
- Focus trap, Esc closes, Tab reaches every field, `prefers-reduced-motion` respected.

### Part C — Three error states (shipped in `7a04986` — see `handoffs/ui-2-states-and-controls.md`)

| Situation | Signal | Show |
| --- | --- | --- |
| API down | `usePoll` error, no data | Same one-line treatment on every tool page, with "retry" |
| No `WANDB_API_KEY` | `/api/health.has_api_key: false` | One line on Heal (chat 1) and Agents (chat 2): "Set WANDB_API_KEY to run live; Replay works without it." |
| Loop exits non-zero | `/api/loop.exit_code != 0` | Agents status line: "the loop stopped (exit N) — open log" |

Plus a "stop run" text button in the Agents header calling the existing `api.loopStop`.

## Part B — Run history, replay any run, rollback (~9 h)

### B1. Backend (~6 h, lane B; the `history/` move coordinates with plan 03's `ANTIBODY_RUNS_DIR`)

- **Depends on plan 03 Step 1's `HISTORY_DIR`** (archive moved out of `runs/` so `reset` cannot wipe it;
  `ARCHIVE_DIR` renamed, `snapshot_golden`'s `ignore("archive")` dropped). Not duplicated here.
- **Run manifest.** `archive_previous_run` (and `start_run`, for the live run) writes `run.json`:
  `{id, started_at, finished_at, world: "mock"|"zendesk", target: "builtin"|"http:<url>", cycles,
  accepted, rejected, versions: [0..N], final_version, flags: [...]}`. `started_at` from the first
  `status_log.jsonl` row, not the folder name.
- **`GET /api/runs`** → `[run.json, …]` newest first, plus the live run as `current: true`. Hide runs
  with zero cycles. `GET /api/runs/{id}` → the manifest plus `configs` (version, parent, patch_note).
- **Sources.** `source` on the read routes becomes `str` parsed as `live | golden | run:<id>` (six routes
  plus `resolve_source`/`_resolve`, ~8 edits); **validate `id`** against `^[A-Za-z0-9T_-]+$` and
  `Path(id).name == id`. `store._paths` gets a flat-shaped branch. `golden` stays a special source because
  it is the only run committed to the repo — and **`GET /api/runs` includes it as a synthetic entry**
  `{id: "golden", label: "demo tape", …}` built from `replay.recording_meta()`, so the UI has one list.
- **Replay any run** (~2 h, not a lookup). `POST /api/replay/start?speed=&recording=golden|run:<id>`.
  `replay.py` today hardwires three golden constants (`replay.py:40–42`), `load_recording()` takes no
  argument (`:57`), and the cache key is the golden mtimes (`:97–113`): make `load_recording(dir)` with a
  per-directory cache key, and make `recording_meta()`/`info()` report **which** recording is loaded so
  Heal's label does not claim the golden date over an archived tape. While a `run:<id>` replay is active,
  `_read_source` (`main.py:83–85`) and `get_state`'s hardcoded `"golden"` (`:95`) must return the run's
  source — three call sites. Refuse runs with no `status_log.jsonl`. Resumed runs replay correctly as one
  tape (`t_rel` stays monotonic across the seam), but a history folder is one archive, not a resume chain;
  `run.json.flags` records the flags of the *first* process only — say so in the manifest field doc.
- **Rollback.** `POST /api/rollback {run: id, version: n}` → loads `history/<id>/configs/v{n}.json`,
  **copies** it in as the next live version (`version = latest_version()+1`, `parent_version` = the
  previous latest, `patch_note: "rollback to run <id> v<n>"`), and returns the new config. It is a copy,
  not a pointer move: `GET /api/configs` shows `v6 (rollback to run X v2)`, not `v2`. 409 if a loop is
  running. Refuse if the run's `target` differs from the current `ANTIBODY_TARGET`; archives without
  `run.json` are treated as `builtin`.
  **Regression suite, decided:** rollback also **merges** `history/<id>/regression.json` into the live
  suite by scenario id (union). The live suite may then contain attacks the rolled-back config never saw;
  `check` will report those honestly as failures, and the Cycle/Results copy says "N tests are newer than
  this config". Copying the old suite over the live one would silently forget tests; not doing it.
  This is what `check` (plan 04 Step 5) and the next `run --resume` (`loop.py:343–349`) start from.
  Update the "API never writes under `runs/`" docstrings (`main.py:17`, `replay.py:21`).

### B2. UI (~3 h, UI chat 3 after A1 + B1 merge — `handoffs/ui-3-run-history.md`)

- **Heal, below the orb and the settings link:** a quiet list of past runs — date, cycles, `v0→vN`,
  accepted/rejected, world, target. Newest first, five visible, "more" expands. The golden run is
  labelled "demo tape". Clicking a run opens Results with `?source=run:<id>`.
- **Results/Cycle with a run source:** a one-line run header (the manifest fields) with two text
  actions: **"replay this run"** (starts replay with `recording=run:<id>`, goes to Agents — needs a new
  callback threaded from `App.tsx`) and **"roll back to v<n>"** on each accepted version listed from
  `GET /api/configs?source=run:<id>` (there is no chain component today; `ConfigDiff` shows one two-version
  diff). Confirm inline: "this becomes the current agent config". Hidden while a loop is running.
- Cycle's Back preserves the run source.

## Risks

- **Settings that lie.** Every field maps to a real flag; no flag, no field.
- **Archive shape drift.** Old archives lack `run.json`; `GET /api/runs` synthesises a minimal manifest
  from `cycles.jsonl` for those, or hides them if there are no cycles.
- **Rollback across targets.** Refused by the `target` check; the README says why.
- **Two UI chats touching Heal.** Chat 1 (drawer) has shipped; chat 3 rebases on it.

## Done when

- Starting from the drawer with `seeds=1, chaos=1, repair=2, until_quiet=2` writes those flags as the last `$` line in `runs/loop.log`, and the loop stops after two quiet cycles.
- With no key: Heal is disabled with the one-line message; Replay still plays; `POST /api/loop/start` returns 503.
- `chaos.loop reset` leaves `history/` intact.
- A past run appears on Heal, opens on Results, replays on Agents with the transport controls, and "roll back to v2" makes `GET /api/configs` show a new version whose `patch_note` names the run.
- Killing the API while on Agents shows the unreachable state with a working retry.
- `tsc -b` and `oxlint` clean; no new dependency.

## Decisions

**A1 + `--until-quiet` — shipped** on `feature/run-anywhere-base` (`ac482cf`).

- `LoopStartBody` lives in `api/loop_ctl.py` (where `_command` and the manifest's `defaults` need it), not `main.py`.
- Route check order: 400 "nothing to run" → 503 no key → replay-stop → 409. A body describing no work is a client error regardless of install state.
- `GET /api/loop.settings` is parsed from the last `$` line of `loop.log` (survives an API restart; scanned backwards in 64 KiB chunks, 2 MiB cap). It is `null` for a terminal-started loop and under `ANTIBODY_LOOP_CMD` — echoing a previous API run's settings under an external loop would be a lie.
- `--repair-attempts` is always emitted so the `$` line round-trips exactly. The `world: mock` env override is written shell-style on the `$` line (`ANTIBODY_NO_ZENDESK=1 uv run …`) so it is copy-pasteable; it is set in the child env only.
- Streak rule is the pure `_quiet_streak_reached(records, n, start_index)`; `start_index = len(state.records)` is taken after seeds. Two log lines: streak reached / cap hit first.
- Unknown body keys (the shipped UI's `mode`) are ignored, not 422.
- **UI delta owed** (drawer follow-up): `LoopState.mode/chaos_cycles` → `settings: RunStartBody | null`; `LoopStarted` likewise; drop `LoopMode` and the old `LoopStartBody` interface; `RunStartBody` gains `until_quiet?: number | null` and `resume?: boolean`; `Manifest.defaults: RunStartBody` can replace the duplicated defaults in `lib/settings.ts`.
- Not tested: a real `--until-quiet` run against inference (streak rule unit-tested; wiring read only); the real `uv run` spawn (Popen faked).

**B1 first half (manifests, `GET /api/runs`, `run:<id>` sources) — shipped** (`34f32a2`).

- `run.json` is written by `loop.main()` right after `start_run` (after `LoopState`, because a refusing Zendesk flips
  the world to mock there) and stores only what the process knows: `{world, target, flags, started_at}`. Everything
  countable (`cycles, accepted, rejected, versions, final_version, finished_at`) is derived at read time by
  `store.run_manifest(source)` — a file written at start can never be current. `--resume` never rewrites it.
- `target` stores the `ANTIBODY_TARGET` value verbatim (`builtin` or `http://…`), read defensively until plan 01 lands it.
- Legacy archives → `world: "mock"`, `target: "builtin"`, `flags: []`, `synthesized: true`.
- `GET /api/runs` order: live first (only if ≥1 cycle), then history **and golden sorted by date together** (golden is
  labelled `demo tape`, not pinned last). If golden was snapshotted from a run that is also in history, both appear.
  Zero-cycle folders are hidden from the list but `GET /api/runs/{id}` still returns them (the folder exists).
- `store.parse_source` is the single door: ValueError → 400, LookupError → 404. `run_dir(id)` checks the regex,
  `Path(id).name == id`, `resolve().is_relative_to(HISTORY_DIR)` and `parent == HISTORY_DIR` (refuses symlinks out).
- During a replay, `_read_source` now overrides to golden **only when `live` was asked for**; a `run:<id>` request
  is served as asked.
- Row shape is in `handoffs/ui-3-run-history.md`.
- Tests run with `uv run --with pytest pytest` on this branch (pytest is a dev dep on lane A; the lock merges once).

**A1 review fixes — shipped** (`f31f851`). Settings no longer come from parsing `loop.log`: `start()` writes
`runs/loop_settings.json` `{body, pid, started_at, cmd}` **after** `Popen` succeeds (the `$` line stays as a human
note); `LoopHandle` returns the body from memory; the backwards log scanner is gone. **Staleness rule, decided
differently from the review:** comparing the sidecar to the first `status_log.jsonl` row would null every API-started
run (the loop's first row is written seconds after spawn), so `saved_settings()` instead returns null when the loop's
own `run.json.flags` differ from `_flags(body)` — an exact signal from the process that ran. `--resume` bodies and
`ANTIBODY_LOOP_CMD` spawns skip the comparison. `loop_settings.json` and `run.json` are deliberately separate files
(API-authored vs loop-authored). **The sidecar does not move with the archive** (see the `97d2e78` note below). `until_quiet > chaos_cycles` and `resume` with no saved
config are 400s (a `model_validator` owns all body rules; `value_error`s map to 400, range errors stay 422). Under
`ANTIBODY_LOOP_CMD`, POST and GET both return the body. `NO_KEY_MESSAGE` says to restart the API.

**B1 second half (replay any run, rollback) — shipped** (`c7529ed`, 111 tests).

- `POST /api/replay/start?speed=&recording=golden|run:<id>`; `live` → 400; a folder missing `status_log.jsonl` or
  `cycles.jsonl` → 400. The 201 body is now the full `GET /api/replay` document. `recording` gains `source` and `id`;
  while active, `recorded_at/duration_s/cycles` describe the loaded tape. `store.run_paths` (public, with a `status`
  field) is the one place that knows golden vs flat shapes; replay's own golden constants are gone.
- **Rollback version numbering:** the plan's sketch `(latest_version() or -1) + 1` was a bug — it maps a real `v0` to
  `0` and would overwrite it. Shipped: `previous + 1 if previous is not None else 0`. Rolling back into an empty
  `runs/` produces `v0`.
- Response is `{config: AgentConfig, newer_tests: int}` (nested, so `api.ts` can mirror it). Error order: `live`
  400 → id 400/404 → loop running 409 → target mismatch 409 → version 404.
- `save_regression` is atomic (tmp + `os.replace`) in `chaos/state.py`; the loop benefits too.
- Empty `ANTIBODY_TARGET` counts as `builtin`. Tests share `tests/conftest.py`.
- Not tested: `run --resume` after a rollback; `newer_tests` against `check` (plan 04 Step 5 not built); target
  mismatch against a real external run.

**B1 review fixes — shipped** (`97d2e78`, 143 tests). Three blockers found by the adversarial review of `34f32a2..c7529ed`:
(1) the sidecar was in `archive_previous_run`'s movable list, so the loop child moved the *new* run's settings into the
*previous* run's folder seconds after spawn — `settings` would have been null after every real run. It now stays in
`runs/` (overwritten at the next `start()`, removed by `reset`); the `run.json` flag comparison is what catches a
terminal run in between. (2) Concurrent rollbacks overwrote `v0.json` and 500'd — `loop_ctl.runs_lock` (the start
lock, made public) is held from the running-check through both writes; `save_config(exclusive=True)` uses `open(…, "x")`
and a duplicate → 409; `save_regression` uses `mkstemp`. (3) A symlink in `history/` pointing outside 500'd
`GET /api/runs` for everyone, and a >255-char id 500'd every id route — `RUN_ID` is capped at 128, `history_runs`
skips symlinks and tolerates a folder vanishing mid-read. Also: orphaned `.incoming-*` staging dirs are finalized on
the next migration instead of deleted; a torn live `regression.json` makes rollback a 409 (never silently merges
into an empty suite); the 400 mapping is scoped to `POST /api/loop/start` body rules; `reset` refuses a `RUNS_DIR`
that has none of `configs/ status.json run.json loop.log archive/` ("does not look like an Antibody runs dir").

