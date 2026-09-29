# UI 7 — Review as a two-pane editor, Home hero title, Schedules orbit nodes

The three items from `ui-7-review-editor.md`, in its order, plus the one backend change it asked for. Build, lint and tests are
clean: `npm --prefix web run build` OK; `npm --prefix web run lint` 0 errors (the same 10 pre-existing warnings in `orb.tsx`,
`useDwell.ts`, `button.tsx`, `badge.tsx`); `env -u WANDB_API_KEY uv run pytest -q` 474 passed (473 + the new replay-filter test).
Nothing committed. Screenshots are in the Cursor screenshots folder (`/var/folders/gk/4js863bx5k175g264xx0cyg80000gn/T/cursor/screenshots/`),
named `ui7-*.png` as listed at the end.

While I was working, `live` v3 was rejected (`approvals.json`, 00:07Z) by something other than this lane — I only navigated and
screenshotted the old page. It turned out useful: the tree shows a rejected version next to two pending ones. I did not undo it.

## 1. Review page

### Correctness: replay scoped to the agent's own backend

`history/gateway.jsonl` is one log for the install, so a version's shadow replay used to count every agent's traffic. Now:

- `chaos/gateway.py`: every `log_line` / `turn_line` row carries `backend` (the URL the gateway fronts). `replay(cfg, rows, samples,
  backend=None)` filters rows to that backend when given; rows from before this change have no `backend` and match no filter, so old
  traffic is never misattributed to an agent.
- `api/main.py`: `GET /api/gateway/replay` takes an optional `backend` query and passes it through.
- `tests/test_gateway.py`: the two existing tests check the new field; `test_replay_filters_the_shared_log_by_backend` covers the
  function and the route with two backends in one log.
- `web/src/api.ts`: `GatewayEvent.backend`, `api.gatewayReplay(version, source, backend)`.

The page fetches replay only when the selected agent has a `tools_backend`; the built-in agent's drawer says
"The built-in agent has no real traffic" and nothing is fetched (`replayEmptyLine`). Seen with the airline agent: `Shadow replay ·
5 real calls`, `would block 0`, the per-tool bars (`book_new_flight 0/3`, `get_matching_flights 0/2`) — those five calls are the
airline backend's own.

### Layout

`web/src/pages/Review.tsx` is rewritten (the three-column layout, the queue and the tabbed snippets panel are gone). It now takes
`settings` / `onSettingsChange` from `App.tsx` because the page is one agent at a time:

- **Title strip** is the `Page` header: eyebrow `Review`, title `v2 · fixes cycle 5 · Malformed HTML response` (`stripTitle`), and on the
  right the gate's numbers in muted text (`held 2/2 · legit 11/11 · guard 11/11`, `gateShort`; red with the coverage warning as its
  tooltip when legit coverage is short), three 28 px icon buttons (copy `tool_rules.json`, copy the gateway command pinned to this
  version, framework snippets as a popover), a hairline, then **Reject** / **Approve** — or the decision mark / "record only" mark for
  past runs.
- **Tree** (260 px, own scroll, `role=tree`): roots are the selected agent's runs with something past v0 (`reviewRuns`), current run
  first and open by default with a `N pending` / `decided` badge; children are versions, highest first, with a status dot (pending
  hollow, approved filled, rejected dim) and `v3 · pending` + what it fixes; the selected version opens into its pseudo-files, changed
  ones marked with a dot. Selection is a hairline left bar on the `--hover` fill. Keyboard: ↑/↓ move, → opens (a run, a version's
  files) or steps in, ← closes or steps out, Enter/Space toggles or opens, Home/End. Roving `tabIndex`; focus follows the arrow keys.
- **Document pane**: a tab strip (the first changed file opens by default; clicking a file in the tree adds a tab; tabs close), a
  `unified` / `side-by-side` toggle shown only when the file changed, the header line `v2 vs v0 · nothing approved yet` / `v3 vs v2
  · approved …`, and the diff. `ConfigDiff` now takes `file` and `mode`: a line-numbered gutter (old · new), additions with a hairline
  left bar, removals dimmed and struck through — no green or red fills; unchanged files render read-only in the same monospace.
  `Cycle.tsx` keeps calling it with no `file` and gets the old all-files unified view (checked on cycle 5).
- **Drawer** at the foot: `Shadow replay · 5 real calls` collapsed by default; opening it shows the sentence, the bars and the last
  samples (capped at 40 vh, own scroll).
- A `?run=&v=` deep link into another agent's run switches `settings.target` to that agent (`reviewRunAgent`) so the link lands on
  something visible; the run holding the selection is open even when it is not the current run (`flattenTree`).

Derive functions added in `lib/derive.ts`: `reviewRuns(runs, agentId)`, `reviewRunAgent`, `reviewTree`, `pendingLabel`, `versionLabel`,
`flattenTree` + `TreeNode` + `treeKey`, `gateShort`, `stripTitle`, `replayTitle`, `replayEmptyLine`, `numberedDiff`, `splitDiff`.

**Decisions where the handoff was silent or I departed from it.**

- The page's title strip *is* the `Page` header rather than a second 48 px strip under it: two stacked strips read as two headers and
  cost 48 px of the document pane. Everything the handoff put in the strip is in the header.
- "Running" tree rows have no accessible name in the Cursor snapshot tool's output, but they do in the DOM (`role=treeitem` with text
  content). I did not add `aria-label`s that would duplicate the visible text.
- The React Compiler (via oxlint) bails on the component if anything downstream of `rows` might mutate the memo's input; `key` is
  built as a template literal so the compiler knows it is a string. Noted inline.
- Old rows without a `backend` are excluded from a filtered replay rather than assigned to the current agent. Honest zero beats a
  wrong number.

## 2. Home hero card

- **Fixed height.** The card's height used to follow the side column's content (the *Needs attention* grid), which arrives after the
  card — that was the resize on fresh load. `Home.tsx` now makes the content area exactly one viewport tall at `lg`
  (`lg:h-[calc(100dvh-3.5rem)] lg:flex-none`; `flex-none` matters — `flex-1` was letting the flex basis override the height, on the
  Review page too), so the grid's `1fr` row has a real height to fill: the card is 689 px at 1440×900 for both agents, with any
  amount of attention items, and the panels scroll inside as the original comment intended. Below `lg` the card is its 320 px minimum.
  Measured: card height constant from the first paint through the data arriving (`944` before with a scrolling page, `689` after with
  none).
- **One-line title.** `heroTitle(name)` splits a trailing parenthetical into the subline and picks a smaller size step past 22
  characters; `heroSubline(title, agent, starting)` composes `OpenAI CS demo · HTTP · airline domain`. `AgentCard` applies both itself
  (`name` is now optional — the switcher for Home / Current run, the plain name otherwise), so the Agents grid gets the same treatment
  without three call sites repeating it; the `subline` prop is gone. The title is `whitespace-nowrap`; the `cqw`-based clamp handles
  narrower cards.
- **Chevrons.** The hero trigger in `AgentSwitcher` shows `heroTitle(name).name` with the caret at `0.35em` from the text, centred on
  the one-line title — the "floating" chevrons were the caret centred across a two-line wrap.

Seen: `Example airline agent` / `OpenAI CS demo · HTTP · airline domain` and `Demo agent` / `built in · demo agent · in-process`,
same card height, no page scroll (`ui7-after-home-airline.png`, `ui7-after-home-demo.png`).

## 3. Schedules

- The inner `rounded-xl border` around the orbit is gone (`Schedules.tsx`); the timeline's own `bg-black` is gone too, so the orbit
  floats on the page. The "click a node to open it" caption moves to the content's top-left.
- Nodes are `MetalFrame` orbs at 28 px, `radius=9999`, carrying `monogram(name)` (`Nightly sweep` → `NS`, `Sweep` → `SW`), with the
  trigger in words beneath (`every day`, `on change`; `triggerLabel`). Paused = orb at 40 % behind a hairline ring. Running = a small
  filled white dot at the orb's rim (white, not `--live`, per the monochrome rule).
- `TimelineItem.icon` is deleted; `mark: string` replaces it. `TimelineItem.status` becomes `"paused" | "running" | "waiting"` — the
  old `completed / in-progress / pending` values were never drawn by the component. `scheduleStatus(s, loop)` now takes the loop
  state: a schedule is *running* when the loop is running and it started within two minutes of the schedule's last `started` result
  (they share one start path, so the two stamps are seconds apart). The Phosphor `Clock` / `ArrowsClockwise` imports are gone.

Seen with 1 and 3 schedules (`ui7-after-schedules-1.png`, `ui7-after-schedules.png`, and `ui7-after-schedules-zoom.png` with the
orbit scaled ×1.9 in the console to show the orbs). The two test schedules (`Nightly sweep ui7`, `Release check ui7` on the airline
agent, paused, on change — the API refuses `on_change` for the built-in agent) were deleted afterwards; only `Sweep` remains.

## Files

Backend: `chaos/gateway.py`, `api/main.py`, `tests/test_gateway.py`.
Frontend: `web/src/pages/Review.tsx` (rewritten), `web/src/pages/Home.tsx`, `web/src/pages/Schedules.tsx`, `web/src/pages/Run.tsx`,
`web/src/pages/Agents.tsx`, `web/src/App.tsx`, `web/src/api.ts`, `web/src/lib/derive.ts`, `web/src/components/ConfigDiff.tsx`,
`web/src/components/AgentCard.tsx`, `web/src/components/AgentSwitcher.tsx`, `web/src/components/ui/radial-orbital-timeline.tsx`,
`web/src/index.css` (`.u-line.is-on` for the active tab).

## Browser-checked

Review with the demo agent (three versions, one rejected; tabs, side-by-side, snippets popover, drawer), with the airline agent via
deep link (`?run=20260925T233010Z&v=1` switches the agent; keyboard ↓ → ↓ Enter walked and selected; drawer with 5 real calls);
Home with both agents; Schedules with 1 and 3; Cycle 5 (`ConfigDiff` unchanged there); Agents grid; Current run.

## Not verified

- **Review with no runs.** Both selectable agents have runs; the `example` agent is stopped and cannot be picked. The empty branch
  (`No versions yet — run Heal`) is code I read, not a screen I saw.
- **Current run's empty face** (the `AgentCard` there) — showing it means clearing Owen's live run. The same component with the same
  props was checked on Home.
- **Approve / Reject clicks.** Not pressed: they write to `approvals.json`. The handler is the old page's, unchanged in what it calls
  (`api.review`, then re-read).
- **A schedule in the `running` state** — needs a scheduled run to be in flight; only the derivation is new.
- Clipboard buttons were not clicked (the Cursor browser's origin is `http://localhost`, where `navigator.clipboard` is available, but
  I did not verify the paste).
- The vite `dev` server was used throughout, not the production build in a browser.

## Screenshots

Before: `ui7-before-review.png`, `ui7-before-schedules.png`, `ui7-home-airline-before.png`.
After: `ui7-after-review.png` (airline, drawer open), `ui7-after-review-demo.png`, `ui7-after-review-split.png` (side-by-side +
popover + drawer), `ui7-after-review-airline.png`, `ui7-after-home-airline.png`, `ui7-after-home-demo.png`, `ui7-after-schedules-1.png`,
`ui7-after-schedules.png`, `ui7-after-schedules-zoom.png`, `ui7-neighbour-cycle.png`, `ui7-neighbour-agents.png`, `ui7-neighbour-run.png`.
