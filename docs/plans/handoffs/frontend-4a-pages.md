# Handoff — Frontend lane 4A: Home, start dialog, Runs, Replays, Settings, deletions, docs (plan Block 4 items 1–5, 7, 9, plus follow-ups)

Worktree `/Users/owentsao/antibody-fe-pages`, branch `feature/app-pages`, forked from `feature/fully-connected`
at `213b154` (Blocks 1, 2, 3, 5 merged). Read `/Users/owentsao/Coreweave Hacks/docs/plans/00-overview.md` fully:
**Block 4** is the spec, and Blocks 1/2/3/5 `## Decisions` are the contracts (Block 5's Decisions include the
`api.ts` type delta you owe). Then `web/src/App.tsx`, `components/Shell.tsx`, `lib/routes.ts`, `lib/settings.ts`,
`lib/ui.ts`, `components/RunSettingsFields.tsx`, `components/SettingsDrawer.tsx`, `pages/Home.tsx`,
`pages/Onboarding.tsx`, `pages/Heal.tsx` (what you delete), `lib/previewSvg.ts` (`cycleChartSvg`), `api/store.py`
(`run_manifest`, what rows look like), `api/main.py` route catalogue. House rules:
`/Users/owentsao/Coreweave Hacks/.cursor/rules/code-organization.mdc`; UI standard
`/Users/owentsao/.cursor/skills/my-ui-standard/SKILL.md`.

## A parallel lane exists — file ownership is strict

**Lane 4B** (`feature/run-detail`) is rewriting the run page: it owns `pages/RunLive.tsx`, `pages/Results.tsx`,
`pages/Cycle.tsx`, `components/CyclesBox.tsx`, `CycleTimeline.tsx`, `ConfigDiff.tsx`, `ReplayControls.tsx`,
`PreviewRow.tsx`, `ui/interactive-list-preview.tsx`, and in `App.tsx` only the `run`/`cycle` render branches and
the replay pause/stop effect. It adds `GateResult.fix_samples/fix_passes` to `api.ts` and gate copy to `derive.ts`.

**You own everything else**: `pages/Home.tsx`, new `pages/Runs.tsx`, `pages/Replays.tsx`, `pages/Settings.tsx`,
new `components/StartDialog.tsx`, `pages/Onboarding.tsx`, `Shell.tsx`, `routes.ts`, `settings.ts`, `ui.ts`,
`SettingsDrawer.tsx` (delete it — see below), `Heal.tsx`/`Intro.tsx` (delete), `BackLink.tsx`/`OrbButton.tsx`
(delete if no caller remains after 4B — check at the end; if 4B still imports one, leave it and say so),
`docs/FRONTEND.md`. In `App.tsx` you own everything except the `run`/`cycle` branches and the replay effect.
In `api.ts` add only: `Manifest.models`, `RunRow.recording`, `RunRow.duration_s`, `LoopStartBody.vulnerability?`,
`agentPingUrl(url)`. In `derive.ts` add your functions **directly after `emptyStateFor`** (4B appends near the
gate helpers) — this keeps the merge conflict-free.

## Facts

- Routes exist for `home`, `runs`, `replays`, `settings`, `run`, `cycle` (`routes.ts:10-18`). Block 4.4 wants a
  `replay` flag on the `run` kind; **4B adds it** (`{ kind: "run"; id; replay?: boolean }` and `href` →
  `/app/runs/:id/replay`). Your Replays page links to `href({kind:"run", id, replay:true})` — coordinate by
  reading their branch if needed (`git -C /Users/owentsao/antibody-fe-run log`), else use the object literal and
  the build will tell you when their type lands at merge.
- `GET /api/runs` row: `{id, started_at, finished_at, target, agent:{id,name}|null, flags, cycles, final_version,
  recording, duration_s, world, ...}` — read `api/store.py` `run_manifest` for the exact keys; `golden` is a
  synthetic row with `recording: true`; the live row is `id: "live"`, `recording: false`, `finished_at` null while running.
- `GET /api/state?source=run:<id>` returns `vulnerability: {landed: {v0: n, vN: m}, suite_size} | null`.
  `GET /api/cycles?source=run:<id>` → `CycleRecord[]`. `state.source` is `"live" | "golden" | "replay"`.
- `POST /api/agents/ping {url}` → `PingResult` (Block 5 added it). The wizard's Connect step currently does
  create-then-ping-then-delete-on-failure; switch it to ping-by-URL then `POST /api/agents` on Save, and delete the
  `created` ref plumbing. Update the Block 3 Decisions line that described the old behaviour.
- `RunSettingsFields` is shared (drawer + wizard). `SettingsDrawer` is a fixed `aside` opened from the Runs
  placeholder and Home's "Start a run" link; `useModal` hook handles focus/scroll.
- `Manifest.models: {target, chaos, repair, judge, inference_url}`; `Manifest.defaults.vulnerability: true`.
- `ShellData` = `{loop, replay, status, statusError, health}`.
- Build/lint: `npm --prefix web run build`, `npm --prefix web run lint` (10 pre-existing warnings in `ui/*` and
  `useDwell`; 0 new). Tests: `env -u WANDB_API_KEY uv run pytest -q` (320). No `api/` edits.

## Build, in this order (build + lint clean per commit; small commits)

1. **`api.ts` delta** (yours: `Manifest.models`, `RunRow.recording/duration_s`, `LoopStartBody.vulnerability?`,
   `agentPingUrl`). Wizard Connect step → ping-by-URL; remove `created` plumbing.
2. **`StartDialog`** (`components/StartDialog.tsx`, replaces `SettingsDrawer`): a centred dialog (`useModal`),
   `RunSettingsFields` + the **agent picker** (`target`, from `agents()`, default `builtin`, shows the example
   agent as disabled with "stopped" unless `running`), the estimate line, `Heal` primary button. Submit →
   `loopStart(toStartBody(settings))` → navigate `/app/runs/live`; 409 → same; other errors inline; disabled with
   `NO_KEY_LINE` tooltip when `health.has_api_key === false`. Delete `SettingsDrawer.tsx` and its callers.
   Three call sites: Home, Runs, and (read-only defaults) Settings.
3. **Home** (`pages/Home.tsx`, replacing the placeholder; keep the first-run redirect and `ApiDown`):
   header "Home" + **Heal** top-right (the `OrbButton` becomes an ordinary `primaryButton` with the metal rim —
   use `MetalFrame` from `ui/liquid-metal-border`, radius 8; brand kept, hero gone). Body per Block 4.1:
   - agent cards: name · `final_version` of that agent's last run (`vN`) · "blocks N of M known attacks" from
     `state(source=run:<lastRunId>).vulnerability` — landed on the final version → `M - landed[vFinal]` of `suite_size`;
     "not measured" when null · last run date · sparkline via `cycleChartSvg` over `cycles(source=run:<id>)`
     (one `usePoll` per card with a long interval, or a single `useEffect` fetch — say which; ≤ 5 agents).
     Agents with no runs: card says "no runs yet".
   - **Needs attention** (only when `state.source === "live"` for the `live` read; otherwise hidden): rows from the
     latest run's cycles — landed-and-unpatched (`attack_succeeded && (!gate || !gate.accepted)`) and rejected
     (`gate && !gate.accepted`) — each row → `/app/runs/live/cycles/:n`. Functions in `derive.ts`:
     `needsAttention(cycles)`, `agentCardStats(runs, state, cycles)`.
   - **Recent runs**: five rows → `/app/runs`.
   - Empty state (agents exist, no runs): one centred line "Start your first heal" → the dialog.
4. **Runs** (`pages/Runs.tsx`): rows newest first; live first labelled "running" (or "finished · not archived"
   when `loop.running` is false and the row exists); `golden` → "demo tape"; columns: started · agent · cycles ·
   `v0→vN` · duration · status; row → `/app/runs/:id`. Primary **Start a run** → dialog. Empty: one line + the action.
5. **Replays** (`pages/Replays.tsx`): rows where `recording` (golden first, then newest); recorded date ·
   duration (`fmtClock`) · cycles · agent; **watch** → `href({kind:"run", id, replay:true})`. Empty: "Only the
   demo tape so far. Finished runs appear here."
6. **Settings** (`pages/Settings.tsx`): sections — **Run defaults** (`RunSettingsFields` bound to
   `loadSettings/saveSettings`; a "reset to defaults" text button), **Models** (the five values from
   `manifest.models`, read-only, `code` class), **Environment** (key status from `health`, `history/` path from
   `manifest` if present else omit, `weave` status). No new backend.
7. **Deletions**: `pages/Heal.tsx`, `pages/Intro.tsx` (the landing is `App.tsx`'s `landing` branch — check
   what renders `/` today; if `Intro.tsx` *is* the landing, keep it and only delete `Heal.tsx`), `REPLAY_BUSY_NOTE`
   plumbing, the Block 2 temporary route→old-page mapping, `SettingsDrawer.tsx`, `agent-new` remnants. Grep for
   dead exports after each deletion (`npx tsc --noEmit` catches imports; `rg` for the names).
8. **`docs/FRONTEND.md`** rewritten for the shell: routes table (all kinds incl. `replay`), page → data map
   (which fetchers, which intervals), what `Shell` polls, the first-run rule, the identity and replay rules
   copied from Block 4's preamble. Keep the section numbering that Python docstrings cite (`api/main.py:13`,
   `store.py:5`, `manifest.py:1`, `toolserver.py`) or update those references in the same change — you may edit
   those four docstring lines for this purpose only. Leave a `## Run page` heading with "written by lane 4B".
   `docs/HANDOFF.md` and `docs/plans/handoffs/ui-*.md` get one line at the top: "Historical — superseded by
   `docs/plans/00-overview.md`."
9. Append `## Decisions` under Block 4 in the main checkout's `00-overview.md` (absolute path; 4B appends too —
   prefix your bullets with **4A**).

## Verify in the browser (build, then `uv run uvicorn api.main:app --port 8032`, keyless, from your worktree)

- `/app/home`: Heal button with metal rim top-right; demo agent card shows golden's `v3`, "blocks 3 of 3"
  or whatever golden's vulnerability says, sparkline; Needs-attention hidden (idle API reads golden); Recent runs
  lists golden. Heal → dialog → disabled with the no-key reason.
- `/app/runs`: golden row "demo tape"; Start a run → dialog.
- `/app/replays`: golden row with 7:31 duration; watch → navigates to the run route with `/replay` suffix
  (page content is 4B's; a placeholder or the old page is fine until merge).
- `/app/settings`: three sections; change seeds, reload, persists; models show five values.
- Wizard step 2: bogus URL → error inline, and `GET /api/agents` never gains a row (ping-by-URL).
- Screenshots to `/Users/owentsao/antibody-fe-pages-screens/block4a-*.png`: home, runs, replays, settings, dialog.

## Boundaries and git

No new dependency. No `api/`, `chaos/`, `tests/`, `README.md`. Never read or print `.env`. Small commits on
`feature/app-pages`, plain-language messages. **Never push; never touch another branch.** If you need
something from 4B's branch, read it; do not merge it.

## Done when

Verify list passes; build/lint clean; 320 tests pass; report commits, screenshots, decisions, what was NOT
tested, and any file you touched outside your ownership (with why).
