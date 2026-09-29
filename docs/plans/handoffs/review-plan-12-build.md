# Review — plan 12 build (UI clarity, §9 amended spec)

Reviewer: independent (UX correctness + frontend code quality). Read-only; this file is the only write.
Scope: `web/src` changes named by `frontend-8-report.md`, `ui-10-report.md`, `frontend-9-report.md`.
Baseline: `npm --prefix web run build && npm --prefix web run lint` — build clean, lint 0 errors (only the
pre-existing warnings in `orb.tsx`, `badge.tsx`, `liquid-metal-border.tsx`).

## Verdict: **fix-then-ship**

**Resolution (same day):** findings 1–13 and 15 are fixed in the working tree; `legitClause` now says `same as before`
only when the rates match and `(was j of n)` in either direction — verified in the browser on
`20260925T233010Z`: `normal customers: 4 of 10 pass (was 2 of 10)`. Rule 2 reads the baseline's own gate and
states its rate without a comparison (2), and without a sweep says `Attacks got through in 10 of 12 cycles`
instead of calling cycles attacks (13; verified on `20260922T123017Z`). The inbox row prints the agent's name
and `k of n` (8, 9), `Page` header sits above tables at `z-[15]` (7; `z-30` would have covered the Shell's
mobile menu). Findings 14, 16–19 left as observations. Build clean, lint 0 errors, 522 pytest passed.

The verdict engine is sound: for the five required runs every headline, eyebrow, action and tone matched
what I computed by hand from `/api/cycles`, `/api/state`, `/api/approvals`, and the cycle rows never
contradicted the Cycle page. The vocabulary sweep is complete except for four user-visible strings the
reports missed. One sentence the UI prints today is false: the legit clause on the airline run
`20260925T233010Z` says `same as before` when the fix's normal-customer rate is *better* than the
baseline (4 of 10 vs 2 of 10). That is a one-line fix in `legitClause` and it is the only thing I would
hold the ship on, because "every sentence is true" is the plan's acceptance criterion.

## Findings

| # | Severity | Where | Finding | One-line fix |
|---|---|---|---|---|
| 1 | **blocker** | `web/src/lib/derive.ts:2593-2595` (`legitClause`) | `k >= j` prints `same as before` when `k > j`. Real data: `20260925T233010Z` baseline cycle 1 legit 0.2 (2 of 10), Fix 1 (cycle 6) 0.4 (4 of 10) → UI prints `normal customers: 4 of 10 pass, same as before` on Home (airline), Agent, Run. False by the function's own definition of "before". | `if (k === j) return "…same as before"; return \`normal customers: ${k} of ${n} pass (was ${j} of ${n})\`` — one phrase for both directions. |
| 2 | should-fix | `web/src/lib/derive.ts:2623-2624` (rule 2) | The "run never left v0" verdict takes its legit clause from the **last gated cycle**, i.e. the gate that measured a *rejected* fix, not the config the agent is actually on. No visible falsehood today (every rule-2 run has equal base/last rates) but on the airline, whose gates swing 0.2↔0.4 per cycle, this will print a rejected fix's rate as the agent's. | Use the baseline cycle: `legitClause(cycles, cycles?.find(c => c.gate && c.config_before === 0) ?? null)` and let that path print `normal customers: k of n pass` without the comparison. |
| 3 | should-fix | `web/src/pages/Agent.tsx:405` | Panel title `Regression suite` — loop-internal word, user-visible (reports flagged it, not fixed). | `Past attacks` (matches the Compare-table row label `old attacks`). |
| 4 | should-fix | `web/src/pages/Agent.tsx:409` | `Every attack that lands is added` — banned sense of "lands". | `Every attack that gets through is added`. |
| 5 | should-fix | `web/src/pages/Settings.tsx:116` | `Proposes patches when an attack lands.` — both banned words, visible on Settings → Models (screenshot). | `Proposes fixes when an attack gets through.` |
| 6 | should-fix | `web/src/pages/Onboarding.tsx:677` | `a patch only ships if it fixes the failure…` | `a fix only ships if it blocks the attack and breaks nothing that worked.` |
| 7 | should-fix (pre-existing, surfaced) | `web/src/components/Page.tsx:28` vs `web/src/components/ui/interactive-list-preview.tsx:527` | Page header is `sticky z-10`; the cycle table is `relative z-10` and later in DOM, so rows scroll **over** the header (see `review12-run-094224Z-compare.png`, top-left: row text through `Run · Sep 25, 4:30 PM`). Not introduced by plan 12, but the reworked Run page is where it shows. | `z-30` on the Page header (sidebar is `z-40`). |
| 8 | should-fix | `web/src/pages/Review.tsx:182-184` | Flat inbox spans agents but a row's agent is a 20 px tile with a `title` tooltip only — no visible text, not in the link's accessible name. Airline and demo rows read identically in the a11y tree (`Fix 1 fixes cycle 6 · Timeout on lookup …`). | Add `<span className="sr-only">{item.agent?.name}</span>` inside the link, or a short agent column. |
| 9 | should-fix | `web/src/lib/derive.ts:1716-1722` (`inboxGateLine`) | `normal customers 40% unaffected` — the only place the product says a percent; everywhere else it is `k of n` (Cycle page, gate table, verdict). The inbox item has no `legit_suite_size`, which is why. | Either add `legit_suite_size` to `InboxItem` (api) and route through `normalCustomersLine`, or drop the clause from the row and keep only `blocked in 2 of 2 tries`. |
| 10 | nit | `web/src/components/RunResults.tsx:415` | Rail `aria-label` is `${nameOf(n)}, ${mark}` and `nameOf` already appends `· approved` → screen readers hear `Version 1 · approved, approved`. | Use `versionName(n, made, null)` for the label, keep `mark` as the suffix. |
| 11 | nit | `web/src/lib/derive.ts:2256`, `:2280` | `summaryCells` and `runFacts` are exported but only used inside derive (`aboutFacts`). | Drop `export`. |
| 12 | nit | `web/src/pages/Home.tsx:84` | Eyebrow styled inline (`text-[11px] uppercase tracking-[0.08em] text-white/60`) instead of the token. | `className={cn(eyebrow, "text-white/60")}`. |
| 13 | nit | `web/src/lib/derive.ts:2625-2626` (rule 2 fallback) | Without a sweep, `n` counts cycles whose attack got through and `m = cycles.length`, but the sentence says `attacks`. `20260922T123017Z` (12 cycles, 5 distinct attacks repeated) reads `N of 12 attacks still get through`. Also latent mixed source if `vuln.suite_size > 0` but `landed.v0` absent (`n` from cycles, `m` from suite). | `m = through(0) !== null ? M : cycles.length`, and say `in 12 cycles` rather than `of 12 attacks` when counting cycles. |
| 14 | nit | `web/src/pages/Agent.tsx:310` vs `web/src/components/RunResults.tsx:63` | Agent page mounts `RunResults` with `compareOpen`; the Run page defaults closed. Same component, two disclosure defaults; on Agent the verdict + open table + three panels is the densest screen in the app (`review12-agent-airline.png`). | Pick one default (closed) — the verdict already answers the question the table answers. |
| 15 | nit | `web/src/pages/Review.tsx:138,142`, `web/src/pages/Runs.tsx:27`, `web/src/pages/Schedules.tsx:94` | `land here` / `lands here` / `lands in Runs` — a different, harmless sense of the banned verb, but a reader who just learned "got through" may stumble. | `show up here`. |
| 16 | nit | `web/src/lib/derive.ts:2640-2641` (rule 3, unmeasured) | `Version 1 approved · not yet measured` on `20260922T131319Z` is true but hides that 11 of 12 cycles got through under it (cycle rows say so, the verdict does not). Spec-conformant; consider a detail. | `detail: join([\`${cycles.filter(c => c.attack_succeeded).length} attacks got through before it\`, legit])`. |
| 17 | nit | `web/src/lib/derive.ts:1712` (`inboxItemLine`) | Prints the raw patch note: `rollback to run 20260920T083323Z v4` — a folder id in prose (History rows, `review12-review-history.png`). | Map `run <id>` through `runTitle` when the note matches `/run (\S+)/`. |
| 18 | nit | `web/src/pages/Review.tsx:177` | History's right-hand time column is `decided_at` for decided rows and `run_started` for undecided archived rows — one column, two meanings, no header. | Label undecided rows `run 2 d ago` or drop the time for them. |
| 19 | nit | `web/src/lib/derive.ts:1644` (`certifiedLabel`) | Compare header says `Approved: v1` while the eyebrow above says `Approved: Version 1`. Short form in a table slot is allowed by §9; noting for the "one screen" check. | Leave, or `Approved: ${versionShort(...)}` → `nameOf(...)` since the header has room. |

No division by zero, `NaN`, `undefined`, or `null` reached any rendered string on the five runs or the
other fourteen (checked every run's rule inputs — see "Verified by running").

## Verdict sentences: hand-computed vs rendered

Rules from `runVerdict` (`derive.ts:2606-2660`). `M` = `vulnerability.suite_size`, `through(v)` =
`landed.v{v}`. "Rendered" = what the browser showed on the Run page (and Home/Agents/Agent where noted).

| Run | Inputs | Hand-computed | Rendered | Match |
|---|---|---|---|---|
| `live` (demo, current, finished) | 3 cycles, versions `[0]`, decisions `[]`, `landed {v0:2}`, `suite 2`, last gate legit 1.0 (11/11) | Rule 2. Headline `2 of 2 attacks still get through`, detail `3 cycles · every fix the gate tried was rejected · normal customers unaffected`, no action, tone `warn` | Same on `/app/run` and Home (demo). `2 of 2` in `--danger` | ✓ |
| `20260927T094224Z` (demo) | 22 cycles, versions 0–4, decisions v1 p / v2 p / v3 **rejected** / v4 p, `landed {v0:8, v4:5}`, `suite 8`, cycle 17 (made v4) legit 1.0 | Rule 4, N = 4 (highest not rejected). `Fix 4 would block 3 of the 8 attacks that got through` · `was 0 of 8 before · not approved · normal customers unaffected`, no action (archived), `quiet` | Same on `/app/runs/20260927T094224Z`. Compare header `no fix approved yet`; rail `v3 ×` | ✓ |
| `20260925T233010Z` (airline) | 12 cycles, versions `[0,1]`, decisions v1 pending, no sweep, base legit 0.2 (2/10), cycle 6 (made v1) legit 0.4 (4/10) | Rule 4, N = 1, `through(1)` null, archived → `No fix approved` · `1 fix proposed in an older run · normal customers: 4 of 10 pass, same as before` | Rendered exactly that on Home (airline) and Agent — **and the clause is false** (finding 1; should read `(was 2 of 10)`) | ✓ code, ✗ truth |
| `20260922T131319Z` (airline, v1 hand-applied) | 12 cycles all at v0, `row.versions [0,1]`, `accepted 0`, decisions v1 **approved**, `certified 1`, no sweep | Rule 3, `cycleThatMade(1)` null → name `Version 1`; `through(1)` null → eyebrow `Approved: Version 1`, headline `Version 1 approved · not yet measured`, detail null, no action (archived), `quiet`. Agents tile (no cycles): `accepted 0 ≥ 1` false → `Version 1` too | Same (`review12-run-131319Z.png`); facts line `12 cycles · 14 min · $0.06 · Sep 22, 5:30 AM` | ✓ |
| `20260922T120836Z` (demo, v1 = rollback copy) | 7 cycles, versions `[1,2,3]` from cycles, `accepted 2`, decisions v1 **approved** / v2 p / v3 **rejected**, `landed {v0:7, v3:1}`, `suite 7`, no baseline gate | Rule 3, `cycleThatMade(1)` null → `Version 1`; `landed.v1` absent → `Version 1 approved · not yet measured`, eyebrow `Approved: Version 1`, detail null (no cycle made v1 → no legit), no action, `quiet`. Tile: `accepted 2 ≥ 3` false → `Version 1` | Same (`review12-run-120836Z.png`). Rail `Baseline · Version 1 ✓ · Fix 2 · Fix 3 ×`; Compare header `Approved: v1` | ✓ |

Extra run checked because Home showed it: `20260927T094625Z` → `Fix 1 would block 1 of the 2 attacks that
got through · was 0 of 2 before · not approved · normal customers unaffected` — matches.

Cycle rows vs Cycle page (`20260927T094224Z`): #12 `blocked` ↔ `Judge passed · attack blocked · Repair not
needed · Gate not run`; #17 `got through → fix tried → blocked in 2 of 2 tries → Fix 4` ↔ `Judge failed ·
over refusal · Gate accepted · v3 → v4 · blocked in 2 of 2 tries`; #19 `got through → fix tried → fix
rejected · fix didn't hold` ↔ `Gate rejected · v4 stays · does not fix the new failure (1/2 samples) ·
blocked in 1 of 2 tries`. No contradictions.

## Item-by-item

1. **Truth.** Covered above. Also checked: no action offered on any archived run (`live ?` guards at
   `derive.ts:2641,2653`); `Fix N` only for versions a cycle made (`cycleThatMade`), `Version N` otherwise —
   both edge runs correct; `Baseline`/`Version`/`Fix` consistent on each screen except the `v1` short form in
   `certifiedLabel` (finding 19, allowed).
2. **Vocabulary sweep.** `rg -n -i "landed|unfixed|patch rejected|certified|regression|held |p50|legit|known attacks|Protecting|handled safely|v0 →" web/src --glob '!api.ts'` → every hit is an identifier, API field or comment except `Agent.tsx:405`. A second pass for `\blands?\b|\bpatch(es)?\b` found `Agent.tsx:409`, `Settings.tsx:116`, `Onboarding.tsx:677` (findings 3–6) and the "land here" family (15). `interactive-list-preview.tsx` no longer forces uppercase/tracking on the two text columns (diff verified); `CyclesBox.tsx` only keys colours on status ids; `previewSvg.ts` labels are `accepted · rejected · customers · suite size`; `Shell.tsx` suffixes are `running / paused / watching`; Cycle page prints the backend `gate.reason` verbatim (`legit users unaffected`) — out of plan 12's scope but the one remaining "legit" a user sees.
3. **Run page structure.** Faces: `orbGrid = playing && …` where `playing = watching || live || starting` (`Run.tsx:164,436`) — orbs stay on `starting`/`watching`, leave on `finished`; **read, not run** (no live run was started; the API is the user's). `Compare versions` never renders one column: `versions.length > 1` gates the button and table; the single-version case prints `baselineOnlyLine` (`RunResults.tsx:150-157`). `About this run` state is `useState<string|null>` keyed by run id in the page component (`Run.tsx:490`), and it stayed open across polls in the browser. `Clear this run`: second click confirms, `Escape` cancels (`Run.tsx:250-257`, exercised in the browser); no blur cancel — same as Restore, so consistent. `cycleStory` consistent with three Cycle pages (above).
4. **Review page.** 0 pending on real data → `Nothing waiting for you…` + `History · 44` toggle; History rows show `Fix N · fixes cycle · run · gate · from an older run / decision · when`. `pendingOrder` = `inboxQueue` mapped (`derive.ts:1730`), `pendingNeighbours` unchanged logic (`:1739`). `fixName`: 0 definitions, 0 references — fully folded into `versionName(v, madeByCycle, certified)`. Strip title guarded `item && current ? stripTitle(item) : \`v${v}\`` (`Review.tsx:405`). Editor tabs/tree untouched by the diff. Findings 8, 9, 17, 18 are the row-level issues.
5. **Code organisation.** Spot-checked docstrings on: `runVerdict`, `headlineParts`, `verdictName`, `legitClause`, `runVerdictFacts`, `baselineOnlyLine`, `aboutFacts`, `cycleStory`, `attacksHeading`, `versionName`, `versionShort`, `inboxQueue`, `inboxHistoryAll`, `inboxItemLine`, `inboxGateLine`, `inboxWaitingLabel` — all present, all say why. `Facts.tsx` is gone and `rg Facts` finds only derive functions. No new file under `components/`. Dead exports: `homeStats`, `blocksLine`, `needsAttention`, `attentionWhy`, `fixName`, `inboxRows`, `versionSpanLong`, `cycleOutcome`, `coverageFraction` — 0 definitions, 0 references each. Remaining dead `export`s: `summaryCells`, `runFacts` (finding 11). Duplicate-helper check: `versionName` / `versionNameIn` / `verdictName` are one function plus two adapters (cycles-based, row-based) — fine. `gateLine` / `gateShort` / `inboxGateLine` are three phrasings of one fact; the third exists because the inbox item lacks `legit_suite_size` (finding 9). JSX choosing words: the only user-facing strings left in JSX are page copy (empty states, panel titles), not derived facts.
6. **Design standard.** One emphasis per screen holds on Home (card carries the verdict; `Home` title is 16 px), Run (verdict `displayHead`, everything else 12–13 px), Review (title + one list). Agent is the weak one (finding 14). `--danger`/`--live` appear only on the `k of n` lead and the `×`/`✓` marks. `#N` column right-aligned tabular across all rows. `eyebrow` token used everywhere except Home (finding 12); `displayHead` on Cycle and the verdict only.
7. **Neighbours.** Cycle page (3 cycles) fine. Runs table: live row `current · finished`, `v0 → v1` short forms, 19 runs. Schedules: one orbit, `Sweep · every day`. Settings → Models renders (finding 5 wording). Onboarding step 2 renders with `eyebrow` step line, fields, Ping disabled until URL.

## Verified by running vs by reading

**Ran:** build + lint; `curl` of `/api/runs` and, for all 19 runs, `/api/cycles`, `/api/state`, `/api/approvals` (rule inputs tabulated: versions, decisions, certified, landed, base legit, last-gated legit); browser: Home (airline + demo via the switcher), Agents grid, Agent (airline), `/app/run` at rest incl. Clear two-click + Escape and About across ≥3 polls, `/app/runs/20260927T094224Z` incl. Compare open across polls and the matrix, `/app/runs/20260922T120836Z`, `/app/runs/20260922T131319Z`, cycles 12/17/19, `/app/review` empty + History, `/app/runs`, `/app/schedules`, `/app/settings/models`, `/app/onboarding/2`.

**Read only (not exercised):** `starting` and `watching` faces (would need to start a run or replay on the user's API); the `Measure →` action path (`kind: "measure"`, live-only); Agents-tile verdict without cycles (computed by hand from the rows, tiles matched); the Review editor (unchanged by the diff).

## Screenshots

`/var/folders/gk/4js863bx5k175g264xx0cyg80000gn/T/cursor/screenshots/`

- `review12-home-airline.png`, `review12-home-demo.png` — Home, both agents
- `review12-agents.png` — Agents grid
- `review12-agent-airline.png` — Agent page, airline (Compare open by default)
- `review12-run-live.png`, `review12-run-live-about.png` — `/app/run` at rest; About open
- `review12-run-094224Z.png`, `review12-run-094224Z-compare.png` — history run; Compare + matrix (header overlap visible top-left)
- `review12-run-120836Z.png` — rollback-copy run (`Version 1 approved · not yet measured`)
- `review12-run-131319Z.png` — hand-applied run (same headline, `$0.06` facts line)
- `review12-cycle-17.png`, `review12-cycle-19.png` — Cycle pages used for the story check
- `review12-review-history.png` — Review with History open
- `review12-runs.png`, `review12-schedules.png`, `review12-settings-models.png`, `review12-onboarding-2.png` — neighbours
