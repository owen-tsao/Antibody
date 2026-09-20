# 07 — App rework: one product surface (Sep 19)

> **Superseded by `08-rework-round-2.md`** for cards, dropdowns, Current run's faces, Home and See results;
> the page anatomy, routes and shell decisions here still stand.

Owen's review of the Block 4 build, in his words: every page needs a rework; pages "look like they're
floating in the air"; too much animated underline and animated metal; the green dot and `[` shortcut go;
Home and the tabs should not be separate ideas; Runs and Replays are the same thing; Agents should be cards
not a list; Settings needs to be a real settings page. Reference screenshots (Clad app settings/integrations/
customers, the 21st.dev bento and condition grids) are in
`/Users/owentsao/.cursor/projects/Users-owentsao-Coreweave-Hacks/assets/` (Sep 19). This plan replaces
Block 4's page designs; the backend, routes machinery, run-page modes, replay rule and identity rule from
`00-overview.md` all stand. Owen approved (Sep 19): Phosphor icons; per-run version slider with a run picker
(versions reset to v0 each run, so there is no per-agent lineage without backend work — deferred).

## Diagnosis — why it floats

Every tool page today is: serif 48 px title at the top-left of a 1040 px column, a few lines of 13 px text,
then a hairline table or a card, and 60% of the viewport empty. The rail is a different black from the
content but the content has no floor: nothing gives the page edges, a header band, or a working area. In
the Clad screenshots each page has (a) a fixed-height header row with the title and the page's one action,
(b) a content area that is a *surface* (cards on a tinted floor, a bordered table, grouped sections with
dividers), and (c) consistent 24/32 px gutters so things share edges. That is what we copy — structure, not
looks; our looks stay monochrome per Owen's UI standard.

## Decisions (this is the spec; everything below serves it)

1. **One shell, one navigation.** Rail items, one group: **Home · Agents · Current run · Runs**;
   **Settings** is the bottom block (Linear's pattern). `/app` → `/app/home`. *Correction (9:38 PM):* an
   earlier draft read Owen's "don't separate home and the other tabs" as "no Home page" and deleted it —
   wrong; he meant one nav group. Home is §12 below. First-run rule lives in `App.tsx` for every shell
   route (nothing connected → `replace(onboarding(1))`).
2. **Rail** is the 21st.dev `dashboard-sidebar` shape (the pasted prompt is archived in the component
   library as `prompts/dashboard-sidebar-integration.md` alongside this plan; it is a *shape* reference —
   the mock data, search, plan label, badges and shortcuts are not ours): 260 px, a top block (Antibody
   wordmark + the *selected agent* as the "workspace switcher" — click to switch), grouped nav with 11 px
   uppercase headings, bottom block (Settings · key status line). It stays JSX inside `Shell.tsx` (the
   existing `rail()` closure already serves both the desktop rail and the mobile overlay — that is the
   reuse; no new `SidebarNav` file). Collapse via a `SidebarSimple` icon button at the top-right of the rail itself (when collapsed, the same
   button floats top-left of the content); **no keyboard shortcut**. Collapsed is a separate state from the
   existing mobile overlay, which stays as is. No dot anywhere. "Current run" gets the word `running` in `--muted` after the label while
   a loop runs, nothing otherwise. The switcher reuses `StartDialog`'s target mapping (`null` → builtin,
   stale id → builtin, `settings.ts:22`); it never compares `LoopState.settings.target` (an id) with
   `LoopStarted.target` (canonical name).
3. **Icons: Phosphor** (`@phosphor-icons/react`, regular weight, 16 px in nav, 20 px in headers) —
   **approved by Owen (Sep 19)**. Icons appear only where they carry meaning: nav items, the sidebar
   toggle, check/minus states, the copy button. **Agents never get an icon** — a demo agent, the example
   agent and a connected agent are represented by one tile rule (`AgentTile`, §11: Antibody glyph /
   official OpenAI mark / initial monogram on the agent's gradient), never `Sparkles`/`Server`/`Globe`-
   style glyphs; that is the "AI-generated" tell Owen called out. Rule promoted
   to `.cursor/rules/ui-style.mdc` (see §Rules).
4. **Motion budget.** `u-line` wipe underline stays only on a surface's **one primary text action**:
   Current run finished → "See results"; run detail → "watch it back"; cycle page → "Trace in Weave";
   wizard → "Skip for now". Agents, Runs and Settings have none (their actions are buttons, rows, or
   controls). Every other link is a plain `hover:text-fg`. **Liquid metal
   animates only where something is live**: the cycles box while a loop or replay runs, the Heal orb. All
   other metal rims are a **static CSS chrome gradient** (`MetalFrame static` — a `conic-gradient` rim,
   no WebGL) so the look is kept and the GPU is not.
5. **Page anatomy, shared by every shell page** (`components/Page.tsx`, new; call sites: Agents, Agent, Run,
   Runs, Settings, Cycle — the wizard keeps its own centred layout, §11): header row 56 px — title (Inter 20/600, *not* serif; serif stays on the landing) left, the
   page's single primary action right (optional — Runs and Settings have none), hairline below; content area `px-8 py-6`, max-width 1200. Tables
   stay **hairline-framed, not boxed** (UI standard §8; today's `Runs.tsx` is already right — what it lacks
   is the header row and gutters, not a box). Cards (`--card`, 1 px `--border`, radius 10) are only for
   genuinely parallel objects: agent cards. Section headers 11 px uppercase faint. Spacing scale
   8/12/16/24/32 only.
6. **Agents page = grid of agent cards** (`ui/bento-grid-dark` adapted: image backdrop → a static
   monochrome-plus-one-hue gradient per agent, hue hashed from the agent id so cards differ; caption
   panel → name, transport, last run, `vN`, "blocks N of M" from `agentCardStats` + the `/api/state`
   read Home does today; static metal rim). Agents are genuinely parallel items, which is the one case
   the UI standard allows a card grid. **Equal cards** — selection is shown by a `--border-2` rim, not a
   size change — sorted running/last-run first, then most recent, then a dashed "Connect agent" card.
   Emphasis budget: the **Heal** button (top-right, the standard inverted primary pill — *not* the orb; the
   orb lives only on Current run idle) is the page's one loud element; rims are static, the Connect card
   is dashed and quiet. Card → `/app/agents/:id` (§7). Heal → `StartDialog` with the selected agent preset →
   `/app/run`. Fresh install shows built-in + example + Connect (three cards, 3-col row) — checked at
   1280/1440 in the kill conditions.
7. **Agent detail page `/app/agents/:id`** — the "results" home. **Data fact that shapes it:** config
   versions restart at v0 on every run (`chaos/state.py:301`), so "the agent's v3" only means something
   *within one run*. The page is therefore: header band (agent gradient + name + transport) with a **run
   picker** (quiet select, latest run preselected, rows from `GET /api/runs` via `runsForAgent(rows, agent)` in `derive.ts`, which matches `row.agent.id`
   for connected agents and `row.target === "builtin"` for the demo agent, whose rows carry no `agent`),
   then the **`RunResults` body** for that run: a **version slider** (`v0 … vN` from `row.versions`, a
   hairline track with tick stops, arrow keys, click a tick), a stat row for the selected version (attacks
   under this version: blocked / total, legit pass rate from the last gate, patches accepted so far,
   `patch_note`), the cycle list filtered to `config_before == v` (attacked under) with the cycle that
   produced `v` (`config_after == v`) pinned first and labelled, and a "Config" disclosure that renders the existing `ConfigDiff` with the cycle whose
   `config_after == v` (its current `cycle` prop — no new fetch path; rollback versions have no such cycle
   and show "copied from vK" instead). `RunResults` is **also the finished-face body of `/app/runs/:id`** (two call
   sites; replaces that page's flat results list) so there is one results surface, not two. Data: `GET
   /api/runs`, `GET /api/runs/:id` (configs, `parent_version`, `patch_note`), `GET /api/cycles?source=
   run:<id>|live|golden`, `GET /api/config/:v?source=`. No new backend routes. Rollback versions (no
   cycles) show "copied from vK".
8. **Current run `/app/run`** always exists. Idle: the agent switcher line + the **Heal orb** (the one
   animated metal surface when idle; the one loud element) centred, and nothing else — the keyless golden
   "fallback" copy from `Run.tsx:387` becomes one muted line under the orb. Running/starting/watching:
   today's `Run` page live face — stats plate, orbs, cycles box — **without** the results list and the
   seed-attack preview footer underneath (`Run.tsx:551-571`; the preview, `runAttack`, `DEMO_SEED_*` and
   `seedAttackAvailable` are deleted with it — `api.attack` keeps its one caller in the wizard, or is
   removed if it has none; check). Finished (un-archived `live`): the same face frozen, plus one primary
   text action **See results →** `/app/agents/:id` (run picker on `live`, slider on the final version).
   That is the only `u-line` on the page; the cycles box rim goes static once the loop ends, so the page
   has one loud element in every mode. Stop-on-leave and the replay rule unchanged in behaviour;
   `App.tsx:60` (`runOnScreen`) and `Shell.tsx:135` must learn the new route kind. `/app/runs/live` →
   `/app/run`.
9. **Runs `/app/runs`** = today's Runs and Replays merged: one hairline table: started · agent · cycles ·
   `v0→vN` · duration · status · **watch** (only for `recording: true`). Row → `/app/runs/:id`, whose
   finished face uses the shared `RunResults` body (§7). Order is today's `GET /api/runs` order (live
   first, then by start time) — the demo tape is *labelled*, not pinned, so the list has one ordering
   rule. Replays page and route deleted. No "Start a run" here.
10. **Settings `/app/settings/:section?`** — grouped sections in the Clad pattern: a left sub-nav (**Run
    defaults · Display · Models · Environment**) and a content column showing one section, each a list of
    setting rows (label + one-line description left, control right, hairline between). The row is
    `RunSettingsFields`' existing row, reworked in place — that component already has three call sites
    (Settings, wizard step 4, `StartDialog`) and keeps them; no new `SettingRow` file. Controls: numbers
    via a styled native `<select>` with the allowed values (`SEEDS`/`CYCLES` bounds from `settings.ts`,
    seed count from the manifest), booleans via a hand-rolled switch (`role="switch"`, ~40 lines) — JSX inside `RunSettingsFields`,
    not a new file, text via inputs. No steppers, no `+/–`, no dots: key status is the word "set"/"missing" in
    `--muted`/`--danger`. **Run defaults** (exist, map to loop flags): seeds, chaos cycles, repair
    attempts, second pass, until quiet, **vulnerability measurement** (new; `LoopStartBody.vulnerability`
    exists, `toStartBody` must send it), default agent. **Display** (new, *not* loop flags — so they live
    in a separate `lib/prefs.ts` + `antibody.prefs` localStorage key, keeping `settings.ts`'s "every field
    is a flag" contract intact): replay speed default (replaces the `REPLAY_SPEED = 3` constant in
    `Run.tsx:52`), poll cadence normal/slow (a multiplier read by a small `PrefsContext`, applied inside
    `usePoll` so no call site changes), reduced-motion override (one `hooks/useMotionPref.ts` that the 17 `useReducedMotion` call sites and the
    two local `usePrefersReducedMotion` copies switch to; provider mounted in `App.tsx`). **Models** and
    **Environment** read-only as today.
11. **Onboarding `/app/onboarding/:step`** — the layout stays what it is (centred column, step rail across
    the top, "Skip for now" top-right): Owen's reference (Clad onboarding, screenshots
    `ref-clad-onboarding-step1/2.png`) is exactly that shape, so the fix is polish, not structure.
    What changes, step by step against the reference:
    - **Choice cards** become the Clad card: `--card` surface, 1 px `--border` (→ `--border-2` + a
      `Check` circle top-right when selected), radius 12, padding 20, a **28 px tile** top-left holding a
      *real mark*, then title (13/500) and a one-line body in `--muted`. Tiles: **Demo agent** → the
      Antibody "A" wordmark glyph; **Example agent** → the OpenAI logo (official SVG, monochrome, ~1 KB,
      in `web/public/marks/`; it *is* an OpenAI Agents SDK agent, and the UI standard says use official
      brand assets); **Your own** → Phosphor `Plugs`. No `Sparkles`/`Server`/`Globe`. Card widths equal,
      two or three across, max 640 total.
    - **Title block**: eyebrow 10.5 px uppercase faint ("STEP 1 OF 4 · CHOOSE"), title 24/600 with
      −0.48 px tracking, sub 13 px `--muted`, all centred — as today but with the reference's spacing
      (eyebrow → title 12, title → sub 8, sub → cards 32).
    - **Footer**: `← Back` quiet left, **Continue →** as the only primary (dark pill; disabled = 40%
      opacity, no colour change). No `u-line` in the wizard except "Skip for now".
    - **Step rail** (`WizardRail`) keeps its spring; steps rendered as small numbered discs joined by
      hairlines, filled disc + check when done, exactly the reference's top strip.
    - Step 2's `Contract` snippet → a disclosure under the form; step 3's tool list → check/minus rows
      served-first; step 4 keeps `RunSettingsFields` (§10) and Heal lands on `/app/run`.
    The rail switcher and the Agents grid reuse the **same tile rule** (monogram for a connected agent's
    initial, OpenAI mark for the example, Antibody glyph for the demo), so an agent looks the same in the
    wizard, the rail and its card.
12. **What leaves**: Home page, Replays page, `[` shortcut, the rail dot, `u-line` on non-primary links,
    animated metal on cards/buttons, the Runs page "Start a run" (Heal lives on Agents and Current run),
    the results list under the live face and its seed-attack preview (`runAttack`, `DEMO_SEED_*`,
    `seedAttackAvailable`), the `REPLAY_SPEED` constant, `runSource`, `previewSvg.sparkline`, `lucide-react`,
    the `/app/runs/live` address, the `Sparkles`/`Server`/`Globe` icons on choice cards.

12. **Home `/app/home`** — *one agent, right now, one action* (Agents is the fleet, Agent detail is
    history, Current run is now). Everything on it is filtered to the selected agent. Built from
    **structured panels** in the shape of Clad's home (`component-library/screenshots/ref-clad-home.png`:
    a title row, hairline rows, a trailing `→`; *not* its layout) — **none of the old Home's surfaces**
    (its agent cards, sparkline, attention list and recent-runs table are gone and stay gone).
    - `components/Panel.tsx` (new; call sites: Home ×3, Agent detail, Settings sections): `rounded-xl`
      hairline card on `--card`, a 44 px title row (title left, optional right slot), body slot.
    - Layout: `Page` title "Home", eyebrow = today's date. Content grid `[1fr_360px]` (stacks below `lg`).
    - **Left: the agent card** — a `Panel` with a `MetalFrame static tint={hue}` rim (the same look as an
      agent card in the grid). Header = `AgentSwitcher size="card"` (tile 40 + name + transport; click to
      switch). Stat row from the agent's last run: `v0 → v3` · `blocks 3 of 4 known attacks` · `legit users
      11/11` · last run date (`agentCardStats`, `versionSpan`, `runsForAgent` in `derive.ts`); no runs →
      "never attacked". Centre: the **Heal orb** (`OrbButton`, the one animated metal on the page) with
      the estimate line under it (`estimateLabel(settings)` + "change" → Settings). Press → `POST
      /api/loop/start` with `toStartBody({...settings, target})` → `/app/run`; 409 → `/app/run`; no key →
      disabled with the reason. While the loop runs the orb is replaced by a status line ("running · cycle
      4" → Current run); while a tape plays, "watching" → that run.
    - **Right, top: Needs attention** — cycles of this agent's latest run where the attack landed and no
      patch was accepted (`needsAttention(cycles)`, rewritten: `{cycle, title, why: rejected|unpatched}`);
      row = title, `cycle N · rejected by the gate` / `· never patched`, `→` → the cycle page. Empty:
      "Nothing outstanding — every attack that landed was patched." No run: "Heal to find out."
    - **Right, bottom: Recent runs** — the last three of this agent: date · `v0 → vN` · cycles · `→` →
      `/app/runs/:id`; footer "all runs →" → Runs (→ Agent detail once step 4 lands).
    - Data: `agents`/`runs`/`loop`/`replay`/`health` from the shell; one `usePoll(api.cycles(source), 10 s)`
      + one `api.state(source)` read for the last run, where `source = readSource(lastRun.id)`.
    - Emphasis budget: the orb is the page's one loud element; panels are quiet; no `u-line`.

## Routes after the rework

| Path | Page |
| --- | --- |
| `/` | landing (unchanged) |
| `/app`, `/app/home` | Home: agent card (switcher · stats · Heal orb) · Needs attention · Recent runs (or wizard on first run) |
| `/app/agents` | bento of agents; Heal |
| `/app/agents/:id` | agent detail: run picker → `RunResults` (version slider, stats, cycle list) |
| `/app/run` | current run (idle orb / live / finished → See results) |
| `/app/runs` | all runs, watch per recording |
| `/app/runs/:id` | finished face with watch/rollback; body is `RunResults` |
| `/app/runs/:id/replay`, `/app/runs/:id/cycles/:n` | unchanged (4B) |
| `/app/settings/:section?` | settings; `run-defaults` (default) · `display` · `models` · `environment` |
| `/app/onboarding/:step` | wizard (restyled to the new anatomy; steps unchanged) |
| `/app/replays`, `/app/runs/live` | redirects |

## Work, in order (frontend unless marked; ~42 h)

Each step ends `tsc -b` + `vite build` + `pytest` clean (there is no frontend test runner; the browser walk
in step 9 is the frontend test). Owen reviews and commits; steps are the natural commit boundaries.

1. **Foundations + routes (8 h; one step so the tree compiles at its end). — DONE.**
   - `routes.ts`: kinds `agent` (`/app/agents/:id`); Current run is the existing `run` kind with `id: "live"`
     given its own address `/app/run` (no new kind — `Run.tsx` and `runOnScreen` already key off the id); `settings` gains
     `section` (`run-defaults | display | models | environment`); `home`/`replays` kinds removed; a
     **redirect table** applied in `redirectLegacy` *and* `parse` (`/app/home` → agents, `/app/replays` →
     runs, `/app/runs/live` → `/app/run`) so `href`/`parse` stay inverses. Update every `HOME`/`LIVE_RUN`
     import (`StartDialog.tsx:81-90`, `Onboarding.tsx:244-279`, `Shell.tsx:141`, `App.tsx:39`);
     `App.tsx` `runOnScreen` unchanged; the first-run effect moves from `Home.tsx:60` to
     `App.tsx` (guarding every shell route). Until step 4 lands, `agent` renders the `Agents` list, so nothing dangles.
   - `components/Page.tsx` (new: header row with optional action, content area); `components/AgentTile.tsx`
     (new: tile rule — Antibody glyph for the demo agent, the initial for every other agent, **no OpenAI
     mark**: Simple Icons has withdrawn it and a hand-drawn brand mark is not shippable; call sites this step:
     rail switcher and wizard cards; later: grid, agent header);
     `MetalFrame` gains `static` (skips the canvas mount entirely; CSS conic rim) and `tint` — **spiked
     first, see kill conditions**; `index.css` anatomy tokens.
   - `Shell.tsx`: rail rebuilt (switcher via `AgentTile`, three nav rows, Settings bottom block, collapse
     button, no `[` handler, no dot). Settings link → `run-defaults`.
   - Icons: `npm i @phosphor-icons/react`; sweep every `lucide-react` import (`Shell`, `Onboarding`,
     `WizardRail`, `ui/*`) with this table: `Check→Check`, `Copy→Copy`, `ChevronDown→CaretDown`,
     `ChevronRight→CaretRight`, `X→X`, `PanelLeftClose→SidebarSimple`, `Sparkles/Server/Globe → AgentTile`
     (wizard cards get the tile now; the rest of the card restyle is step 7). Then `npm uninstall
     lucide-react` in the same step.
   - `u-line` sweep (36 occurrences in `.tsx`): keep the three that exist today (watch it back, Trace in
     Weave, Skip for now); See results arrives in step 4. **Done.**
   - Delete `Home.tsx`, `Replays.tsx`, and their orphans (`needsAttention`, `replayRows`, `replaysLine`,
     `lastRunFor`, `runSource` — duplicate of `readSource`, which survives — and `previewSvg.sparkline`).
     Runs gains the watch column in this step so `/app/replays` never redirects to a page without it.
   - `FRONTEND.md` shell/routes/run-page/start-a-run sections rewritten.
2. **Home (4 h). — DONE, awaiting review.** `components/Panel.tsx`; `components/AgentSwitcher.tsx` (extracted from the rail so
   the Home card and the rail share one switcher — done); `HOME` route back; `pages/Home.tsx` new per §12:
   card (switcher · stat row · orb · estimate) + Needs attention + Recent runs. `derive.ts`:
   `runsForAgent`, `needsAttention` (rewritten). `Run.tsx` untouched.
3. **Agents grid (4 h). — DONE, awaiting review.** Adapt `bento-grid-dark`; `agentGradient(id)`, `agentsSorted(...)`,
   `runsForAgent(...)` in `derive.ts`; carry Home's `/api/state` read for the version; equal cards,
   selection rim, `AgentTile` in each; dashed Connect card; Heal (primary pill) → `StartDialog` with
   `target` preset → `/app/run`.
4. **RunResults + Agent detail (9 h). — DONE, awaiting review.** `components/RunResults.tsx` (call sites: `Agent.tsx`, `Run.tsx`
   for `/app/runs/:id` only — *not* `/app/run`, whose finished face is the frozen live face + See results):
   version slider (own file only if it grows past ~80 lines; else JSX inside `RunResults`), stat row,
   filtered cycle list, Config disclosure via the existing `ConfigDiff` with the producing cycle.
   `derive.ts`: `versionsOf(row)`, `statsForVersion(cycles, v)`, `cyclesForVersion(cycles, v)`,
   `versionNote(configs, v)`. `pages/Agent.tsx`: header band with `AgentTile`, run picker, `RunResults`,
   empty states (no runs → one line + Heal; unknown id → "no such agent").
5. **Current run (3 h). — DONE, awaiting review.** `Run.tsx` for `id === "live"`: idle face (switcher + orb + one muted fallback
   line), loses the results list and seed-preview footer (and `runAttack`, `DEMO_SEED_*`,
   `seedAttackAvailable`; `api.attack` stays only if the wizard still calls it), finished face gets **See
   results** → `/app/agents/:id`; `runMode` gains `idle`; cycles box rim static once not running.
6. **Runs polish (1 h). — DONE, awaiting review.** Tape label, header row via `Page`, column alignment (watch column landed in 1).
7. **Settings (6 h). — DONE, awaiting review.** Sub-nav + sections + section-in-path; `RunSettingsFields` rows reworked to native
   `<select>` + inline switch (all three call sites inherit); `vulnerability` in `RunSettings` +
   `toStartBody`; `lib/prefs.ts` + `PrefsContext` (in `lib/prefs.ts`, provider in `App.tsx`) for replay
   speed / poll cadence / reduced motion, read by `usePoll`, `Run.tsx` replay start, and
   `hooks/useMotionPref.ts` replacing the 17 `useReducedMotion` reads and the two local copies.
8. **Onboarding polish (3 h). — DONE, awaiting review.** `ChoiceCard` → the Clad card (border states, check circle; tile already
   in from step 1); OpenAI mark SVG in `web/public/marks/`; title-block spacing; `Contract` → disclosure;
   tools check/minus rows; step 4 keeps `RunSettingsFields`.
9. **Review pass** (independent, as before) and a full browser walk at 1280 and 1440, including the
   wizard from a fresh `history/agents.json` (4 h incl. fixes).

## Dependencies

- `@phosphor-icons/react` — **approved**; added in step 1, `lucide-react` removed in the same step.
- Nothing else. Settings controls are native `<select>` + a hand-rolled switch: there is **no
  `components.json`** in `web/` (the `ui/button|badge|card` were pasted, not CLI-generated), so shadcn
  `Select`/`Switch` would mean two new Radix packages for two controls — not worth it; Linear's settings
  page ships native selects styled with tokens.

## Assumptions to verify first (kill conditions)

- **A static CSS chrome rim can look like the shader rim.** ✅ Spiked in step 1: `MetalFrame static` (a
  9-stop `conic-gradient` on the outer div; the opaque inner surface leaves the rim, same structure as the
  shader version, no mask needed) next to the shader on a card, a circle and the 16:1 plate at 1.5 and 2 px —
  indistinguishable from the frozen shader; `tint` at 22 % saturation is visible and quiet. `static` skips the
  canvas mount entirely, so no paused-shader fallback and no context cap are needed.
- **Version → cycles mapping is derivable per run.** Verified: `CycleRecord.config_before` /
  `config_after` (`chaos/schemas.py:216-217`); `RunRow.versions`, `GET /api/runs/:id` `configs` with
  `parent_version`/`patch_note`; cycles for any archived run via `GET /api/cycles?source=run:<id>`.
  **Not** derivable: anything per-agent across runs (versions restart at v0 each run) — hence the run
  picker. Cycles do not carry agent identity; the run row's `agent` does.
- **Three equal cards do not look empty at 1280.** Fresh install = built-in + example + Connect. If it
  does, the card grid caps at 3 columns and the row is `max-w-[960px]` centred — checked in the spike.
- `LiquidMetal` with `speed={0}` may still run its RAF loop — measure in the spike before relying on the
  paused-shader fallback.

## Rules (promote once Owen confirms)

`.cursor/rules/ui-style.mdc`: icons are Phosphor regular, one family, 16/20 px tokens, only where they carry
meaning — agents are shown by `AgentTile` (glyph / brand mark / monogram), never a generic icon; `u-line` only on a surface's primary text action; animated metal only on live surfaces; page
anatomy via `Page`; spacing scale 8/12/16/24/32; tables hairline-framed, cards only for parallel objects;
no keyboard shortcuts without a visible hint.
❌ Every link underlined, every rim animated, a shortcut nobody can discover, a table in a box, a `Sparkles`
icon on the demo agent.
✅ One underline per surface, metal moves only where work is happening, a sidebar toggle button.

## Not in this rework

Backend changes (none needed — every data need above is served by existing routes), the landing page, the
golden tape (re-recorded after this lands), Block 7. `/api/attack` stays if the wizard still uses it.
