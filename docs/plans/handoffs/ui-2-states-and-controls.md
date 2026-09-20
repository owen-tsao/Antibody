# Handoff — UI chat 2: Error states, stop-run, target line

> Historical — superseded by `docs/plans/00-overview.md`.

> **Status: shipped in `7a04986`** on branch `feature/ui-error-states` (`ApiDown.tsx`, `api.health()`,
> `loopLogUrl`, stop-run, target line rendering nothing until the manifest has `target`). Nothing left to do
> here; the backend `manifest.target` field lands with plan 01 Step 5. Original brief kept for reference.

You are working in the Antibody repo (Vite + React 19 + TypeScript + Tailwind v4 dashboard in `web/`,
FastAPI backend in `api/`). This chat builds **three small things** on the tool pages (Agents, Results,
Cycle) and nothing on Heal. Read `docs/plans/02-run-settings-and-history.md` → **Part C** and
`docs/plans/01-pluggable-target.md` → **Step 5** first, then `docs/plans/00-overview.md` for context.

## Read these files, in this order, before writing code

1. `docs/plans/02-run-settings-and-history.md` (Part C) and `docs/plans/01-pluggable-target.md` (Step 5) — the specs.
2. `web/src/pages/Agents.tsx` — status line, orbs, `StatsPlate`, the existing `api unreachable` text, the replay "stop" button style. The stop-run button and the target line go here.
3. `web/src/pages/Results.tsx` and `web/src/pages/Cycle.tsx` — need the same API-down treatment.
4. `web/src/hooks/usePoll.ts` — returns `{ data, error, refresh }`; `error` is the API-down signal and `refresh()` is what "retry" calls.
5. `web/src/api.ts` — `loop()`, `loopStop()` (exists, never called), `manifest()`. You add `health()` → `GET /api/health` (`{ok, has_api_key, …}`) if the backend lane hasn't already.
6. `web/src/components/ReplayControls.tsx` — the "stop" text button with `u-line`; the stop-run button matches it exactly.
7. `web/src/index.css` — tokens and `.u-line`.
8. Owen's UI standard: `~/.cursor/skills/my-ui-standard/SKILL.md`.

## What to build

**Three states** (designed, monochrome, same type scale as the Agents status line):

| Situation | Signal | Show |
| --- | --- | --- |
| API down | `usePoll` `error` non-null with no data | Same one-line treatment on Agents, Results, Cycle, plus a "retry" text link that calls `refresh()` |
| No `WANDB_API_KEY` | `GET /api/health` → `has_api_key: false` | On Agents when a live run is requested: one line, "Set WANDB_API_KEY to run live; Replay works without it." (Heal's version of this banner belongs to UI chat 1 — do not add it to Heal.) |
| Loop exited non-zero | `GET /api/loop` → `running: false, exit_code != 0` | Agents status line: "the loop stopped (exit N) — open log" linking `GET /api/loop/log?tail=200` in a new tab |

**Stop-run button:** in the Agents header next to the status line, only while `loop.running && !loop.external`,
text "stop run" with `u-line`, calls `api.loopStop()` then refreshes. No confirm dialog.

**Target line:** under the orbs on Agents, from `manifest().target` — e.g. "target: openai-agents via HTTP"
or "target: built-in". If the manifest has no `target` field yet (backend lane 01 Step 5 not merged),
render nothing; don't invent a fallback string.

## Boundaries

- **Owns:** `web/src/pages/Agents.tsx`, `web/src/pages/Results.tsx`, `web/src/pages/Cycle.tsx`, and additions to `web/src/api.ts` (`health()`, `Manifest.target` type).
- **Do not touch:** `web/src/pages/Heal.tsx`, `web/src/App.tsx`, `SettingsDrawer.tsx` — UI chat 1 owns them and is running in parallel. Nothing in `api/` or `chaos/`.
- Never add a dependency without asking.

## Done when

- Kill the API (`Ctrl-C` on uvicorn) while on Agents: the unreachable line appears within one poll, "retry" recovers when the API is back. Same on Results and Cycle.
- With `WANDB_API_KEY` unset and the API running, the no-key line shows on Agents.
- Start a run with `ANTIBODY_LOOP_CMD="sh -c 'exit 3'"` in the API's env: Agents shows "the loop stopped (exit 3) — open log".
- "stop run" appears only during an owned live run and stops it.
- `npm --prefix web run build` and `npm --prefix web run lint` clean. Commit with a plain-language message; append `## Decisions` to plan 02 if you chose anything the plan left open.

## Verification the user will run

1. `scripts/dev.sh`, open Agents, stop uvicorn: unreachable + retry (critical).
2. `ANTIBODY_LOOP_CMD="sh -c 'exit 3'" scripts/dev.sh`, press Heal: exit-3 line with a working log link (critical).
3. `ANTIBODY_LOOP_CMD="sleep 60" scripts/dev.sh`, press Heal, click "stop run": orbs go idle (critical).
4. Target line renders once the manifest has `target` (nice-to-check).
