# Plan 12 — UI clarity: one verdict per agent, outcomes not internals

Owner: Owen. Written Sep 27 after a page-by-page audit (chat, 11:53 AM). Scope: the five audit items agreed —
verdict line, version renaming, outcome vocabulary, Run page as a story, flat Review. **Not** in scope: the nav
consolidation (audit item 6). Two days to the CoreWeave Hacks deadline: every item must degrade to today's
behaviour if its data is missing, and nothing here changes an API contract or a run file.

## 0. Facts this plan stands on (verified Sep 27, `file:line`)

- Hero facts strip = `homeStats` (`web/src/lib/derive.ts:2433`): `versionSpan`, `blocksLine(state.vulnerability, final_version)`,
  `runSummary(cycles).legit`, `fmtDate`. "Needs attention" = `needsAttention` (2456): `attack_succeeded && (!gate || !gate.accepted)`,
  tagged `patch rejected` / `never patched` (2464).
- Per-run approved version = `Approvals.certified` (`GET /api/approvals?source=`, `api/main.py:388`; `chaos/state.py:185` highest
  approved else 0). **There is no per-agent approved version and no API view of gateway enforcement** (the gateway's `/health` is on
  its own port, `chaos/gateway.py:444`). The closest client-side signal is the newest shadow-log event's `mode` (`gatewayLine`, derive 1408).
- Vulnerability counts live on `State.vulnerability` (`api/main.py:315`): `landed {"v0": n}`, `suite_size`, optional `by_attack`. Not on `RunRow`.
- Legit rate / coverage for a version: `cycleThatMade(cycles, v).gate.legit_pass_rate / legit_covered` (derive 1164).
- `Agent.tsx` shows `runsForAgent(runs, id)[0]` (newest) and passes `RunResults` `runId,row,cycles,state,approvals,manifest` (300-310).
- `Run.tsx` renders the four `Orb`s whenever a last run exists (573-620) and the `About this run` grids (`runFacts` 2179, `summaryCells`
  2160) in RunResults' `between` slot for history runs only (626). `runMode` (derive 557) gives `watching | live | starting | finished`.
- `RunResults.tsx` sections: Versions panel (gate rows `gateRows` 1198, decision row, attack matrix `matrixRows`/`matrixCell` 1252/1291,
  `MeasureAction`), `between`, `Attacks on version N` list with `VersionRail` + `resultsRows` (2234) whose statuses are
  `blocked | repaired | unfixed | failed` rendered uppercase by `interactive-list-preview.tsx:556`.
- Review: `Inbox` (Review.tsx 125-184) rows per agent with `show history`; `Editor` tree = `inboxTree` (derive 1662) — one root per run,
  13 roots on the demo agent; header pill `decisionLabel("pending", decidable)` → `pending · archived run` (1729, 1733).
- Type: no scale tokens; the Cycle headline is `text-[28px] font-medium leading-[1.2] tracking-[-0.02em]` (`Cycle.tsx:101`); the tracked
  label is the literal `uppercase tracking-[0.08em] text-[var(--faint)]` in six files. `lib/ui.ts` has no label/display export.
- Vocabulary producers: almost all in `derive.ts` (rows 1204-1223, 2237-2252, 2464, 1540, 1729, 380). JSX literals: `RunResults.tsx:112,142,162,174,201`,
  `Run.tsx:591`, `Home.tsx:97`, `Agent.tsx:395`.

## 1. The verdict — one sentence per agent, everywhere an agent is shown

**What.** A pure function `agentVerdict(runs, latest: {row, cycles, state, approvals} | null): Verdict` in `derive.ts`:

```ts
interface Verdict {
  headline: string;      // "Blocks 5 of 8 known attacks" | "3 of 8 attacks still get through" | "No fix approved yet" | "Not tested yet"
  detail: string | null; // "normal customers unaffected · protecting since Sep 25" | "was 1 of 8 before Antibody"
  action: { label: string; href: string } | null; // "1 fix awaiting your review →" → reviewVersion(run, v)
  tone: "good" | "warn" | "quiet";
}
```

Rules, in order: no runs → `Not tested yet` / action `Run Heal →` (quiet). Latest run has a certified version `c > 0` and
`state.vulnerability.landed["v{c}"]` exists → headline `Blocks (suite − landed) of suite known attacks`, detail `normal customers unaffected`
(when `cycleThatMade(c).gate.legit_pass_rate === 1`) or `N of M normal-customer tasks still pass`, plus `was (suite − landed.v0) of suite before`
when `landed.v0` exists; tone good when landed = 0, warn otherwise. No certified version but pending versions exist →
`No fix approved yet`, action `N fixes awaiting your review →`. Certified but vulnerability not measured → `Fix N approved · not yet measured`
with action `Measure →` (live only; reuse `measureBlocker`). Everything reads from data the pages already fetch; nothing new from the API.

**Where.** `AgentCard` hero: the facts strip (`homeStats`) is replaced by the verdict — headline at the Cycle headline size, detail muted,
action as a `.u-line` link. `Agents` tiles: the headline as the card's second line instead of `built in · demo agent · in-process`
(needs `cycles/state/approvals` for each agent's latest run: one `usePoll` per tile is 3N reads — instead the Agents page reads them
for the agents that have runs, N ≤ 3 today; cap at 6, others show `Not tested yet`). `Agent` page header: the verdict replaces the
`Versions` panel as the first thing on the page; the matrix moves under `Compare versions` (§4).

**Delete.** `homeStats`, `blocksLine` (folded into the verdict), the `Facts` strip on the hero (keep `Facts` — used by Settings/Run).

## 2. Versions named by role

`versionName(v, approvals, final): string` in `derive.ts`: `Baseline` for v0; `Protecting` for `approvals.certified`; `Fix N` for every
other `v > 0` (N = v — fixes are numbered by their version so the URL and the name agree). A `versionShort(v)` keeps `v0`/`v4` for table
headers with a `title` giving the long name. Applied to: `versionSpan` (`Baseline → Fix 4`, and `→ Protecting` when certified), the
`VersionRail` stops, the matrix column headers (short form + title), `ReviewMark`/decision pill text, the Review tree and inbox rows
(`Fix 4 · fixes …` instead of `v4 · fixes cycle 17 · …`), the Cycle page's `v4 stays`, Home recent runs pill. URLs, `api.ts` and the
backend keep integers. Nothing is renamed on disk.

## 3. Outcome vocabulary — one table, applied in `derive.ts`

| Today (producer) | After |
| --- | --- |
| `landed` / `blocked` / `not measured` (1285-1294, 2476) | `got through` / `blocked` / `not measured` |
| `regression k/n` (770, 985, 1208, 2349) | `old attacks still blocked k/n`; row label `old attacks` |
| `legit k/n`, `legit · coverage a/b · c/d` (1210, 1625, 2166) | `normal customers k of n unaffected`; coverage becomes a `title`, never a second fraction in the cell |
| `legit guard covers n/m tasks` (122, 2168) | `n of m normal-customer tasks tested` |
| `held k/k` (1624, 1892) | `blocked in k of k tries` |
| `fixed k/k` (512, 1204) | row label `this attack`, cell `blocked k of k` |
| `unfixed` / `repaired` / `failed` / `blocked` (RowStatus 51-56) | `still gets through` / `fixed` / `broke` / `blocked` — and `interactive-list-preview` stops uppercasing `client`/`status` |
| `patch rejected` / `never patched` / `patched → vN` (2246-2252, 2464) | `fix didn't hold` / `no fix tried` / `fixed by Fix N` |
| `certified vN` / `nothing certified` (1540) | `Protecting: Fix N` / `no fix approved yet` |
| `pending · archived run` (1729) + `ARCHIVED_RUN_NOTE` | pill `from an older run`; note `This fix can't be approved — decisions are made on the current run.` |
| `p50 latency` (1223, 2170) | `typical reply` |
| `decision` row label (RunResults 142) | `your review` |
| `cycle N · title` (2237), `Cycle N` (Home 97) | title only; the cycle number moves to the right column as `#N` |
| `Attacks on version N` (RunResults 201) | `What Fix N was tested against` / `Every attack in this run` |
| `finished · not archived` (2398) | `finished` (the pin on the Runs page already says which is current) |
| helper captions: RunResults 203, Run "Where it ran, what it found…", Schedules "click a node to open it", Settings "Every row is a flag of chaos.loop run" | deleted |

Rule: `derive.ts` is the only place a user-facing word is chosen; the JSX literals listed in §0 move into it.

## 4. Run page as a story

Order, top to bottom, for a finished run (current or history; `runMode === "finished"`):

1. **Verdict card** — `runVerdict(row, cycles, state, approvals)`: headline `4 fixes accepted · Fix 4 blocks 3 of 8 attacks that got through before`
   or `No weaknesses found in 3 cycles` or `3 attacks got through · no fix held`; second line `22 cycles · 41 min · $0.94 · Sep 25, 4:30 PM`;
   action `Review Fix 4 →` when pending, `Measure →` when unmeasured and live. Same type as §1.
2. **The cycles as a timeline** — the existing attacks list, but every row is one sentence built from the Cycle page's five steps:
   `Injected instructions in order notes → got through → fix tried → blocked in 2 of 2 tries → Fix 2` / `… → got through → fix didn't hold`.
   `resultsRows` gains `story: string` (`cycleStory(c)` in derive); `VersionRail` stays (renamed stops), default `all` for history, final
   version for the current run as today.
3. **`Compare versions`** — a collapsed disclosure holding today's Versions panel (gate rows + attack matrix + Measure). Open by default only
   when there are ≥ 2 versions **and** the run is the one the Agent page shows; never rendered as a one-column table: with one version the
   panel is replaced by one line `Only the baseline was tested · N of M attacks got through` (+ Measure).
4. **`About this run`** — the two grids (`runFacts` + `summaryCells`) become one quiet key/value list under a collapsed disclosure; `seed`
   and `world` stay there, they leave the first screen.

Orbs: when `runMode === "finished"` the four `Orb`s are not rendered; the verdict card takes their place. They stay for `live | starting`.
`clear` becomes `Clear this run` with a confirm (`window.confirm` is already the pattern for delete-agent — check; else the existing dialog).

## 5. Flat Review

Inbox: one flat list of every pending item across agents — columns `agent tile · Fix N · what it blocks · gate line · when · →`; sorted
live-first then newest; header count. Under it one quiet line `History · N decided and archived →` that toggles the full history list
(same rows, with the decision mark or `from an older run`). No per-agent expanders. `inboxRows/inboxKey/inboxName/inboxPending/inboxHistory`
collapse into `inboxQueue(inbox): InboxItem[]` and `inboxHistoryAll(inbox)` — each row carries its agent (`InboxItem` gains `agent` client-side
in the flatten, not in the API).

Editor tree: `inboxTree` returns only the open run's root expanded and **one** synthetic collapsed root `Older runs (12)` that expands to
the list of runs (title + pending count) — click a run to expand it in place. Breadcrumb unchanged. Header pill per §3.

## 6. Emphasis and type

Two exports in `lib/ui.ts`: `displayHead = "text-[28px] font-medium leading-[1.2] tracking-[-0.02em] text-[var(--fg)]"` (the Cycle
headline, reused for verdicts) and `eyebrow = "text-[11px] uppercase tracking-[0.08em] text-[var(--faint)]"`; the six literal copies become
imports. Signals: `--live` only on a verdict with tone good and the `Protecting` name; `--danger` only on `got through` and `broke`. No
new tokens, no new fonts.

## 7. Acceptance

- Home, Agents, Agent, Run (live + history), Review, Cycle each answer "is my agent safe, is anything waiting for me" from the first screen.
- `rg -n "landed|unfixed|patch rejected|certified|regression|held |p50" web/src --glob '!api.ts'` returns only `derive.ts` internals (RowStatus
  ids, API field names) — no user-visible strings.
- One-version runs never render a one-column matrix; runs with no cycles show `Not tested yet`, not empty grids.
- `npm --prefix web run build && npm --prefix web run lint` clean; no new dependency; no API or run-file change; the 522 Python tests untouched.
- Browser-checked on the real data: Home (airline agent), Agents (3 tiles), Agent (airline + demo), Run for `live` (one version) and
  `20260927T094224Z` (five versions), Review inbox + editor, Cycle 18, Schedules, Settings.

## 9. Amendments after the independent review (`handoffs/review-plan-12.md`, Sep 27 12:40) — these override §1–§6

- **Verdict rules (§1), rewritten.** Inputs: the run to describe (Home/Agents: the agent's newest run; Agent page: the *picked* run — the
  verdict is `runVerdict`, one function for both), its `cycles`, `state.vulnerability`, `approvals`. Filter `approvals.decisions` to `v > 0`.
  1. No run → `Not tested yet` · action `Run Heal →` (selects the agent via `onSettingsChange({target})` then goes to `/app/run`); for
     `example` while stopped: detail `Start it, then Heal`, no action.
  2. Run has cycles and no version > 0 (every fix rejected) → `N of M attacks still get through` (from `landed.v0`/`suite_size`, else
     `runSummary.blocked`/`cycles.length`) · detail `K cycles · every fix the gate tried was rejected`.
  3. A certified version `c > 0` → `Approved: Fix c` as the eyebrow; headline `Blocks B of the M attacks that got through` when
     `landed["v{c}"]` exists (B = M − landed), else `Fix c approved · not yet measured` (+ `Measure →` only on `live`).
  4. No certified, but versions > 0 exist → `Fix N would block B of the M attacks that got through` when measured, else
     `Fix N proposed · not approved`; action `Review Fix N →` **only when the run is `live`**; on an archived run the detail says
     `proposed in an older run` and there is no action.
  5. Detail's legit clause compares to baseline: `normal customers unaffected` when the rate equals the baseline's (first gated cycle
     with `config_before === 0`), else `normal customers: k of n pass (was j of n)`. Never `still pass`.
  Words: never `known attacks` (M is the run's final suite); never `Protecting` — `Approved` is the fact on record. Tone `good` only
  when B = M.
- **Naming (§2).** `Fix N` only when a cycle made the version (`InboxItem.cycle`/`cycleThatMade` non-null); otherwise `Version N` with the
  patch note as the line (rollback copies, hand-applied patches — both exist in the data). Long names on the Home hero and verdicts only;
  `versionShort` (`v4`) everywhere tabular: Runs table, run picker, matrix headers (with `title`), `runHeaderLine`, `runFacts`.
- **Vocabulary (§3) corrections.** `p50 latency` → `typical cycle` (it is whole-cycle time). `unfixed` → `fix rejected` with the gate's
  first sentence as the reason cell (a rejection is not always the fix failing — cycle 4 of `…094224Z` passed 2/2 and lost on legit).
  `failed` → `no fix tried`. `finished · not archived` → `current · finished` (there is no pin on Runs). Add the missed producers:
  `gateShort` (1908), `smokeLine` (2665), `gateLine` (1897).
- **Run page (§4).** Orbs are only on `/app/run`'s at-rest face today; that is the one face that changes. `Clear` uses `Run.tsx`'s existing
  two-click `confirm` pattern (there is no `window.confirm` in the app). `RunResults` takes `compareOpen?: boolean` so the Agent page can
  open it by default; the disclosure's `useState` survives polling because the component is not remounted.
- **Review (§5), reduced.** Build the flat inbox with: a `run` column on history rows (titles repeat across 13 runs), the empty line
  `Nothing waiting for you. Fixes the current run proposes land here.` (one line, no panel), then `History · N →`. **Cut** the synthetic
  `Older runs` tree root: `flattenTree` already collapses closed roots to one row, and returning only the open run would drop other runs'
  tabs (`liveTabs`). The editor tree is unchanged.
- **Emphasis (§6).** The hero card's title is already display size, so the Home verdict is 20px/medium *inside* the card (the HealOrb slot
  pattern), not a second 28px element under it. Agents tiles: headline only (needs `state.vulnerability` + `approvals`, two small reads;
  never `cycles`), and `example` keeps its `starting… / running / stopped` word. `eyebrow` is the 11px variant, no `font-medium`; the four
  10.5px sites (Home, Shell, Runs, Onboarding) move to it.
- **Order and cut list.** §3 → §1 (Home + Agent) → §4 → §6 → §2 → §5. If a lane runs late, cut in this order: §5, `cycleStory` (keep the
  existing rows with renamed statuses), §2 beyond rail/matrix headers, §1 on Agents tiles.
- §0 corrections: `Facts` is used by Home and Run (not Settings); drop the derive 380 citation; `Agent.tsx` shows the picked run.

## 8. Risks and the honest bits

- The verdict's "was N of M before" needs `landed.v0`, which exists only when vulnerability was measured; otherwise the detail line is
  just the legit line. The airline agent's runs are all unmeasured, so its hero will say `No fix approved yet · 1 fix awaiting your review`.
- "Protecting" is a promise the UI cannot verify: nothing in the API says the gateway is up on that version. The word is used for the
  approved version only; the Agent page adds a quiet line from the shadow log (`gatewayLine`) when there is one, else nothing.
- Renaming in the Cycle page's `Gate` step and the replay captions (`replayLine`) is included; the demo tape's recorded strings are data
  and stay as recorded.
