# 08 — Rework round 2: cards, dropdowns, Clear, results list (Sep 19, 10:45 PM)

Owen's review of the `07` build, in his words: no OS dropdowns — premium surfaces; Current run should show
the normal agent orbs on top, not a Heal button; add **Clear** next to See results; after Clear the page is a
big agent card with Heal and nothing else; Heal leaves Home and Agents (the start dialog goes with it);
See results gets the **hover list back** with a small v0→vN panel and the run selector on top; the date
eyebrow leaves Home; the static liquid metal looks bad — animate everything that was static; the agent card
needs a real redesign — a nice graphic with the agent name. References (Sep 19 assets): 21st.dev
*Container Text Scroll* (Ruixen — dark card, warm light-streak texture, name set large over it) chosen over
*Card Studio* (image / title / body / coloured CTA).

Decisions Owen took (10:50 PM, all as recommended): Container Text Scroll shape · card graphics animate
only when hovered (follow-up #1; the body below still says "selected or hovered") · Clear is the only path to Heal when a last run exists · picking a version
filters the results list · the config-diff panel goes (the cycle page has the diff) · "open run" stays,
which reads **watch replay** when a recording exists, else **open run** · Home card = graphic + name + switcher with a stats strip, panels stay ·
dropdown is built on `AgentSwitcher`'s popover, no new dependency.

Everything in `07` not named here stands: routes, `Page`/`Panel` anatomy, prefs, Phosphor, `usePoll`.

## Decisions (the spec)

1. **One `Dropdown`.** `components/Dropdown.tsx` is `AgentSwitcher`'s popover made generic: a trigger
   (children) and a floating panel of options, `role="listbox"`/`option`, outside-click + Escape close,
   ↑/↓/Home/End/Enter/typeahead-first-letter, `aria-activedescendant`, selected row ticked with Phosphor
   `Check` 14 px, panel width = trigger width or a `panelWidth`, opens downward and flips up when there is
   no room (one `getBoundingClientRect` on open, no positioning library); `placement: "below" | "right"`
   — the collapsed 36 px rail opens sideways (today's `left-full top-0 ml-2`) and then `panelWidth` is
   required. Each option is `{ value, label: string, row?: ReactNode, disabled? }` — `label` is what
   typeahead and the trigger read, `row` is the rich rendering. `AgentSwitcher` becomes a `Dropdown` whose
   rows are `AgentTile` + name + subline; the "Connect an agent" link is a **footer below the listbox**
   inside the same panel (an `<a>` cannot be an `option` under `aria-activedescendant`), reached by Tab.
   Call sites: `AgentSwitcher` (rail, Home, Current run, Settings) and the eight native selects behind
   two wrappers — `RunSettingsFields` ×4 (Seeds, Chaos cycles, Repair attempts, Until quiet), Settings ›
   Display ×3, Agent run picker ×1. `RunSettingsFields`' `Select` stays as a five-line adapter over
   `Dropdown` (fewer churned call sites; still one way). No native `<select>` remains in `src/`. The
   wizard's First-run step uses `RunSettingsFields` and gets the swap for free — walk it. `Switch` stays.
2. **`AgentCard` — the graphic card.** `components/AgentCard.tsx` (call sites: Home, Agents grid, Current
   run empty face — three, so it earns the file). The look is the Ruixen `Card` from the *Container Text
   Scroll* paste (archived byte-exact in the component library as
   `prompts/container-text-scroll-integration.md`, Sep 19 11:07 PM), with its scroll/tilt machinery
   dropped — Owen: "use the card but ignore the scroll behavior". Recipe, from the paste, on our tokens:
   `rounded-[24px]` (30 px in the paste; 24 keeps it in step with the 13 px cards elsewhere), a **3 px soft
   rim** `border-[#3a3a40]` (the paste's `border-4 border-[#6C6C6C]` read against our black), the paste's
   six-stop black `boxShadow` stack verbatim (it is what makes the card sit *on* the page rather than in
   it — the one place the UI standard's "hairline over shadow" yields, because Owen picked this card for
   exactly that), `overflow-hidden`, and an inner `rounded-[20px]` panel. 16:9 on the Agents grid; free
   height on Home and Current run. The inner panel is a `LiquidMetal` canvas — the spike's variant B: `colorBack` `#000000`,
   `colorTint` = `cardTint(id)`, `shape` `none`, `scale` 1.4, `repetition` 3, `softness` 0.9, `distortion`
   0.35, `contour` 0.4, `angle` 30, `shiftRed` 0.1, `shiftBlue` 0.05, `maxPixelCount` 300 k. **Every card is a different colour**, the built-in agent included: `cardTint`
   gives the built-in agent the paste's warm amber (hue 24 — it is the demo, it gets the reference's
   look), the example agent a fixed cool hue (210), and each connected agent `agentHue(id)` (a stable hash
   of its id). The title sits **centred** over the graphic as in the paste — not bottom-left — the agent
   name in the display serif (`clamp(28px, 4vw, 56px)`, white), the subline (`agentSubline`) in 13 px
   `rgba(255,255,255,.7)` under it, both over a soft radial darkening so they read on any tint. `name` is a
   `ReactNode` slot (a link on the grid, `AgentSwitcher size="card"` on Home and Current run — the same
   control as the rail's, never a second agent dropdown) and
   `children` is an overlay slot rendered over the graphic (the Heal orb on Current run's empty face,
   nothing elsewhere). No stats, no tile, no buttons other than what those two slots carry. **Motion:**
   the shader runs (`speed` 0.6) only while the card is the selected agent or under the cursor / focused;
   otherwise `speed={0}` so the canvas is a still frame (the mount stops its rAF entirely at speed 0), and
   `useMotionPref()` forces still. The shader mount's own `IntersectionObserver` only pauses offscreen — it
   keeps the GL context — so `AgentCard` additionally unmounts the canvas offscreen for a CSS fallback
   (`agentGradient`); a grid of N agents holds at most the visible cards' *still* contexts and one moving
   one. Owen's "static looks bad" was the CSS conic rim; a paused shader frame is the real texture.
3. **Liquid metal rims all move again.** `MetalFrame` loses `static`, `tint` and `chromeRim`; `CyclesBox`
   goes back to the animated rim (`maxPixelCount` 400 k as before). No `AgentCard` has a metal rim — Home's
   `MetalFrame` is deleted with the old card; the graphic is the premium, a rim around a shader is two
   textures fighting.
4. **Current run has two idle faces, not one.**
   - **Last run present** (`live_exists()` — run files in `runs/`; `loop_settings.json` and the logs stay
     behind by design — and `loop.running === false`): the four agent orbs on top in their grey finished
     state, then the header facts line, the numbers line, the cycles box. *This path does not exist today*:
     `Run.tsx` renders the orb grid only while `playing`. Step 4 extends that condition to `playing ||
     lastRunFace` where `lastRunFace = id === "live" && mode === "finished" && !emptyLiveFace(…)` (in
     `derive.ts`), with `orbStates(null)` (all grey) and without the `StatsPlate`/target line. Header
     actions: **See results** (the one `.u-line` text action → `/app/agents/<id>`) and **Clear** (quiet
     text button, disabled while `loop.running`). No Heal, no orb, no switcher.
   - **Empty** (no run files in `runs/`): one `AgentCard` for the selected agent, wide (max 720 px,
     centred), the Heal orb (`HealOrb`, size 128) in the card's `children` overlay on its lower half, the
     estimate line under it — both over the darkening so the 12 px text keeps contrast. The card's
     `name` is `AgentSwitcher size="card"`. Nothing else on the page. `HealOrb` keeps its file with
     one call site: it owns the start POST, the 409 redirect and the running/watching branches — a
     genuinely separate object.
   - **Clear** = `POST /api/runs/archive` (below), then the page does what `watch()` already does when a
     tape takes over: `setBySource(m => ({ ...m, live: undefined }))`, `refreshCycles()`, `refreshState()`,
     and the shell `refresh()`. `usePoll` keeps the last good row across 404s on purpose, so the row alone
     can never say "empty".
   - **Empty-face rule** (`emptyLiveFace(id, mode, rowError, state)` in `derive.ts`): `id === "live"`
     && `mode === "finished"` && `rowError !== null` (the live row poll is failing) && `state?.source ===
     "golden"` (an empty `runs/` makes the API answer `live` reads with the demo tape). `state === null` is
     *loading*, not empty, so the page never flashes the last-run face for a tick. This replaces the
     deleted `fallback` line and keeps its `rowError` guard: a real run whose state read momentarily fails
     over must not jump to the empty face.
   - Live / watching / finished-history faces are unchanged.
5. **Home loses the orb and the date.** The card is an `AgentCard` (free height, ~300 px) whose `name` is
   `AgentSwitcher size="card"` (the same control as Current run's empty face), with the stats strip
   (`homeStats`) directly under the graphic inside the same frame; the **Needs attention** and **Recent
   runs** panels stay beside it. No Heal anywhere on Home — the way to a run is Current run. `Page` gets
   no `eyebrow`.
6. **Agents grid** is a grid of `AgentCard`s (16:9) plus the dashed "Connect an agent" card. The card root
   is a `div`; a full-bleed absolutely-positioned `<button aria-pressed>` selects the agent *(superseded by follow-up #2: the face is a link, a corner button selects)*
   (`settings.target`) and the `name` link to `/app/agents/<id>` is a sibling layered above it — two
   controls, valid HTML (no link inside a button), no state-dependent double-click. A small `→ details` text appears
   bottom-right on hover *and* `focus-within`. No Heal on the page, no page action; `StartDialog.tsx` is
   deleted with its only caller. The per-card controls that exist today — ping, start/stop example agent,
   **delete with its inline confirm and the 409-while-running message**, tools mapped, notes — all move to
   the **Agent page header** as quiet text actions (~80 lines of handlers travel with them; none depends
   on `StartDialog`).
7. **See results (`/app/agents/:id`) is the hover list — and so is the finished history run page.**
   `RunResults` has two call sites (`Agent.tsx` and `Run.tsx` for `/app/runs/<id>`), so both get the new
   shape: one results surface. Agent header: `AgentTile` + name + subline, the moved per-agent actions,
   the run `Dropdown` (`runPickerLabel` rows, newest first) and **one** link: **watch replay** →
   `{ kind: "run", id, replay: true }` when the run has a recording, else **open run** → the run page.
   Body, top: a small `Panel` "Versions" — the `VersionRail` (v0…vN, roving tabindex as today) and, right
   of it, one stats line for the picked version (`versionLine`: attacks · landed · blocks · gate). Body,
   below: the restored `ui/interactive-list-preview.tsx` (from `HEAD`, unchanged; it needs only React and
   the installed `gsap`) fed by `resultsRows(cycles, v)` in `derive.ts` — the cycles whose `config_before
   === v` (never undefined: required in `chaos/schemas.py` and `api.ts`), or every cycle when v is the
   final version and nothing attacked it, so the list is never empty on a run with cycles. Each row:
   `client` cycle n · short title, `status` `rowStatus`, `services` `cycleOutcome`, plus the cycle number
   for `onSelect` → the cycle page. `resultsRows` returns no `preview`; `RunResults` maps `preview:
   cycleChartSvg(r, cycles)` when it builds items — `previewSvg.ts` imports from `derive.ts`, so `derive`
   must not import it back. The list uppercases its cells; titles read in caps, as they did before. The
   "Config vN" and "What changed" panels go with `Rationale`; `ConfigDiff` keeps its cycle-page call site;
   `cycleThatMade` stays (`versionStats` uses it) but `versionStats` loses `origin`/`rationale`. In the
   run page the list bleeds `-mx-6 md:-mx-10` as it did at `HEAD`. *(Superseded by follow-up #5: always `-mx-8`, transparent.)*
8. **Backend: `POST /api/runs/archive`.** Route in `api/main.py`, behaviour in `api/loop_ctl.py`
   (`archive_live_run()`): under `runs_lock` (the convention for every hand-over of `runs/`, see
   `rollback.py`; two Clear clicks in one second would otherwise both pass the `present` check and the
   second `mkdir` 500s), 409 `loop is running` when the loop runs; otherwise stop any replay (not for file
   safety — `replay.py` reads tapes into memory — but because `/app/run` shows any active tape as
   `watching`, and the page must land on the empty face), call `chaos.state.archive_previous_run()` and
   return `{ "archived": dest.name | null }` — the folder name is the id the Runs list uses. `api.ts`
   gains `runsArchive()`. Tests in `tests/` (there is no `api/tests`): `tests/test_archive.py` on the
   `runs` fixture pattern from `tests/test_loop_ctl.py` — 409 while running, happy path returns the id,
   `None` on an already-empty tree. The Runs list picks the archived run up on its next poll *if it had
   cycles* (`history_runs()` skips empty folders).

## Work, in order (each step ends `tsc -b` clean and lint at the 10 known warnings)

1. **Spike — done 11:15 PM, passed (see Assumptions).** One `LiquidMetal` at 16:9 with `colorBack`
   `#000000` and `colorTint` `#7a3a10`, `speed` 0 vs 0.6, next to the Ruixen screenshot. The
   shader applies `colorTint` with **colour-burn** blending, so a saturated tint on near-black may go
   black instead of glowing — try the inverse too (`colorBack` tinted, `colorTint` light) and pick a
   `shape`/`scale`. Kill condition: if neither reads as a warm light streak (flat wash, or a visibly noisy
   frozen frame), the graphic becomes `GrainGradient` or `Warp` from the same package before `AgentCard`
   is written. Owen sees the screenshot before step 3.
2. **`Dropdown` + swap** (5 h). Build `Dropdown` (full keyboard model, `aria-activedescendant`, flip,
   `right` placement); rewrite `AgentSwitcher` on it (its three layouts: rail, icon-only rail, card);
   `Select` adapter; the eight selects across Settings, the Agent page and the wizard's First-run step.
   Check no popover is clipped (`Panel` root has no `overflow-hidden` since the `07` review) and that the
   run picker's long rows truncate.
3. **`AgentCard`, rims, Agents grid, Agent header, Home** (6 h). Build `AgentCard` (name/children
   slots, hover/selected motion, offscreen unmount, reduced-motion still); Agents grid on it with the
   select-button / name-link split; move the per-agent handlers (ping, example start/stop, delete +
   confirm, tools mapped, notes) into the Agent page header; delete `StartDialog.tsx` and the local
   `AgentCard` in `Agents.tsx`; Home on the card with the stats strip, no eyebrow, no orb; remove
   `static`/`tint`/`chromeRim`/`RIM_STOPS` and the static-rim header comment from `MetalFrame`;
   `CyclesBox` animated again with `maxPixelCount={400_000}` restored and its comment fixed.
4. **Archive route + Current run faces** (3 h + 1 h backend). `archive_live_run()` under `runs_lock`,
   route, `api.ts`, `tests/test_archive.py`. `Run.tsx`: extend the orb section to the last-run face, Clear
   with the `bySource` drop + three refreshes *(follow-up #6: `dropLive` — drop + `reset()` + refresh)*, `emptyLiveFace`, `HealOrb` in the card overlay.
5. **See results** (3 h). Restore `interactive-list-preview.tsx` from `HEAD` (only that file —
   `PreviewRow.tsx` imports helpers that no longer exist and stays deleted); `resultsRows` +
   `versionLine` in `derive.ts`; `RunResults.tsx` becomes Versions panel + list at both call sites;
   delete the two panels and `Rationale`; one `watch replay` / `open run` link.
6. **Docs + review + browser walk** (2 h). `docs/FRONTEND.md` (Current run faces, archive route, results
   page, dropdown, card motion rule; remove the three start-dialog mentions at lines 20/71/175);
   `Settings.tsx` copy at lines 19 and 83 that names the start dialog; independent review; walk every
   page at 1280 and 800 px.

**Estimate: ~21 h.** Steps 2–3 and 4–5 are independent pairs.

## Derive additions (pure, one-line docstrings)

- `resultsRows(cycles, version)` — hover-list rows (no `preview`) filtered by `config_before`, oldest
  first, each carrying its cycle number.
- `versionLine(cycles, version)` — the Versions panel's one stats line (wraps `versionStats`).
- `emptyLiveFace(id, mode, rowError, state)` — the §4 rule as a named boolean.
- `lastRunFace(id, mode, rowError, state)` — finished live run with files: the orbs-on-top face.
- `cardTint(id)` — the agent's `colorTint` **hex** string (the shader ignores `hsl()`): `#7a3a10` for
  `builtin`, `#153260` for `example` (darkened from `#1f4f8a` in the build: the lighter blue left white text unreadable), `agentHue(id)` at 55%/28% converted to hex for the rest; every card
  a different colour.
- `cardSpeed(moving, hovered, reduced)` — `0 | 0.6`; `moving` is Home / Current run's one card (follow-up #1).

## Deletions (delete what you replace)

`StartDialog.tsx`; `MetalFrame` `static`/`tint`/`chromeRim`/`RIM_STOPS`; the local `AgentCard` in
`Agents.tsx`; `RunResults` Config/What-changed panels, `Rationale`, and `versionStats`' `origin`/
`rationale`; `HealOrb`'s Home call site; Home's `MetalFrame`; the Home `today` line; the Agent page's second header link;
start-dialog copy in `Settings.tsx` and `FRONTEND.md`. `07` §4's "static CSS chrome rim" decision is
superseded — note it at the top of `07`.

## Assumptions

- **Verified:** `chaos/state.py:archive_previous_run()` moves configs, suite, cycles, manifest, status,
  vulnerability into `history/<ts>/` and returns the `Path` (`.name` is the run id `history_runs()`
  lists); `runs_lock` is the hand-over convention (`api/rollback.py`); `GET /api/state?source=live` on an
  empty tree resolves to `golden` and `GET /api/runs` omits the live row; `LiquidMetal` exposes
  `colorBack`, `colorTint`, `speed`, `maxPixelCount` and stops its rAF at `speed` 0 (`@paper-design/
  shaders-react` 0.0.80); `interactive-list-preview.tsx` at `HEAD` needs only React + `gsap` (installed);
  `cycleChartSvg` is still in `lib/previewSvg.ts`; `CycleRecord.config_before` is required, never
  undefined; `StartDialog` has one caller; `RunResults` has two.
- **Verified (step 1 spike, 11:15 PM, screenshots in the chat):** a `LiquidMetal` on `colorBack`
  `#000000` with a dark hex `colorTint`, `shape: "none"`, `softness` 0.8–0.9, `repetition` 2–3 reads as
  the Ruixen warm light streak on black — both moving and frozen (speed 0 frames are clean, no noise).
  Colour-burn did not go black. Chosen recipe (variant B): `colorTint` `#7a3a10`, `scale` 1.4,
  `repetition` 3, `softness` 0.9, `distortion` 0.35, `contour` 0.4, `angle` 30, `shiftRed` 0.1,
  `shiftBlue` 0.05. **Gotcha:** the shader silently ignores `hsl()` colour strings and falls back to white
  chrome — `cardTint` must return hex. `example` → `#153260`; connected agents → `hsl→hex` of
  `agentHue(id)` at 55% saturation, 28% lightness (kept dark so black stays dominant).
- **Unverified:** how many still WebGL contexts Chrome keeps alive before evicting the oldest (commonly
  16). Mitigation is the offscreen unmount in §2; if a 12-agent grid still loses contexts, cards beyond
  the first row fall back to the CSS gradient permanently.

## Follow-ups from Owen's walk (Sep 20, 00:38 – 00:49)

Six findings on the built round, all verified in the running app before planning. One step, ~2.5 h,
then a deep review of everything uncommitted.

### Findings and root causes

| # | Finding | Root cause (verified) | Fix |
| --- | --- | --- | --- |
| 1 | Agents grid: the selected card keeps moving; Owen wants motion only under the cursor | `Agents.tsx` passes `selected={on}` and `cardSpeed` treats `selected` as a motion driver | `AgentCard`'s prop becomes `moving` ("keeps moving without the cursor"); the grid never sets it; Home and Current run do (they are "one agent, right now"). `cardSpeed(moving, hot, reduced)` |
| 2 | "Can't click into an agent from its card" | The name *link* works (clicked in the browser: URL and page change). The **face** is the `Attack … next` button, so 95 % of the card selects instead of opening, with only a hover caption to say so | The face becomes the link to the agent page (one primary action per surface). Selecting the attack target moves to a quiet bottom-left text button, `attack next` → `selected` (a real button, not a caption; z-30 above the face). The title layer lets clicks fall through (`pointer-events-none`) except on interactive descendants, so plain-text names no longer swallow clicks |
| 3 | Home components should be bigger / fill the page | `Page` caps content at 1200 px; Home's card is `min-h-[300px]` in a `1fr / 360px` grid with fixed-height panels — nothing grows | Home tells `Page` to lay its content out as a column with no max-width (`className="flex flex-col max-w-none"`, `cn` merges). The grid is `flex-1 min-h-0` with one row; the card is `flex-1`, the two panels split the right column (`flex-1` each, `min-h-0`, bodies scroll). Name cap 56 → 72 px so the bigger card gets a bigger name |
| 4 | Panels should be pure black, like the cycles box | `Panel` and Home's stats strip use `--card` (#0c0c0e) | Both use `--bg`. `--card` stays for *floating* surfaces that must separate from the page (Dropdown panel, hover chart card); the Panel header comment says so |
| 5 | Grey on the hover rows | `InteractiveListPreview`'s default `bgColor="#171717"` paints a grey slab behind the list, and `mix-blend-difference` of the white bar over it is #e8e8e8, not white | `RunResults` passes `bgColor="transparent"`: black page, white bar, black hovered text. The `bleed` prop goes: the list *always* bleeds, so its rows align with the page content edge on the Agent page too (they were inset 40 px) |
| 6 | Orbs and stepper flicker on entering Current run at rest | Sampled at 30 ms after clicking Current run: 418 ms — cycles box paints under **"no run yet"**, no orbs; 483 ms — row and state land, four orbs mount above and shove the box down. The page decides its face from three polls that land in any order and renders as soon as any one does | `idleFaceSettling(id, mode, …)` in `derive.ts`: the current run at rest is *loading* until the row, the cycles and the state have each answered or failed. Clear, "watch it back" and a tape letting go of `live` all go through `dropLive`: the held `live` frame goes *and* the row / cycles / state polls `reset()` (new on `usePoll`) then refresh — resetting is what makes the drop stick, since the polls keep last-good answers and the render-time store would otherwise put them straight back. So every hand-over passes through `loading…` and nothing paints under the wrong header for a tick |

### Noted on Owen's walk, Sep 20 02:26 — done 02:45

1. Dividers inside panels were hard to see: `--border` 8 % → 14 %, `--border-2` 16 % → 22 % (one token change
   reaches every hairline; the hover step stays a step above); `--frame` unchanged at 30 %.
2. `AgentCard` hover (Home, Agents, Current run): the photo zooms 5 % over 1.2 s, the rim steps `#6C6C6C` →
   `#8c8c8c`, the title lifts 4 px; CSS transitions gated on `useMotionPref()`.
3. Home stats strip: each stat centred under its label.
4. Runs table: Cycles / Config / Duration / Status centred; Started and Agent stay left, `watch` right.

### Not doing (ask first)

- ~~The card graphic vs. the Ruixen preview~~ — **decided Sep 20, 01:44: use the paste as-is.** Owen: "follow
  the original prompt/code exactly." `AgentCard` is now the paste's `Card` (4 px `#6C6C6C` rim on `#222`,
  `rounded-[30px]`, the shadow stack) around the demo's photo, served from `web/public/agent-card.jpg`
  (the 21st.dev mirror JPEG downscaled 6000→1400 px, 2.9 MB→250 KB — a product page must not hotlink a
  component gallery's CDN). Per-agent colour is a CSS `hue-rotate` on the photo (`agentHueRotate`: 0 for
  the demo agent, blue for the example agent, a hashed hue otherwise). The shader, `cardTint`, `cardSpeed`,
  `agentGradient`, `hslToHex` and the `moving` prop are gone; `AgentTile` shows the same photo, square, at
  20–48 px — "a small square version of the background graphic". Step 2's shader recipe above is history.
- Panel edges: `--border` (8 % white) read as invisible on black. New token `--frame` (30 % white) is the
  outer edge of every framed surface — `Panel`, Home's stats strip, the Runs table, the version pill;
  dividers inside stay `--border`, controls keep `--border` → `--border-2` on hover. A metal rim on panels
  (Owen's "best case") is not done: each `MetalFrame` is a WebGL context, and Home + Agent would hold five.

### Verification (this step)

1. Agents grid: hover a card → it moves; leave → still within ~1 s; the selected card at rest is still.
   Click the face → the agent page. Click `attack next` → the rail switcher changes, the page does not.
   Tab: face link → `attack next` button → next card. `prefers-reduced-motion` → nothing moves.
2. Home at 1280×800 and 1920×1080: the card and panels fill to the bottom gutter with no page scroll;
   with 12 attention rows the panel scrolls inside, the page does not. Collapse the rail → the card grows.
3. Current run at rest (a finished run in `runs/`): sample the DOM as in the finding — one paint: header
   facts + orbs + box together, nothing before. Then Clear → `loading…` → card + Heal, never the demo
   tape's cycles. With `runs/` empty on first load → card + Heal with no box in between.
4. Agent page: hover a results row → white bar edge to edge, black text, no grey slab; the rows' left
   edge lines up with the Versions panel's. Same on `/app/runs/<id>`.
5. Neighbours: Settings panels are black with their dropdowns still `--card`; the Cycle page's sticky
   chart card is unchanged; the live-run face (start a run) still shows the plate + orbs + box with no
   loading gate (`idleFaceSettling` is false while anything plays).

## Verification (after step 6)

1. Clear on Current run with a finished run that had cycles → the Runs list grows by one row within a
   poll and Current run shows the card + Heal, not the demo tape and not the old run for even one tick.
   Press Heal → a run starts against the card's agent.
2. Clear while a run is running → button disabled; `curl -X POST /api/runs/archive` → 409. Two rapid
   Clears → the second returns `{ "archived": null }`, not a 500.
3. Settings › Run defaults › Seeds dropdown opens over the panel below, ↑/↓ moves, typing `a` jumps to
   "all", Enter picks, Escape closes, Tab leaves; the same on the Agent page run picker with 11 runs
   (panel scrolls, rows truncate); the collapsed rail's switcher opens to the right.
4. Agents grid with 6+ agents: only the hovered/selected card moves; scroll the grid offscreen and back —
   cards still render (no lost contexts); `prefers-reduced-motion` → nothing moves anywhere. Tab to a
   card: Enter opens it; Tab again reaches `attack next` → selects (follow-up #2).
5. See results: pick v1 → the list shows only attacks against v1 and the stats line changes; hover a row →
   chart card; click → cycle page; "watch replay" → the run's page with the tape playing. The same page
   shape appears at `/app/runs/<id>` for a finished history run.
6. Neighbours: onboarding still connects an agent and its First-run step's dropdowns work in the centred
   layout; the live-run face is unchanged; delete / ping / start example agent still work from the Agent
   page header, including delete's 409 while a run is on.
