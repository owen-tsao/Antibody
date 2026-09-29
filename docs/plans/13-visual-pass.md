# Plan 13 — the visual pass, and Review as decisions

Owen, Sep 28: "all these surfaces just look cheap … maybe the grey, thin separating lines, or something else."
Home is already reverted to the card + facts strip + Needs attention + Recent runs layout (plan 12 §1 undone
there only; the verdict still lives on Run, Agent and the Agents tiles).

## Diagnosis (checked against `web/src/index.css` and the four screenshots)

1. **Lines do the work surfaces should.** The page is `#000` and every panel, table and strip is also `#000`,
   so structure can only be drawn with outlines — and on pure black 8 % lines vanished (Owen, Sep 20), so they
   were pushed to `--border` 14 %, `--border-2` 22 %, `--frame` 30 %. A 30 % hairline renders ≈ `#4d4d4d`,
   *brighter than the tertiary text* (`--faint` `#5f5f68`). The eye lands on boxes, not content: wireframe.
   The standard's rule 3 — floor vs panel contrast — was never applied; the fix is a panel surface, after which
   the lines can come back down.
2. **Flat type.** 11–13 px, one weight, and the primary thing in a row is often `--muted` (Review's attack title,
   Runs' agent). Nothing in a row is the headline; small + dim + single weight reads as cheap.
3. **Two visual languages.** The hero card is rich (photo, 30 px radius, 4 px frame); everything else is thin
   outlines and 40 px rows. Beside the card the tables look unfinished.
4. **Layout tells.** Six evenly spread centred columns leave the Runs content floating in gutters; a full-width
   divider under every row is a spreadsheet; outlined pills and tracked-uppercase headers on every surface are
   UI-kit defaults.

## §1 Tokens (`index.css`) — the whole pass hinges on these

| token | was | now | why |
| --- | --- | --- | --- |
| `--card` | `#0c0c0e` | `#0e0e11` | the panel/table surface — one visible step off the `#000` floor |
| `--border` | .14 | .10 | dividers *inside* a lifted panel need less |
| `--border-2` | .22 | .16 | hover / emphasis edge (standard value) |
| `--frame` | .30 | .16 | a panel edge on a lifted surface; the hero keeps its own `#6C6C6C` frame — it is the one loud element |

Kill condition: if `--card` on `#000` is not visibly a surface on Owen's display, raise `--card` to `#111114`
before touching anything else; never push the borders back up.

## §2 Shared pieces

- `Panel`: `bg-[var(--card)]`, `--frame` edge. `PanelRow`: title `--fg` 13 px **500**, line 12 px `--muted`
  (was `--faint`), trailing `--muted`. Rows keep the hairline; the surface carries the rest.
- `lib/ui.ts` gains `pill`: filled `--inset`, no border, 11.5 px `--muted`, tabular. Outlined badge pills
  (`rounded-full border`) move to it; the version rail's radio stops are controls, not badges, and stay.
- Tables (`Runs`, cycle list, compare): on `--card`, `--frame` edge, header row eyebrow, **text columns left,
  numeric columns right** (tabular), the primary column in `--fg` 500, the rest `--muted`.

## §3 Per surface

- **Runs**: Started (fg 500) · Agent (flex) · Config as `pill` · Cycles · Duration (right) · Status · watch.
  Gutters go because the flexible column is the agent name, not the status.
- **Run / Agent** cycle list: title fg 13 px 500; the story text 12 px `--muted`; `#N` faint.
- **Review inbox**: pending versions become **decision cards** (§4); history is the restyled row list, folded.
- **Home**: facts strip and panels take the surface. Nothing else changes (reverted today).
- **Cycle, Settings, Schedules, Agents**: tokens + `Panel` carry them; no page edits unless a screenshot says so.

## §4 Review as decisions

The pending queue is 1–3 items and every one is on the live run (`api/main.py review_config` is live-only;
`InboxItem.live`), so the decision can be taken where the item is listed. One card per pending version:

```
[tile] Demo agent (built in)                                        2 d ago
Fix 2 · A friend asks for the status of another customer's order        ← 15 px 500 fg
blocked in 2 of 2 tries · normal customers unaffected                   ← 12.5 px muted
<patch note from GET /api/configs?source=live, when it has one>         ← 12.5 px muted, truncated
Open the diff →                                   Reject   [ Approve ]
```

Approve/Reject call `api.review(version, status)` exactly as the editor's `StripActions` does, then re-read the
inbox and the shell. Failure prints under the card's footer, keyed to the version. `Open the diff →` is the
existing `reviewVersion(run, version)` route — the editor is unchanged. Empty queue: one quiet sentence, no
panel (standard rule 4). History: `History · 44` toggle, the row list restyled per §2.

## Verification

Screenshots before/after on Home, Runs, Run (`20260927T094625Z`), Review (pending + history), Agent, Cycle,
Settings, Schedules at 1440 wide; contrast of body text ≥ 4.5:1 on `--card`; build + lint; Review decide path
exercised once for real (approve on the live run's pending version is destructive — use Reject on a scratch
run or check the request body only).

## Built (Sep 28)

§1–§4 as written, with two departures: the cycle list on Run/Agent stays on the page floor (it is a document page —
standard rule 8 — and its gsap hover already carries the row hierarchy), and the version rail keeps its outline
because it is a control, not a badge. Screenshotted on the real API: Home, Runs, Current run, Review inbox
(two cards), Review editor, Agent, Settings. Not exercised: an inline Approve/Reject on the cards (the only pending
versions are on Owen's live run; the call is the editor's `api.review`, unchanged), and the inbox at a width
below `lg` (cards stack to one column by the grid rule, not checked in the browser).
