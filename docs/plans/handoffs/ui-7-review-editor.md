# Handoff — UI lane 7: Review as an editor, hero card, schedule nodes

Repo `/Users/owentsao/Coreweave Hacks`, branch `feature/production-fit` (99 uncommitted files — **never commit, stash,
reset, checkout**). Read `.cursor/rules/code-organization.mdc`, Owen's UI standard
`~/.cursor/skills/my-ui-standard/SKILL.md`, and `docs/plans/handoffs/frontend-5-report.md` + `frontend-6-report.md`
(what the Review page is today). Build/lint: `npm --prefix web run build`, `npm --prefix web run lint` (10
pre-existing warnings in untouched files are fine). Tests keyless: `env -u WANDB_API_KEY uv run pytest -q` (473).
Dev: `scripts/dev.sh` (API :8000, web :5173). `runs/` holds a real airline run (12 cycles, v0→v1) and the
`example-airline` agent row; `history/` has older retail runs — good data for the tree.

Owen's two visual references are attached: a Cursor editor (persistent left tree, one document, thin title strip with
"Keep all changes / Review next file" on the right) and a help-centre editor (left tree with status dots, wide single
article on the right, almost no chrome). The Review page should feel like those: two panes, monochrome, quiet.

## 1. Review page rework (biggest; includes one correctness bug)

**Correctness first — shadow replay is not scoped.** `history/gateway.jsonl` is one file per install (`api/main.py:694`),
so the Review page shows airline traffic under a retail version. Fix on both sides, minimal:
- `chaos/gateway.py`: every log row gains `backend` (already in `/health` at `:295`; add it to the per-call row and the
  turn row). No new flag; the gateway already knows its backend.
- `GET /api/gateway/replay` gains optional `backend=<url>`; when set, only rows with that backend are replayed. The
  route stays thin; filtering lives with the replay logic. Test: two backends in one log → counts differ by filter.
- Frontend passes the selected agent's `tools_backend` when it has one; when the agent has none (built-in), the panel
  says "The built-in agent has no real traffic" instead of showing another agent's calls.

**Layout — two panes, not three.**
- **Top strip** (one line, ~48px): `v3 · fixes cycle 8 · <cycle title, truncated>` left; `held 2/2 · legit 11/11 ·
  guard 11/11` centre in muted; right: icon-row toolbar (copy rules · copy gateway command · snippets popover) then
  **Reject** (text) and **Approve** (filled) — the "Keep all changes" position. Approved/rejected versions show the
  decision mark in place of the buttons.
- **Left tree** (~260px, full height, its own scroll): scoped to the **selected agent** (`settings.target`), fixing
  the queue that mixes all 45 pending versions across every run. Roots = that agent's runs (current run first,
  then history newest-first), each collapsible with a count badge ("3 pending"); children = versions (`v3 ·
  pending`, status dot: pending = hollow, approved = filled, rejected = dim); grandchildren = the version's
  pseudo-files with a changed-dot (as now: only `tool_rules.json` for HTTP targets). Current run expanded, older
  runs collapsed. Keyboard: up/down moves, right/left expands/collapses, enter opens. Selection is a hairline
  left bar + `--hover` fill, no colour.
- **Document pane**: tab strip on top (files opened stay as tabs, close on ×, active tab underlined with `.u-line`
  style); under it the file. Diff view for changed files: unified by default with a "side-by-side" toggle in the
  tab strip's right end; line-numbered gutter in `--faint`; added lines carry a hairline left bar, removed lines
  are dimmed and struck — **no green/red fills** (signals only). Unchanged files open as read-only monospace.
  Header line above the file: `v3 vs approved v1` (or `v3 vs v0 · nothing approved yet`).
- **Bottom drawer** in the document pane, collapsed by default, titled `Shadow replay · 5 real calls`; opens to
  the per-tool bars + samples as today. Same drawer pattern as an editor's terminal panel.
- Delete what you replace: the three-column grid, the separate export block, the queue list. Every label/number is
  a pure function in `lib/derive.ts` (`reviewTree`, `diffLines`, `tabTitle`, …); the tree and tab strip are JSX in
  the page unless the Cycle page reuses them (it reuses `ConfigDiff` — keep one component and extend it with the
  `mode: "unified" | "split"` prop).
- Empty states: no agent selected → "Pick an agent"; agent with no runs → "No versions yet — run Heal"; run whose
  every version is decided → tree shows it, strip shows the mark.

## 2. Home hero card

Screenshot shows "Example airline agent (OpenAI CS demo)" wrapping to two display-size lines, stretching the card,
with the switcher chevrons floating mid-image. Fix: the hero card has a fixed height (whatever the retail card
measures today); the title is one line — `heroTitle(name)` in `derive.ts` strips a trailing parenthetical into the
subtitle (`Example airline agent` / `OpenAI CS demo · HTTP · airline domain`) and picks a smaller size step when the
remaining name is over ~22 chars; the chevrons sit at the title's right end, vertically centred on the title, not
on the card. Investigate the "buggy" report: reproduce a fresh load with the airline agent selected and watch for the
card resizing after `agents` arrives (likely: name renders empty then fills). If so, reserve the height before data.

## 3. Schedules

- Remove the inner panel border around the orbital field so the orbit floats on the page (one frame in the app
  shell, not two). Check `Schedules.tsx` and `radial-orbital-timeline.tsx` for who draws it.
- Node renderer: replace the Phosphor icon-in-a-circle with a small chrome orb — `MetalFrame` at 28px, `radius=9999`,
  same as the centre — carrying a two-letter monogram of the schedule name (`monogram(name)` in `derive.ts`); the
  label under it is the trigger in words (`every 6h`, `on change`) from the existing `scheduleLine`/trigger helpers.
  Paused = orb dimmed to 40 % with a hairline ring; running = a small filled dot at the orb's edge. The
  `TimelineItem.icon` field goes away (delete, don't keep both).

## Deliver

Browser-check Review (with the airline agent selected, then the demo agent, then with no runs), Home hero with both
agents, Schedules with 1 and 3 schedules (create/delete via the dialog; delete what you created), and the
neighbours Agent, Run, Cycle (ConfigDiff still renders), Settings. Screenshots of Review and Schedules before/after.
Write `docs/plans/handoffs/ui-7-report.md` (what shipped, files, decisions where this handoff was silent or wrong,
build/lint/test status, what was not verified). Then stop. Do not commit.
