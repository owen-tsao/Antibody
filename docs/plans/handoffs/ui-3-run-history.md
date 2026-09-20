# Handoff — UI chat 3: Run history on Heal, replay any run, rollback

> Historical — superseded by `docs/plans/00-overview.md` (Block 4). The API shapes below are still accurate and
> are the reference for it.

You are working in the Antibody repo (Vite + React 19 + TypeScript + Tailwind v4 dashboard in `web/`,
FastAPI backend in `api/`). This chat builds **Part B2** of `docs/plans/02-run-settings-and-history.md`:
the list of past runs below the Heal orb, and the run header with "replay this run" and "roll back to vN"
on Results. Read that plan's "The model this plan implements" and Part B first, then
`docs/plans/00-overview.md` → "The framing".

## Preconditions — check before writing code

1. **Branch:** start from `feature/ui-error-states` (or `main` after it merges). UI chats 1 and 2 have
   shipped on it (`f36098f` settings drawer, `7a04986` error states); you build on top of both.
2. **Backend 02 A1 and 02 B1 must be merged.** Confirm with `curl` that these exist, and stop and tell the
   user which one is missing if any 404s:
   - `GET /api/runs` → list including a synthetic `{id: "golden", label: "demo tape", …}` entry and the live run as `current: true`
   - `GET /api/cycles?source=run:<id>` and `GET /api/configs?source=run:<id>`
   - `POST /api/replay/start?speed=3&recording=run:<id>`
   - `POST /api/rollback` with `{run, version}` → returns the new `AgentConfig`
   - `GET /api/replay` reporting **which** recording is loaded (not just the golden date)

## The `GET /api/runs` row shape (shipped, `34f32a2`)

```ts
{ id: string;                 // "live" | "golden" | history folder name
  label: "demo tape" | null;  // only golden
  current: boolean;           // only the live row
  started_at: string | null; finished_at: string | null;   // ISO; finished_at null while live runs
  world: "mock" | "zendesk"; target: string;               // "builtin" or the ANTIBODY_TARGET URL
  cycles: number; accepted: number; rejected: number;
  versions: number[]; final_version: number | null;
  flags: string[]; synthesized: boolean;                   // synthesized = legacy archive, world/target are guesses
  configs?: { version: number; parent_version: number | null; patch_note: string }[] } // detail route only
```

Order is live first, then history + golden by date desc. Source strings: `live`, `golden`, `run:<id>`; bad ids are
400, unknown 404. Use `id === "golden" ? "golden" : id === "live" ? "live" : `run:${id}`` when building `?source=`.

## Replay and rollback shapes (shipped, `c7529ed`)

- `POST /api/replay/start?speed=<n>&recording=golden|run:<id>` → 201 with the full `GET /api/replay` document.
- `GET /api/replay.recording` now has `source: "golden" | "run:<id>"` and `id: string` — add both to `RecordingInfo`
  in `api.ts`. While a replay is active, `recorded_at`/`duration_s`/`cycles` describe the loaded tape, so the Agents
  status line already shows the right date with no change.
- `POST /api/rollback` body `{run: string, version: number}` (`run` is a runs-list id; never `"live"`) → 200
  `{config: AgentConfig, newer_tests: number}`. 409 while a loop runs or on target mismatch (show `detail` verbatim);
  404 unknown run/version. Show "N tests are newer than this config" from `newer_tests` when > 0.

## Read these files, in this order

1. `docs/plans/02-run-settings-and-history.md` — Part B1 is the API contract; Part B2 is your spec.
2. `web/src/pages/Heal.tsx` — the settings link from chat 1 is there; the run list goes **below** it, same quiet idiom. Do not restructure the drawer.
3. `web/src/App.tsx` — `start("replay")` and URL sync (`?page=&n=`, lines ~84–90). You add `?source=` handling and thread one new callback to Results: "start replay of run X, then go to Agents" (Results only receives `onAgents`/`onCycle` today).
4. `web/src/api.ts` — `Source` is `"live" | "golden" | "replay"` (line ~132); `state/cycles/config/configs` take no `source` argument. You add: `runs()`, `run(id)`, `rollback(id, version)`, a `recording?` argument on `replayStart`, and a `source?` argument on the four read helpers.
5. `web/src/pages/Results.tsx` and `web/src/pages/Cycle.tsx` — where the run header and rollback actions render when `?source=run:<id>`. Chat 2's `ApiDown` treatment is already there; keep it.
6. `web/src/components/ReplayControls.tsx` and `web/src/index.css` — text-button idiom, `u-line`, tokens.
7. Owen's UI standard: `~/.cursor/skills/my-ui-standard/SKILL.md`.

**Not a version-chain component:** `ConfigDiff.tsx` shows one two-version diff per cycle. There is no
chain UI today; you list versions from `configs(source)` (`version`, `parent_version`, `patch_note`).

## What to build

**Heal — run list** (below the orb and the settings link):
- Rows from `GET /api/runs`, newest first, five visible, a quiet "more" expands. Each row: date · N cycles · `v0→vN` · accepted/rejected · world · target. The `golden` entry is labelled "demo tape" and is always present; the live run (if any) is first, labelled "current".
- Click → Results with `?source=run:<id>` (or `?source=golden`).
- Empty state: the demo tape row alone. No "no runs yet" copy.

**Results / Cycle — run header** (only when `?source=` is a run or golden):
- One line with the manifest fields, then text actions with `u-line`:
  - **"replay this run"** → the new App callback (`replayStart(speed, "run:<id>")` then `setPage("agents")`).
  - **"roll back to v<n>"** on each version from `configs(source)` except v0's parent chain root if you prefer; confirm inline on second click ("this becomes the current agent config — confirm"), call `POST /api/rollback`, show the returned `patch_note` for a beat. Show "N tests are newer than this config" from `newer_tests` when it is > 0. Hidden while `loop.running`.
- Cycle's Back preserves `?source=`.

**Agents while replaying a run:** already shows `· replay · recorded <time>` from `state.recorded_at`
(`Agents.tsx` ~162, ~250). **Verify it reads the archived run's time once B1's replay reports the loaded
recording; do not edit `Agents.tsx`.**

## Boundaries

- **Owns:** `web/src/pages/Heal.tsx` (below the settings link only), `Results.tsx`, `Cycle.tsx`, `App.tsx` (`?source=` and the one new callback), `api.ts` additions.
- **Do not touch:** `SettingsDrawer.tsx`, `lib/settings.ts`, `Agents.tsx`, `components/ApiDown.tsx`, anything in `api/` or `chaos/`.
- Never add a dependency without asking. No new colours; monochrome, same type scale as the Agents status line. Rebase, don't merge, if the branch moves under you.

## Done when

- A past run appears on Heal, opens on Results, and its cycles open on Cycle with the source preserved.
- "replay this run" plays that run on Agents with the transport controls; the status line shows that run's recorded time, not the golden one.
- "roll back to v2" produces a new entry in `GET /api/configs` whose `patch_note` names the run; the action is absent while a loop runs.
- `npm --prefix web run build` and `npm --prefix web run lint` clean. Commit **only your files** with a plain-language message; append `## Decisions` to plan 02 if you chose anything the plan left open.

## Verification the user will run

1. `scripts/dev.sh`, Heal: the demo tape row and at least one archived run are listed (critical; needs `history/` populated — run the loop once or copy an archive in).
2. Click a run → Results shows its cycles; open a Cycle; Back returns to the same run (critical).
3. "replay this run" → Agents plays it; the status line shows that run's date (critical).
4. "roll back to v1" → `curl localhost:8000/api/configs` shows the new version (critical).
5. Start a live run; rollback actions disappear (nice-to-check).
