# UI 10 — Review: the flat inbox

Plan 12 §5 as reduced by §9 ("Review (§5), reduced" is the authoritative bullet) with review findings 10, 12, 13, 14 folded in.
`/app/review` is now one flat list of every version waiting for a decision, across agents, with the decided and archived
versions behind a single `History · N` line. The editor and its tree are structurally unchanged (finding 10: no synthetic
`Older runs` root). Build and lint clean: `npm --prefix web run build` OK; `npm --prefix web run lint` 0 errors, 10 warnings, all
pre-existing and none in the two files this lane touched. Nothing committed.

Lane boundary held: only `web/src/pages/Review.tsx` and the named inbox functions in `web/src/lib/derive.ts` were edited.
`pendingOrder`, `pendingNeighbours`, `inboxTree`, `gateShort`, `stripTitle`, `tabLabel` keep their names; `inboxTree`,
`pendingNeighbours` and `tabLabel` are byte-identical. One build failure mid-lane (`Home.tsx` importing a not-yet-exported
`cycleRef`) was the other lane mid-edit; it passed on the first 60 s retry.

## What changed

**`web/src/lib/derive.ts` — inbox section (1583–1710) and the four vocabulary producers**

- Deleted: `inboxRows`, `inboxKey`, `inboxName`, `inboxPending`, `inboxHistory`, `inboxBadge`. Nothing else imported them.
- Added `InboxEntry = InboxItem & { agent: InboxAgent["agent"] }` — the agent tagged onto each item client-side in the flatten,
  as §5 says; the API shape is untouched.
- Added `inboxQueue(inbox)`: every `pending` item across agents, sorted current-run first, then newest `run_started`, then highest
  version. `inboxHistoryAll(inbox)`: the `archived` items then the `decided` ones, each in the same order. Both go through one
  private `inboxFlat(inbox, kind)` and one private comparator `byInboxOrder`, so the inbox has one ordering rule.
- `pendingOrder` now maps `inboxQueue` — same output shape, so the editor's prev / next arrows are unaffected.
- `inboxItemLine(item)` lost its gate part: it is now just `fixes cycle 6 · Timeout on lookup`, or the patch note for a version no
  cycle made (`no patch note` if that is empty — never happens in today's data). The gate moved to its own column:
  `inboxGateLine(gate)` → `blocked in 2 of 2 tries · normal customers 100% unaffected`, null when no gate ran.
- `fixName(version, madeByCycle)` → `Fix 4` / `Version 4` (finding 12). Kept deliberately separate from the §2 lane's planned
  `versionName(v, approvals, final)` so the two lanes cannot collide on an export; if §2 lands, `fixName` should fold into it.
- `inboxWaitingLabel(queue)` → `3 waiting` / null, so the header shows nothing when nothing is waiting.
- Vocabulary: `pendingLabel` archived case `N undecided` → `N not reviewed`; `decisionLabel` → `from an older run`;
  `ARCHIVED_RUN_NOTE` → `This fix can't be approved — decisions are made on the current run.`; `gateShort` →
  `blocked 2/2 tries · customers 11/11 · tested 11/11` (`fixed k/k` → `blocked k/k`, `legit` → `customers`, `guard` → `tested`).
- `stripTitle` uses the long name: `Fix 3 · fixes cycle 8 · …` / `Version 1 · rollback to …`. Its `Pick` widened to include
  `cycle` (a type-level widening; the one caller passes a whole `ReviewItem`).

Not touched, on purpose: `gateLine` still says `held 3/3 trials` (§9 lists it as a missed producer, but it is not in this lane's
list); `reviewTree`'s `fixes` fallback still says `v${v}`; `ReviewItem` was not given a "made by a cycle" field (see decisions).

**`web/src/pages/Review.tsx`**

- `Inbox` rewritten: `inboxQueue` rows in a hairline list, or the one-line empty state `Nothing waiting for you. Fixes the current
  run proposes land here.` (no panel — finding 14). Header action is `N waiting` or nothing. Under it one `textButton` with a
  `.u-line` span, `History · 44`, toggling `inboxHistoryAll` in the same row layout. Two `useState`s (per-agent open/history maps)
  became one boolean. The "No agents yet" line stays for an empty inbox array.
- `InboxRow` columns: `AgentTile` 20 px (hollow square + `deleted agent` title when the agent row is gone) · `fixName` at a fixed
  76 px · what it fixes (`flex-[3]`) · run title (`hidden sm:inline`, 150 px, history only — finding 13) · gate line (`hidden
  lg:inline`, `flex-[2]`) · decision column (history only, 110 px right-aligned: `ReviewMark compact` or the words `from an older
  run`) · `fmtAgo` at 72 px · arrow. The two prose columns share width 3:2 instead of a fixed gate width: at a 1024 px viewport
  a fixed 300 px gate column starved the attack title down to ~120 px (seen in the first screenshot, fixed before the second).
- Editor: the header title shows `stripTitle(item)` only once the run's cycles are read (`item && current`); before that it is
  the short `v4`. Reason: `Fix N` vs `Version N` depends on `item.cycle`, which `inboxTree` can only fill for the run whose cycles
  are loaded — without the guard the title would read `Version 4` for a moment and then flip to `Fix 4`.
- Removed the `InboxItem` import (rows take `InboxEntry`), the six dead derive imports; added `fixName`, `InboxEntry`,
  `inboxGateLine`, `inboxHistoryAll`, `inboxQueue`, `inboxWaitingLabel`. Docstrings on `Review`, `Inbox`, `InboxRow` rewritten.

## Decisions

- **`Fix N` needs to know a cycle made the version; the tree only knows that for the loaded run.** The clean fix is a field on
  `ReviewItem` (e.g. `madeByCycle`), but `ReviewItem` and `reviewTree` are outside this lane. Chosen: use `item.cycle` and guard
  the strip title until cycles are read. Cost: the header reads `v4` for the first ~200 ms of a deep link. The tree's compact rows
  and the tabs keep `v4` as the plan says, so nothing else needed the long name.
- **History order** keeps archived-undecided first, then decided (today's `inboxHistory` order), each newest-run-first. The
  undecided ones are what a reviewer might still want to look at; decided ones are the record.
- **`inboxItemLine` keeps `fixes cycle N ·`** in front of the short title rather than moving the cycle to a `#N` right column (§3's
  rule for `resultsRows`), because the same string is `ReviewItem.fixes` in the tree and the strip; changing it in one place would
  make the inbox and the editor disagree.
- **`gateShort`'s customers cell is a fraction, not a percent** (`customers 11/11`): `legitPct` already yields `k/n`, and the
  brief said "keep short" — the words changed, the number format did not.
- **`inboxWaitingLabel` is tiny** but exists so the header's word choice lives in derive with the rest (code-organization rule:
  labels are named pure functions).

## What I saw (browser, real data, Sep 27 12:30–12:35 PM)

- `/app/review`: header `Inbox` with no count; the one line `Nothing waiting for you. Fixes the current run proposes land here.`;
  `History · 44` beneath it (39 archived + 3 decided on the demo agent, 1 + 1 on the airline agent — matches
  `GET /api/review/inbox`).
- History open: 44 rows, demo-agent tiles orange, the airline agent's tile blue; `Fix 1 · fixes cycle 2 · Malformed lookup ·
  Run · Sep 27, 2:42 AM · blocked in 2 of 2 tries · normal customers 100% unaffected · from an older run · 10 h ago` first;
  Sep-13 runs disambiguated by the run column (finding 13); the airline row reads `normal customers 40% unaffected`. The last four
  rows are the decided ones with `rejected` / `approved` pills right-aligned in the same column as `from an older run`; the two
  cycle-less ones read `Version 1 · manual: cycle-6 patch applied by hand…` and `Version 1 · rollback to run 20260920T083323Z v4`.
- Click `Fix 4` (run `20260927T094224Z`) → `/app/review/20260927T094224Z/4`: title `Fix 4 · fixes cycle 17 · Ambiguous order
  reference leads agent to disclose another customer's record`; gate `blocked 2/2 tries · customers 11/11 · tested 11/11`; pill
  `from an older run`; prev / next both disabled (queue is empty); tree unchanged — 13 run roots, `Run · Sep 25, 4:30 PM` open with
  `v4 … pending`, `v3 … rejected`, closed roots read `3 not reviewed` etc.; tab `system_prompt.md`.
- `/app/review/20260922T120836Z/1`: title `Version 1 · rollback to run 20260920T083323Z v4`, `approved` pill, `5 d ago`.
- Breadcrumb `Review` → back to the inbox, history collapsed again (state is per mount, as before).

## Not verified

- A non-empty queue. Pending is 0 for every agent today (finding 14), so the queue rows, `N waiting`, and prev / next walking the
  queue were exercised only through `pendingOrder` keeping its output shape — not on screen. To see it: start a run on `live`
  that accepts a fix, then reload `/app/review`.
- A deleted agent's row (hollow tile, `deleted agent` tooltip) — no such row in today's data.
- Widths below 1024 px (the gate column hides under `lg`, the run column under `sm`; not screenshotted).
