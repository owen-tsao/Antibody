# Handoff — UI chat 1: Settings drawer on Heal

> Historical — superseded by `docs/plans/00-overview.md`. The drawer became the start dialog (Block 4.2).

> **Status: shipped in `f36098f`** (`SettingsDrawer.tsx`, `lib/settings.ts`). One follow-up remains, to do in
> the same chat **after backend A1 merges**: add the **Until quiet** field (off / 1–10) to the drawer and
> `toStartBody`, and change the estimate to "up to N minutes" when it is on — with until-quiet set, chaos
> cycles is a maximum, not an exact count (plan 02 A1). Everything below is the original brief, kept for
> reference.
>
> **The follow-up, concretely** (A1 is on `feature/run-anywhere-base`, `ac482cf`): in `api.ts` replace
> `LoopState.mode/chaos_cycles` and `LoopStarted.mode/chaos_cycles` with `settings: RunStartBody | null`;
> delete `LoopMode` and the old `LoopStartBody`; add `until_quiet?: number | null` and `resume?: boolean` to
> `RunStartBody`; add `defaults: RunStartBody` to `Manifest` and read drawer defaults from it. In the drawer
> add the **Until quiet** field (off / 1–10) and switch the estimate to "up to N minutes" when it is on.
> `App.tsx:133` may drop the `mode: "fixed"` spread. Server ignores unknown keys, so nothing breaks before this lands.

You are working in the Antibody repo (Vite + React 19 + TypeScript + Tailwind v4 dashboard in `web/`,
FastAPI backend in `api/`). This chat builds **one thing**: the settings drawer described in
`docs/plans/02-run-settings-and-history.md` → **Part A, section A2**. Read that plan first, then
`docs/plans/00-overview.md` for context. Do not build anything from other plans.

## Read these files, in this order, before writing code

1. `docs/plans/02-run-settings-and-history.md` — A2 is the spec; A1 defines the API contract you are sending.
2. `web/src/pages/Heal.tsx` — the page you are adding to. Note `quietLink` (line ~14) and the replay link; the drawer's trigger uses the same idiom.
3. `web/src/App.tsx` — `start(mode)` builds the `loopStart` body via `toStartBody(settings)`; the `TODO(A1)` on that line goes away once A1 lands.
4. `web/src/api.ts` — `LoopStartBody`, `loopStart`, `manifest()`. If A1 has merged, the new fields are already there; if not, code against the contract in the plan and leave a `TODO(A1)` on the one line that needs it.
5. `web/src/index.css` — `.u-line` wipe underline, type scale, `--fg/--muted/--faint/--border` tokens. Use these; add nothing new to the palette.
6. `web/src/components/OrbButton.tsx` and `web/src/components/ReplayControls.tsx` — the existing control idioms (text buttons, monochrome, `u-line`), so the drawer matches.
7. Owen's UI standard: `~/.cursor/skills/my-ui-standard/SKILL.md`.

## What to build

- A quiet "settings" text link under the Heal orb, same style as the replay link. Opens a **solid**
  right-side panel (no backdrop blur — the splash behind it is WebGL and will drop frames).
- Fields in this order: Seeds (0–all), Chaos cycles (0–10), Repair attempts (1–5), Second pass (toggle),
  Until quiet (off / 1–10 — "stop after N cycles in a row with no landed attack"), World (auto / mock).
  A read-only line at the bottom showing target and models from `manifest()`.
- Leave vertical room below the settings link: UI chat 3 adds a list of past runs there after you finish.
  Don't build any run list yourself.
- Steppers are text buttons with the `u-line` wipe. No shadcn number inputs, no new dependency.
- "about N minutes" estimate under the fields from one documented constant.
- Persist to `localStorage["antibody.settings.v1"]`; clamp ranges and drop unknown keys on read.
- Heal label becomes "Heal · 1 seed · 2 cycles" when settings differ from defaults.
- Focus trap, Esc closes, Tab reaches every field, respects `prefers-reduced-motion`.

## Boundaries

- **Owns:** `web/src/pages/Heal.tsx`, `web/src/App.tsx`, new `web/src/components/SettingsDrawer.tsx`.
- **Read-only:** `web/src/api.ts` (another chat and the backend lane add to it; if you must add a type, add it at the bottom with a `// UI1` comment and tell the user).
- **Do not touch:** `web/src/pages/Agents.tsx`, `Results.tsx`, `Cycle.tsx`, anything in `api/` or `chaos/`. Another chat owns those right now.
- Never add a dependency without asking.

## Done when

- Starting a run from the drawer with `seeds=1, chaos=1, repair=2` sends exactly those fields to `POST /api/loop/start` (check the network tab).
- Refreshing the page keeps the settings; clearing `localStorage` restores defaults.
- `npm --prefix web run build` and `npm --prefix web run lint` are clean.
- Commit with a plain-language message. Append a short `## Decisions` block to the bottom of
  `docs/plans/02-run-settings-and-history.md` if you chose anything the plan left open.

## Verification the user will run

1. `scripts/dev.sh`, open `http://localhost:5173/?page=heal`, click "settings", change Seeds to 1 and Chaos cycles to 1, press Heal, confirm `runs/loop.log`'s last `$` line shows `--seeds 1 --chaos-cycles 1` (critical; needs A1 merged).
2. Reload; settings persist (critical).
3. Tab through the drawer with the keyboard; Esc closes it (nice-to-check).
