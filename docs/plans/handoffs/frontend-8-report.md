# Frontend 8 — vocabulary, version names, type exports (plan 12 §3, §2, §6)

Sep 27, Sunday afternoon. Scope: the global rename sweep the review asked to run first — outcome words in
`derive.ts`, `Baseline` / `Fix N` / `Version N` naming, and the two type constants in `lib/ui.ts`. No verdict (§1),
no Run-page restructure (§4), nothing under `Review.tsx` or the inbox / review-tree functions in `derive.ts`
(another engineer's lane; I saw their `gateShort` change land in the same file while I worked and left it alone).

Nothing here changes an API call, a run file, or a route. Every rename is a string a person reads.

## What a person now reads (before → after → where)

### Outcome words

| Before | After | Where it shows |
| --- | --- | --- |
| `landed` (matrix cell) | `got through` — in the signal colour, the only red word in the matrix | Run / Agent Versions panel, attack matrix |
| `5 of 8 land`, row label `land` | `5 of 8 got through`, row label `got through` | counts-only matrix (runs measured before per-attack flags) |
| `attacks · landed / blocked per version` / `how many land per version` | `attacks · got through / blocked per version` / `how many get through per version` | matrix group caption (`matrixCaption`) |
| row `fixed`, cell `2/2` | row `this attack`, cell `blocked 2 of 2` | matrix gate rows |
| row `regression`, cell `2/4` | row `old attacks`, cell `2/4` | matrix gate rows |
| row `legit · coverage`, cell `11/11 · 11/11` | row `normal customers unaffected`, cell `11 of 11`; the coverage is the cell's tooltip (`GateRow.cellTitles`) | matrix gate rows |
| row `p50 latency` | row `typical cycle` (whole-cycle time, per review finding 4) | matrix gate rows, About-this-run facts |
| row `decision` | row `your review` | matrix |
| `regression 2/4` | `old attacks still blocked 2/4` | Cycle page Gate step, live cycle timeline Gate line and sub-rows, hover chart footer |
| `legit 11/11` / `legit users 11/11` | `normal customers 11 of 11 unaffected` (dropped, not `—`, when the guard ran no task) | Cycle page Gate step, cycle timeline, `gateLine` (Review strip tooltip), chart footer |
| `legit guard covers 10/11 tasks` | `10 of 11 normal-customer tasks tested` | run header line, Cycle Gate step, About facts (`normal-customer tasks tested`) |
| `held 3/3 trials`, `fixed 2/2` | `blocked in 3 of 3 tries` (`… — not accepted` when a sample failed) | `gateLine`, Cycle Gate step, timeline sub-row |
| `legit guard did not run` / `no legit flow newly broken` | `normal-customer check did not run` / `no normal-customer flow newly broken` | live cycle timeline Gate sub-rows |
| `No legit task runnable against this target — the gate cannot protect normal users` | `No normal-customer task could run against this target — the gate cannot protect normal customers` | the one red warning line (Run, Cycle, Versions panel) |
| status `UNFIXED` / `REPAIRED` / `FAILED` / `BLOCKED` (uppercase, tracked) | `fix rejected` / `fixed` / `no fix tried` / `blocked` — sentence case, no tracking (`rowStatusLabel`) | cycle list on Run and Agent, CyclesBox header, hover chart title |
| services `patch rejected` | the reason: `fix didn't hold` / `breaks a normal-customer flow` / `reintroduces an old failure` (`gateRejection`) | cycle list right column |
| services `patched → v3` | `fixed in v3` | cycle list right column, onboarding smoke line |
| services `never patched` | `no fix tried` | cycle list right column |
| services `blocked` (duplicated the status word) | `handled safely` — see "judgment calls" | cycle list right column |
| `cycle 4 · <title>` | title alone; `#4` in the right column | cycle list (`ResultsRow.ref`), Home attention cards |
| tag `patch rejected` / `never patched` | `fix rejected` / `no fix tried` | Home "Needs attention" cards |
| `Nothing outstanding — every attack that landed was patched.` | `… every attack that got through was fixed.` | Home attention empty state |
| `blocks 3 of 8 known attacks` | `blocks 3 of the 8 attacks that got through` (review finding 22: the suite is not a catalogue) | Home facts strip (`blocks` value) |
| `certified v3` / `nothing certified` | `Approved: v3` / `no fix approved yet` | Versions panel aside |
| `patches accepted` / `patches rejected` | `fixes accepted` / `fixes rejected` | About-this-run facts, live stats plate |
| `legit users 3/3` (live plate, JSX literal) | `normal customers unaffected 3 of 3` (`normalCustomersStat`) | Current run stats plate while a run plays |
| `Attacks on version 4` | `What Fix 4 was tested against` / `What the baseline was tested against` / `Every attack in this run` (`attacksHeading`) | cycle list heading |
| `finished · not archived` | `current · finished` | Runs table status |
| `Patch accepted, re-measuring baseline` | `Fix accepted, re-measuring baseline` | in-flight cycle placeholder |
| `11 legit tasks` | `11 normal-customer tasks` | domain hint (Settings, wizard) |
| `would_block` → `would block` (JSX literal) | same word, now `gatewayDecisionLabel` in derive | Agent page shadow log |
| `attack landed a verdict` | `attack reached a verdict` | onboarding smoke empty line |
| hints: `per landed attack`, `every attack that landed`, `legit tasks`, `(new, regression, legit)`, `certified version's tool rules` | `per attack that gets through`, `that got through`, `normal-customer tasks`, `(this attack, old attacks, normal customers)`, `approved version's tool rules` | RunSettingsFields hints, Cycle page Weave link title, Settings gateway line |
| hover chart legend `legit` | `customers` (suite-size legend shifted 22 px right to make room) | `previewSvg` |

Deleted captions: RunResults' "Hover a row to see how the cycle went…" paragraph and its per-version sentence; Run's
"Where it ran, what it found, and what you can do with it."; Schedules' "click a node to open it"; Settings' "Every row
is a flag of `chaos.loop run`…".

### Version names (§2 as amended by §9)

- `versionName(v, madeByCycle, certified)` → `Baseline` / `Fix N` / `Version N`; `certified === v` appends ` · approved`
  (the fact on record). The word "Protecting" appears nowhere.
- `versionShort(v)` → `v0`… `versionNameIn(cycles, v, approvals)` reads `madeByCycle` off the records so pages do not
  repeat the rule.
- Long names only on the Home hero: `config` now reads `Baseline → Fix 1` (`versionSpanLong`; short span until the
  cycles are read). Everywhere tabular stays short: Runs table, run picker, header line, About facts, matrix headers,
  rail stops, rollback pills, `fixed in v3`.
- Matrix headers and VersionRail stops carry the long name as `title` and (rail) `aria-label`: `v3` shows, `Fix 3,
  rejected` is announced.

### Type (§6)

- `lib/ui.ts` exports `displayHead` (28px, the Cycle headline, now used there) and `eyebrow` (11px, no `font-medium`).
- 11 literal sites replaced: RunResults ×2, Facts, Agents ×2 (`text-white/70` still wins over the photo — verified
  in the browser that twMerge drops the faint colour), ScheduleDialog, Home, Shell, Onboarding, Runs. Schedules' site
  went with its caption. The four 10.5px/medium sites (Home, Shell, Runs, Onboarding) are now 11px/regular — a
  visible half-point change in the sidebar's `Workspace` label and the Runs header.
- `interactive-list-preview.tsx` no longer uppercases or tracks the `client` and status cells.

## Files touched

`web/src/lib/ui.ts`, `web/src/lib/derive.ts` (outside the inbox / review-tree block), `web/src/lib/previewSvg.ts`,
`web/src/components/RunResults.tsx`, `Facts.tsx`, `CyclesBox.tsx`, `Shell.tsx`, `ScheduleDialog.tsx`,
`RunSettingsFields.tsx`, `ui/interactive-list-preview.tsx`, `web/src/pages/Home.tsx`, `Agent.tsx`, `Agents.tsx`,
`Run.tsx`, `Runs.tsx`, `Cycle.tsx`, `Schedules.tsx`, `Settings.tsx`, `Onboarding.tsx`.

New derive exports: `rowStatusLabel`, `cycleRef`, `versionName`, `versionShort`, `versionNameIn`, `versionSpanLong`,
`oldAttacksLine`, `normalCustomersCell`, `normalCustomersLine`, `chartFooter`, `gateRejection`, `matrixCaption`,
`gotThroughLine` (was `landedLine`), `attacksHeading`, `normalCustomersStat`, `gatewayDecisionLabel`, `orbWordLabel`. `GateRow`
gained optional `cellTitles`; `ResultsRow` gained `ref`; `MatrixCell` is now `"got through" | "blocked" | "not measured"`.
Removed: `coverageFraction`, `landedLine`. `legitPct` and `regressionPct` stay exported — `gateShort` (the other lane)
still uses `legitPct`.

## Acceptance

- `rg -n "landed|unfixed|patch rejected|certified|regression|held |p50|legit " web/src --glob '!api.ts' --glob '!**/derive.ts'`
  → identifiers, comments and API field names only: `api.regression` (route), `regression_pass_rate` /
  `regression_suite_size` (fields), `CyclesBox` `unfixed:` (dot key), `certifiedLabel` (import/call), code comments in
  `Run.tsx`, `Onboarding.tsx`, `settings.ts`, `ImportIncidentDialog.tsx`, `previewSvg.ts`. Note the plan's glob
  `!lib/derive.ts` does not exclude the file from where `rg` is run; `!**/derive.ts` does.
- In `derive.ts` the remaining hits are: `RowStatus` ids and their `case` labels, the `certified` parameter / API field,
  `regression_*` field names, `regressionPct` / `regressionDenom`, `OrbWord "regression"` (an orb state id — it *was*
  rendered raw under the Target orb during the gate; it now goes through `orbWordLabel` and reads `re-running old
  attacks`), `vuln.landed` (API field), `p50LatencyMs` (field on `RunSummary`), and docstrings. No user-facing string.
- `npm --prefix web run build` clean; `npm --prefix web run lint` 0 errors (5 pre-existing warnings in `ui/orb.tsx`).
- Browser (Cursor tab, 1920 wide, real API data): Home, Agents, Agent (airline), Runs, Run `20260927T094224Z`, Cycle 18
  of it, Schedules, Settings run-defaults, plus `/app/run` as a neighbour. Review not opened.

## What I saw

- Run `…094224Z`, five columns: every gate cell fits on one line. The first pass had the `normal customers unaffected`
  row label wrapping inside the 200 px label column and pushing the row taller; I widened the label column to 220 px
  and set the row headers `whitespace-nowrap`. After that a DOM check found zero wrapped cells; the numeric columns
  are ~183 px each. 13 `got through` cells in red (v0 and v4 were measured per attack, v1–v3 read `not measured`).
- The cycle list rows read `#18  fix rejected  fix didn't hold` at the right, title on the left, no caps.
- Cycle 18's headline carries `displayHead`; the Gate step reads `rejected · v4 stays · … · blocked in 0 of 2 tries —
  not accepted · old attacks still blocked 4/7 · normal customers 11 of 11 unaffected · 11 of 11 normal-customer tasks tested`.
- Home (airline agent): facts `Baseline → Fix 1 · not measured · 3 of 10 · Sep 22, 6:13 AM`; attention cards `#12 fix
  rejected`. `Fix 1` is right — the newest airline run's cycle 6 made v1 (I checked the records; the hand-applied v1
  of `20260922T131319Z` would read `Version 1`).
- Agent (airline): two-column matrix, `What Fix 1 was tested against`, rail `v0 · v1 · all`, aside `no fix approved yet`.
- Runs: header row now 11px/400; live row `current · finished`.
- Schedules: caption gone, orbit renders. Settings run-defaults: no `legit`, no flag caption; domain hint says
  `11 normal-customer tasks`.

## Judgment calls and what I left

- **`handled safely`** for a blocked attack's services cell: the plan kept `blocked` there, but the status cell beside
  it already says `blocked`, and with the caps gone the row read `blocked blocked`. Easy to revert to `blocked` in
  `cycleOutcome` if you prefer the plan's word.
- **`fixed in v3`**, not `fixed by Fix 3`: §3 wrote the long name, §9 says short everywhere tabular; the list is tabular.
- **`versionName`'s `certified`**: the signature you asked for. With "Protecting" forbidden, I gave it the only honest
  use — ` · approved` on that version — so the parameter is not dead (`noUnusedParameters` would also have failed the
  build).
- **`old attacks` cell stays `k/n`** (plan's wording). Same numbers as before; only the label changed.
- **`--danger` on `got through`**: applied per §6. The count can be high on a well-measured run (13 red cells here).
  Say so if it reads as noise and I will drop it back to `--fg`.
- **Not touched**: `Review.tsx`, `gateShort` / inbox / tree functions,
  `ReviewMark`'s docstring mentioning `pending · archived run` (that label is Review's), the `Versions` panel title
  and `Cycle N` header line inside CyclesBox (the plan's `#N` rule was for list rows and the Home cards).
- **Not verified**: the live stats plate (`normal customers unaffected 3 of 3`) and the orb word `re-running old
  attacks` — no run was playing; both are one-liners over data the About block already renders. The wizard's smoke
  line (`got through · fixed in v1`) — not run.
