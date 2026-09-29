# Review of plan 12 — UI clarity

Reviewer pass, Sep 27 (Sunday, ~12:30 PM). Read-only. Everything below was checked against the working tree and the
running API (`GET /api/runs`, `/api/state`, `/api/approvals`, `/api/review/inbox`, `/api/cycles` on :8000). Where I
could not verify something I say so.

## Verdict: **build with changes**

The shape is right — one verdict per agent, outcome words, story-first Run page — and almost every `file:line` in §0
is correct. But four things in the plan are false as written and would ship wrong sentences: the verdict rules produce
a dead-end action on every real agent today (all pending versions are on archived runs, which cannot be approved);
`Protecting` is unverifiable and, on archived runs, wrong; `typical reply` mislabels a whole-cycle latency; and the
confirm/pin/Facts facts in §0/§3/§4 point at things that do not exist. §5's editor-tree change breaks the tab strip.
Fix those, cut §5, and the rest is a Monday build.

## Findings

| # | Sev | Where | Finding | One-line fix |
| --- | --- | --- | --- | --- |
| 1 | **High** | plan §1 rules; real data: airline latest run `20260925T233010Z`, demo `20260927T094224Z` | "N fixes awaiting your review →" is offered for pending versions on **archived** runs. Approvals are live-only writes (`api/main.py` review; `ReviewItem.decidable = runId === "live"`, derive 1679/1703). Today **every** pending version in the inbox is `archived` (0 `pending` across both agents). The link lands on an editor with a `pending · archived run` pill and no buttons. | Only say "awaiting your review" when `latest.row.id === "live"`; else `No fix approved · N proposed in an older run` with no action (or `Run again →`). |
| 2 | **High** | plan §1 rule order; `live` run today | A run with cycles but only v0 (every fix rejected — `live` today: 3 cycles, 3 rejected, `landed {v0: 2}`) matches **no rule**: no certified, no pending `v > 0` (note `approvals.decisions` *includes* v0 as pending — must be filtered). Verdict would be empty. | Add rule: `versions.filter(v>0).length === 0 && cycles.length > 0` → `N of M attacks got through · no fix held` (from `landed.v0`/`suite_size`, else `runSummary.blocked`/`cycles`). |
| 3 | **High** | plan §2, §6, §8; `chaos/state.py:185`, `chaos/gateway.py:133` | `Protecting` for `approvals.certified` is per-**run**. The gateway follows the **live** approvals file only. Archived runs `20260922T120836Z` and `20260922T131319Z` both have `certified: 1`; naming that column `Protecting` says something false. Even on `live`, nothing in the API says a gateway is running (plan §8 admits this). | Use `Approved` (a fact on record). Reserve `Protecting` for never; if you want the word, gate it on `runId === "live"` **and** a `gatewayLine` event with `mode === "enforce"` — which the demo agent never has. |
| 4 | **High** | plan §3 row `p50 latency` → `typical reply`; derive 1223-1228, 2170 | The number is the **median cycle latency** (attack + judge + repair + gate — the row's own tooltip says so). Calling it "typical reply" claims a customer-facing latency the run never measured. | `typical cycle` (or `time per cycle`). |
| 5 | **High** | plan §1 detail line; airline run `20260925T233010Z` | `N of M normal-customer tasks still pass` reads as damage done by the fix. The airline **baseline** already passes 2–4 of 10 legit tasks (cycles 1–5, `config_before = 0`); cycle 6's fix (v1) gate is 0.4 — no worse than before. gate.py tolerates already-failing legit rows (derive 981-982 comment). | Compare with baseline: `normal customers: 4 of 10 pass (same as before)` / `… (was 6 of 10)`; only say "unaffected" when rate is unchanged, not only when it is 1.0. |
| 6 | Med | plan §3 row `unfixed` → `fix didn't hold` | A gate rejection is not always the fix failing pass^k. `20260927T094224Z` cycle 4: `pass_k 2/2` passed, rejected because legit dropped to 0.91. "didn't hold" is wrong there. | `fix rejected` for the status word; put the *reason* (`firstSentence(gate.reason)`) in the services cell / story. |
| 7 | Med | plan §3 row `failed` → `broke` | "broke" has no subject in a status column (the attack broke the agent? the fix broke?). `never patched` was clearer. | `no fix tried` (matches the `patched → vN` → `fixed by Fix N` row). |
| 8 | Med | plan §4 "`window.confirm` is already the pattern for delete-agent — check" | Verified: **no** `window.confirm` anywhere in `web/src`. The pattern is a two-click inline confirm: `Agent.tsx:259-273` (`confirming` → "confirm delete · cancel") and `Run.tsx:317-352` rollback (`confirm` state, Escape cancels). | Reuse `Run.tsx`'s `confirm` pattern for Clear; no dialog, no `window.confirm`. |
| 9 | Med | plan §3 row `finished · not archived` → `finished` "the pin on the Runs page already says which is current" | Verified: `Runs.tsx` has **no pin** and no other current-run mark; the current run is distinguished only by position and this status word (`runStatusLabel`, derive 2395-2399). | Keep a mark: `current · finished`, or add the pin first. |
| 10 | Med | plan §5 editor tree; derive 1741-1750 (`TreeNode`, `treeKey`), 1829-1831 (`liveTabs`), Review.tsx 267-275 | A synthetic `Older runs (12)` root needs a fourth `TreeNode` kind and shifts depths (`depth: 0/1/2` are literal types; `indentGuides`, `onTreeKey` switch on kind). If `inboxTree` returns *only* the open run's root, `liveTabs` drops every tab of another run (Review.tsx:267 — "tabs from any version stay open" breaks) and `runTitleOf` (275) falls back to raw ids. | Cut. `flattenTree` (1761) already collapses non-current, non-selected roots to one row each — 12 closed rows is the existing behaviour. If you must save space: a plain button *under* the tree that hides closed roots; not a tree node. |
| 11 | Med | plan §1 "Where" — Agent page | `Agent.tsx` shows the **picked** run (`pickedRun`, 127-129), newest by default — not "`runsForAgent(runs, id)[0]`" as §0 says. An agent-level verdict about the latest run above an older picked run's matrix contradicts itself. | On the Agent page use `runVerdict(picked run)` (§4's function), not `agentVerdict`. |
| 12 | Med | plan §2 `Fix N`; inbox item `20260922T120836Z v1 "rollback to run 20260920T083323Z v4"` (approved); airline `20260922T131319Z v1 "manual: cycle-6 patch applied by hand…"` | Real data has versions no cycle made (`cycle: null`). "Fix 1" for a rollback copy of another run's v4, or for hand-applied starter rules, is misleading — and `parent_version` is only on `GET /api/runs/{id}` `configs`, not on inbox items. | `versionName` takes the cycle (or `InboxItem.cycle`): `Fix N` only when a cycle made it, else `Version N` and keep the patch note as the line (today's behaviour, derive 1621/1676/1700). |
| 13 | Med | plan §5 inbox columns `agent tile · Fix N · what it blocks · gate line · when · →` | History rows repeat titles across 13 runs (`Order lookup returns null` × 9); today the run title is the disambiguator (Review.tsx:197-199). `when` = `fmtAgo` collapses six Sep-13 runs to `14 d ago`. | Keep a `runTitle` column on history rows. |
| 14 | Med | plan §5; inbox today | Pending is **0** for every agent. The flat inbox on launch is an empty list plus `History · 43 …`. Plan gives no empty-state wording; standard rule 4 says no "Nothing here" panel. | One line, not a panel: `Nothing waiting for you. Fixes the current run proposes land here.` then the History line. |
| 15 | Med | plan §1 hero; `AgentCard.tsx:84-92`, Home.tsx:66-75 | Emphasis budget: the hero card's title is already display size (`clamp(24px,9cqw,72px)`). A 28px `displayHead` verdict directly under it is a second loud element on Home. | Verdict at 20px/medium under the card, or inside the card's overlay slot (`children`, the HealOrb pattern) as the subline. |
| 16 | Med | plan §1 Agents tiles | Replacing the tile's second line drops the example agent's `starting… / running / stopped` state (`agentSubline`, derive 2549-2551), which the tile is the only place to show. Also: reading `cycles` (120 KB for `20260927T094224Z`) per tile just for the legit detail. | Tile headline needs only `state.vulnerability` + `approvals` (2 small reads); keep the state word for `example`; no detail line on tiles. |
| 17 | Low | plan §0 "`Facts` — used by Settings/Run" | `Facts` is used by `Home.tsx:75` and `Run.tsx:476,478`; Settings does not import it. | Fix the note; keep `Facts` (Run still uses it). |
| 18 | Low | plan §0 vocabulary producers "…, 380" | derive 380 is `argsKey` (JSON key sort), not a user string. | Drop the citation. |
| 19 | Low | plan §3 row `legit k/n … (1210, 1625, 2166)` | 1625 produces `legit 85%`, a percent, not `k/n`. Also missed producers: `gateShort` 1908-1911 (`held`, `fixed`, `legit`, `guard`), `smokeLine` 2665-2677 (`patched → v1`, `patch rejected`), `gateLine` 1897 (`legit users k/n`). | Add them to the table; the acceptance `rg` in §7 would catch `held ` at 1908 anyway. |
| 20 | Low | plan §0 "six files" for the tracked label; §6 `eyebrow` | Verified 11 files carry the literal, in two variants: `text-[11px]` (RunResults ×2, Schedules, Facts, Agents ×2, ScheduleDialog, interactive-list-preview ×2) and `text-[10.5px] font-medium` (Home, Shell, Onboarding, Runs). One `eyebrow` export means picking one. | Pick `11px`, no `font-medium`; note the Shell/Runs change in the PR. |
| 21 | Low | plan §0 "`Run.tsx` renders the four `Orb`s whenever a last run exists" | `orbGrid = (playing \|\| lastRun)`; `lastRun` requires `id === "live"` (derive 578-580). History run pages have **no** orbs today. §4's change only touches the `/app/run` at-rest face. Empty face (`empty`), `starting`, `watching` are separate branches and unaffected. | Fine — narrow the sentence. `Compare versions` open state: `useState` inside `RunResults` survives `usePoll` re-renders (no remount while `results` stays true, Run.tsx:625); pass `compareOpen` default as a prop since `RunResults` cannot know it is on the Agent page. |
| 22 | Low | plan §1 "Blocks 5 of 8 known attacks" | `suite_size` is the run's **final regression suite** (`api/store.py:194-203`): attacks that landed on some version in this run (+ seeds/imports). Attacks blocked from the start never enter it. "known attacks" over-claims. | `Blocks 3 of the 8 attacks that got through` / `5 of 8 attacks that got through still do`. |
| 23 | Low | plan §2 `versionSpan` → `Baseline → Fix 4` | `versionSpan` also feeds the Runs table `text-center` cell (Runs.tsx:85), the Agent run picker (`runPickerLabel`, 300 px panel), `runHeaderLine` and `runFacts`. `Baseline → Protecting` is 3× the width. | Long form on Home hero only; `versionShort` everywhere tabular. |
| 24 | Low | plan §1 action `Run Heal →` for an agent with no runs | Heal lives on `/app/run`'s empty face for the **selected** agent (`settings.target`); a plain href cannot select. `example` is only `selectable` while running (derive 2607). | Action calls `onSettingsChange({target: id})` then navigates; for `example` stopped, say `Start it, then Heal`. |

Verified-correct §0 facts (no action): `homeStats` 2433, `needsAttention` 2456, `attentionWhy` 2464, `/api/approvals` main.py:388, `approved_version` state.py:185, `gateway.health` 444, `vulnerability` main.py:315, `cycleThatMade` 1164, `runMode` 557, `gateRows` 1198, `matrixRows/matrixCell` 1252/1291, `resultsRows` 2234, `runFacts/summaryCells` 2179/2160, `inboxTree` 1662, 13 demo-agent roots (13 distinct runs in the inbox — confirmed), `decisionLabel` 1729, `ARCHIVED_RUN_NOTE` 1733, `Cycle.tsx:101`, JSX literals RunResults 112/142/162/174/201/203, Run 591, Home 97, Agent 395, `interactive-list-preview` 556 (and 563 for the status cell). `RowStatus` strings are UI-internal only: no use in `golden/`, tests, or backend (grep), and `CyclesBox.tsx:14` `RESULT_DOT` is keyed on them — so rename the **label**, keep the ids (the plan already says this). `interactive-list-preview` takes `status?: string`, no colour map — any label works. `lib/ui.ts` exporting class strings is exactly how it is used today (`primaryButton`, `textButton`, `textInput`, `fieldLabel`, `outlineButton`), so §6 fits.

## The four verdicts, as the plan's rules would print them — and as they should

Data verified from the API at review time.

**1. Airline agent** — latest run `20260925T233010Z`: 12 cycles, versions `[0, 1]`, `certified 0`, v1 pending, no `vulnerability`, cycle-6 gate `legit 0.4`, `covered 10/11`. Note an *older* run `20260922T131319Z` has `certified 1` (hand-applied patch).

- Plan: `No fix approved yet` / `4 of 10 normal-customer tasks still pass` / `1 fix awaiting your review →` — the action is a dead end (archived run), and the detail blames the fix for a baseline that already failed 6–8 of 10.
- Should read: **`No fix approved`** · `1 fix proposed in the last run · normal customers: 4 of 10 pass, same as before` · action none (or `Run again to review a fix →`).

**2. Demo agent, latest run `live`** — 3 cycles (not one), all landed, all three fixes rejected, versions `[0]`, `landed {v0: 2}`, `suite_size 2`, `legit 1.0`.

- Plan: no rule matches (see finding 2) → blank, or, if v0's `pending` decision is counted, the false `1 fix awaiting your review`.
- Should read: **`2 of 2 attacks still get through`** · `3 cycles · every fix the gate tried was rejected · normal customers unaffected` · action none (the run is `live`, unmeasured → no; it *is* measured, so no `Measure →` either).

**3. Demo agent, run `20260927T094224Z`** — 22 cycles, versions `[0..4]`, `certified 0`, v3 rejected, v1/v2/v4 pending (archived), `landed {v0: 8, v4: 5}`, `suite 8`, `by_attack` on v0 and v4, gate accepted 4 / rejected 15 / blocked 3.

- Plan §1: `No fix approved yet` / `3 fixes awaiting your review →` — dead-end action, and the measured fact (v4 blocks 3 of 8) never surfaces because "certified" gates the headline. Plan §4 (`runVerdict`): `4 fixes accepted · Fix 4 blocks 3 of 8 attacks that got through before` — the numbers are right (`was 0 of 8` before).
- Should read (both pages): **`Fix 4 would block 3 of the 8 attacks that got through`** · `was 0 of 8 before · not approved · normal customers unaffected` · action none (archived). "would block" because nothing is approved and nothing is enforcing it.

**4. Example agent** — no runs.

- Plan: `Not tested yet` / `Run Heal →`. Correct words. The link must also select the agent (finding 24), and while the example agent is stopped it cannot be selected at all.
- Should read: **`Not tested yet`** · `Start it, then Heal` (stopped) / `Run Heal →` (running).

"Blocks N of M known attacks" honesty: M is the attacks that landed at some point in this run (final regression suite), not a catalogue. Say "of the M attacks that got through". "Protecting": not defensible — see finding 3; use "Approved".

## Vocabulary rows I would change

| Plan row | Change to | Why |
| --- | --- | --- |
| `p50 latency` → `typical reply` | `typical cycle` | It is whole-cycle latency (finding 4). |
| `unfixed` → `still gets through` / `patch rejected` → `fix didn't hold` | status `fix rejected`; services cell = `firstSentence(gate.reason)` | Rejections are also for legit breaks and regressions (finding 6). |
| `failed` → `broke` / `never patched` → `no fix tried` | status `no fix`; services `no fix tried` | "broke" has no subject (finding 7). |
| `certified vN` → `Protecting: Fix N` | `Approved: Fix N` | Per-run and unverifiable (finding 3). |
| `finished · not archived` → `finished` | `current · finished` | No pin exists (finding 9). |
| `legit k/n` → `normal customers k of n unaffected` (matrix cell) | row label `normal customers unaffected`, cell `k of n` | Five 19-char cells at 12.5px is ~150 px each — fits but only just; the label carries the words once. |
| `held k/k` → `blocked in k of k tries` | keep, but apply to `gateShort` 1908 too, where the strip is 48 px and `lg:` only — use `k/k tries` there | Producer missed (finding 19). |
| (new) `landed` cell → `got through` | keep as planned; `--danger` only on this and nothing else in the matrix | Consistent with §6. |
| (new) `Attacks on version N` → `What Fix N was tested against` | for v0: `What the baseline was tested against` | `versionName(0)` is `Baseline`; the sentence needs the article. |

Rows I would keep exactly as planned: `regression` → `old attacks still blocked`, `legit guard covers` → `n of m normal-customer tasks tested`, `decision` → `your review`, `cycle N · title` → title + `#N` right, helper-caption deletions, `pending · archived run` → `from an older run`.

## Standard check (my-ui-standard)

- Emphasis budget: Home gets a second loud element (finding 15). Agent page: verdict + three bordered panels is fine if the verdict is typography, not a framed card. Run page: the verdict card replaces the orbs — one focus object, good; make sure the `MetalFrame` stats plate does not survive alongside it.
- Progressive disclosure: `Compare versions` and `About this run` collapsed by default is right. The one-version rule (`Only the baseline was tested · N of M attacks got through`) is the best line in the plan — keep `Measure` reachable beside it on `live`.
- Empty states: plan is silent on the flat inbox with 0 pending (finding 14) and on the Agents tile for an agent whose latest run is unreadable (`cycles === null` today shows `Could not read this run.` on Agent.tsx:307) — tile should fall back to `Not tested yet`, never `…` forever.
- Alignment: matrix column headers switching to `versionShort` + `title` keeps the 5-column table aligned; the long names would not.

## Scope for Tuesday midnight (it is Sunday noon)

Ranked by value ÷ risk:

1. **§3 vocabulary** (with the row changes above) — half a day, `derive.ts` strings, near-zero risk, biggest read-through win. Do first.
2. **§1 verdict, Home + Agent** — with findings 1, 2, 3, 5, 11 folded into the rules. One day. `agentVerdict` and `runVerdict` should be one function over `{row, cycles, state, approvals}`; the Agent page passes the picked run.
3. **§4 Run page** — orbs off at rest, `Compare versions` disclosure, `About` collapsed, two-click Clear. Half a day. `cycleStory` rows are the optional half.
4. **§6 type constants** — an hour, alongside 2.
5. **§2 naming** — `Baseline` / `Fix N` / `Version N` (no `Protecting`) on rail, matrix headers (short + title), Review strip, inbox line. Half a day; touches many call sites, so last.
6. **§5 flat Review** — cut. Pending is 0 today; the inbox already collapses quiet agents to one line; the editor-tree change breaks tabs.

Cut order if a lane runs late: §5 (whole) → §4 `cycleStory` → §2 beyond the rail + matrix headers → §1 Agents tiles (keep Home + Agent).

## Not verified

- Rendered widths of the 5-column matrix at the app's real content width (I did not open the browser). Finding 19's "fits" is arithmetic at 12.5px, not a screenshot.
- Whether `agentSubline`'s `airline domain` suffix is something anyone reads on the tile; I assumed the state word matters more than the domain.
