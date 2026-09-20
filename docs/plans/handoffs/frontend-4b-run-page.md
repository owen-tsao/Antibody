# Handoff — Frontend lane 4B: the run page — live, finished, replay, rollback, cycle (plan Block 4 items 6, 8, 10)

Worktree `/Users/owentsao/antibody-fe-run`, branch `feature/run-detail`, forked from `feature/fully-connected`
at `213b154`. Read `/Users/owentsao/Coreweave Hacks/docs/plans/00-overview.md` fully — **Block 4** is the spec
(the two rules in its preamble, *identity* and *replay*, are decided; do not relitigate), and Blocks 1/2/3/5
`## Decisions` are the contracts (Block 5's include the `GateResult` delta you owe). Then `web/src/App.tsx`,
`pages/RunLive.tsx` (today's live view: stats plate, orbs, cycles box), `pages/Results.tsx` (the list + seed
preview), `pages/Cycle.tsx`, `components/ReplayControls.tsx`, `CyclesBox.tsx`, `CycleTimeline.tsx`,
`ConfigDiff.tsx`, `ui/interactive-list-preview.tsx`, `lib/derive.ts`, `lib/routes.ts`, `api.ts`, and on the
backend `api/main.py` (`/api/runs/{id}`, `/api/rollback`, `/api/replay/*`, the `source` override), `api/replay.py`
(`start(recording=...)`, `ended`), `api/rollback.py`. House rules:
`/Users/owentsao/Coreweave Hacks/.cursor/rules/code-organization.mdc`; UI standard
`/Users/owentsao/.cursor/skills/my-ui-standard/SKILL.md`.

## A parallel lane exists — file ownership is strict

**Lane 4A** (`feature/app-pages`) builds Home, the start dialog, Runs, Replays, Settings, deletes `Heal`/
`SettingsDrawer`, rewrites `docs/FRONTEND.md`. It owns `Shell.tsx`, `settings.ts`, `ui.ts`, `Onboarding.tsx`,
`Home.tsx`, and in `App.tsx` everything except your branches. In `api.ts` it adds `Manifest.models`,
`RunRow.recording/duration_s`, `LoopStartBody.vulnerability?`, `agentPingUrl`. In `derive.ts` it adds after
`emptyStateFor`.

**You own**: `pages/RunLive.tsx` → becomes `pages/Run.tsx`, `pages/Results.tsx` (fold in, then delete),
`pages/Cycle.tsx`, `components/CyclesBox.tsx`, `CycleTimeline.tsx`, `ConfigDiff.tsx`, `ReplayControls.tsx`,
`PreviewRow.tsx`, `ui/interactive-list-preview.tsx`, `lib/previewSvg.ts`. In `App.tsx` only the `run`/`cycle`
render branches and the replay pause/stop effect (`App.tsx` ~71-77). In `routes.ts` only: add `replay?: boolean`
to the `run` kind, parse `/app/runs/:id/replay`, emit it in `href`. In `api.ts` only: `GateResult.fix_samples`,
`GateResult.fix_passes`, and any `source` parameter a read fetcher still lacks. In `derive.ts`: add near the gate
helpers (`~:569-610`, `~:877`), not at the file end. In `docs/FRONTEND.md`: only the `## Run page` section
(4A leaves the heading). `BackLink.tsx`/`OrbButton.tsx`: stop importing them; 4A deletes the files.

## Facts

- `GET /api/runs/{id}` → the run row (`agent`, `flags`, `final_version`, `started_at`, `finished_at`, `recording`,
  `duration_s`, `world`, ...); 404 for `live` until `run.json` lands (treat 404-while-`loop.running` as "starting…").
- Reads: `cycles(source)`, `state(source)`, `configs`/`config(v, source)` — check which fetchers already take
  `source: ReadSource` (`"live" | "golden" | "run:<id>"`) and add it where missing. `/api/status` has no source.
- During a replay, only `live` reads are overridden by the tape (`api/main.py` `_read_source`); `run:<id>` reads
  are served as asked. Hence the replay rule: while watching, the page reads `live` + `/api/status` and shows
  `ReplayControls`; when the replay stops or the user leaves, back to `run:<id>` reads.
- `POST /api/replay/start {speed, recording: "golden" | "run:<id>"}` → 201 `ReplayInfo`; 409 if one is mid-play;
  `ended: true` freezes on the last frame until `stop`. `POST /api/replay/stop`, `/pause`, `/resume`, `/seek`, `/speed`.
- `POST /api/rollback {run, version}` → `{config, newer_tests}`; `config.patch_note` reads "rollback to run <id> v<n>";
  400 for `live`; 409 while a loop runs or on a target mismatch; the new config becomes `v(latest+1)`.
- `GateResult` on the backend now has `fix_samples` and `fix_passes` (old records: `fix_samples: 1`,
  `fix_passes: 0|1`). Gate copy: "fixed 2/2" on accept; "fixed 1/2 — not accepted" on reject where `fix_passes <
  fix_samples`; when `fix_samples === 1` keep today's wording.
- `Status.measuring` can now be `"vulnerability"` at the end of a run (Block 5 Decisions): the `baseline` orb lights
  and the label should read "measuring vulnerability" (today's derive reads "measuring baseline").
- `LoopState.settings.target` names the run's agent; `RunRow.agent` names a history run's. Transport check uses
  `"in-process"` (backend value), never `"builtin"` — that is the owed fix in Block 4.8.
- Shell provides `ShellData = {loop, replay, status, statusError, health}`; do not add polls for those.
- Build/lint: `npm --prefix web run build`, `npm --prefix web run lint` (10 pre-existing warnings; 0 new). Tests
  `env -u WANDB_API_KEY uv run pytest -q` (320). No `api/` edits.

## Build, in this order (build + lint clean per commit; small commits)

1. **`api.ts`**: `GateResult.fix_samples/fix_passes`; `source` on any read fetcher missing it. `derive.ts`: gate
   copy (`gateLine`/gate criteria helpers), `measuring: "vulnerability"` label, `seedAttackAvailable` (keep 4A's
   `loop.settings.target` half; the transport half compares `"in-process"`).
2. **Route flag**: `run.replay?: boolean`, `/app/runs/:id/replay`.
3. **`pages/Run.tsx`** = `RunLive.tsx` + `Results.tsx` merged into one source-aware page, props `{ id, replay,
   shell: ShellData, navigate }`. Derive `mode` in `derive.ts` (`runMode(id, row, loop, replay)` → `"starting" |
   "live" | "finished" | "watching"`), then:
   - **starting**: 404 on `runs/live` while `loop.running` → the stats plate says "measuring baseline…" as today.
   - **live** (`id === "live"` and `loop.running`, or the un-archived finished run): today's `RunLive` content
     (plate, orbs, cycles box, stop) + **Results so far** = today's `Results` list below (same page, one scroll).
     Seed preview only when `seedAttackAvailable`.
   - **finished** (history row, or `live` with `loop.running === false`): header line `started · agent · world ·
     flags · v0→vN`; actions as `u-line` text: **watch it back** (starts replay of `run:<id>` at 3× → mode
     `watching`), **roll back to v<n>** on each version except the latest live one (inline confirm on second
     click → `rollback({run: id, version})` → show `patch_note` + "N tests are newer" from `newer_tests`; hidden
     while `loop.running`; disabled for `golden`? — check whether the backend accepts `golden` as a `run` for
     rollback and follow it); then the Results list. Cycles box in expanded, non-live styling (no pulsing).
   - **watching**: reads flip to `live` + `status`; `ReplayControls` in the header; the plate/orbs animate from the
     tape as today's live view does; **stop** → `replayStop()` → mode back to `finished` with `run:<id>` reads.
     Leaving the page (route change or unmount) → `replayStop()`, replacing App's pause-on-leave effect — one
     mechanism, in `App.tsx`'s effect, keyed on the route no longer being `run`/`cycle`: **stop**, not pause. The
     Heal-page "resume replay" affordance goes with `Heal.tsx` (4A deletes it); Replays page is how you re-watch.
   - `golden` is a history row for reading (`source: "golden"`), never `run:golden` — read `api/store.parse_source`.
4. **`pages/Cycle.tsx`**: takes `source` from the route (`id` → `ReadSource`), threads it through `cycles`, `state`,
   `ConfigDiff` (`ConfigDiff.tsx:~35` today hard-codes live — check), and reads `fix_samples/fix_passes` for the gate
   block. Back → the run. Uses the shell (no `BackLink`).
5. **Owed fix 4.8** (`"in-process"` not `"builtin"`) wherever the transport is compared.
6. **`App.tsx`**: `run`/`cycle` branches render `Run`/`Cycle` with `replay` from the route; the replay effect
   becomes stop-on-leave. Delete `RunLive.tsx`/`Results.tsx` imports and files; drop `BackLink`/`OrbButton` imports
   from your files.
7. **`docs/FRONTEND.md` `## Run page`** section: modes, reads per mode, the replay rule, rollback flow.
8. Append `## Decisions` under Block 4 in the main checkout's `00-overview.md` (absolute path), bullets prefixed **4B**.

## Verify in the browser (build, then `uv run uvicorn api.main:app --port 8033`, keyless, from your worktree)

- `/app/runs/golden`: finished header (`v0→v3`, demo agent, world), watch-it-back + roll-back actions, Results list
  with seven rows; a row → `/app/runs/golden/cycles/3` shows the cycle with `source` golden (config diff loads);
  Back → run.
- **watch it back** → controls appear, plate/orbs/cycles box animate; stop → back to the static finished view with
  7 rows immediately (no flash of `live` data); navigating to `/app/agents` mid-replay → `GET /api/replay` shows
  `active: false`.
- `/app/runs/golden/replay` deep link → starts watching directly.
- `/app/runs/live` keyless and idle → not "starting"; shows whatever `live` resolves to (golden fallback) as a
  finished view — say what it shows and whether the identity rule's wording is right for that case.
- Gate copy: pick a golden cycle whose gate accepted → "fixed 1/1" or today's wording (old record); no "fixed 1/2".
- Rollback: `POST` a rollback from the UI on golden v1 (keyless is fine — it copies a config) → the note and "N
  tests are newer" appear; `GET /api/runs/live` or configs shows the new version. Then `uv run python -m chaos.loop
  reset` in your worktree to clear `runs/` (say you did).
- Screenshots to `/Users/owentsao/antibody-fe-run-screens/block4b-*.png`: finished, watching, cycle, rollback confirm.

## Boundaries and git

No new dependency. No `api/`, `chaos/`, `tests/`, `README.md`. Never read or print `.env`. Small commits on
`feature/run-detail`, plain-language messages. **Never push; never touch another branch.** If you need something
from 4A's branch, read it (`git -C /Users/owentsao/antibody-fe-pages log`); do not merge it.

## Done when

Verify list passes; build/lint clean; 320 tests pass; report commits, screenshots, decisions, what was NOT
tested (a live run needs the key — say so), and any file touched outside your ownership (with why).
