# Frontend lane 9 — the verdict (plan 12 §1, §4, §9)

**Branch:** working tree, uncommitted. **Scope:** `web/src` only. **Build:** `npm --prefix web run build` clean;
`npm --prefix web run lint` 0 errors (four pre-existing warnings in `orb.tsx`, `useDwell.ts`, `badge.tsx`, `button.tsx`).

## What changed, for a person

Every page that shows a run now leads with one sentence — the verdict — about what the run found and where that
leaves the agent. The same function writes it everywhere (Home card, Agents tiles, Agent page, Run page, history),
so the four pages can no longer disagree. The Run page reads as a story: verdict, then the cycles as one-sentence
rows, then `Compare versions` folded away, then `About this run` folded away. The four idle orbs no longer appear on a
finished run; the verdict takes their place.

## The four acceptance verdicts, as rendered on real data

Checked in the browser against the running API (`/api/runs`, `/api/cycles`, `/api/state`, `/api/approvals`):

| Run | Headline | Detail | Action |
| --- | --- | --- | --- |
| Airline, `20260925T233010Z` | `No fix approved` | `1 fix proposed in an older run · normal customers: 4 of 10 pass, same as before` | none |
| `live` (demo, 3 cycles, v0 only) | `2 of 2 attacks still get through` | `3 cycles · every fix the gate tried was rejected · normal customers unaffected` | none |
| `20260927T094224Z` | `Fix 4 would block 3 of the 8 attacks that got through` | `was 0 of 8 before · not approved · normal customers unaffected` | none |
| No run, example agent stopped | `Not tested yet` | `Start it, then Heal` | none |
| No run, any other agent | `Not tested yet` | — | `Run Heal →` |

Also seen: `20260922T131319Z` renders eyebrow `APPROVED: VERSION 1` over `Version 1 approved · not yet measured`
(a rollback copy, so `Version`, not `Fix`); the legacy archive `continuation-2026-09-13` (an approvals file with no
decisions) reads `Fix 3 would block …` rather than falling into the "never left v0" rule.

## derive.ts

- `runVerdict(row, cycles, vuln, approvals, agentState?) → Verdict` — §9's rules in order: no run; no version past
  v0 (`every fix the gate tried was rejected` when the cycles are in, `no fix accepted` when only the row is);
  an approved version (eyebrow `Approved: Fix N`, `Blocks B of the M attacks that got through`, or `… approved · not
  yet measured` + `Measure →` when live); a proposed version (`Fix N would block …` when measured, `Fix N proposed ·
  not approved` + `Review Fix N →` when live and unmeasured, `No fix approved · k fixes proposed in an older run`
  when archived). `decisions` filtered to `v > 0`; an empty decisions list falls back to the run's versions, all
  pending. `M` is always the run's own suite; the words are "that got through", never "known".
- `legitClause` — the normal-customer clause compared with the run's baseline (first gated cycle with
  `config_before === 0`): `unaffected` / `k of n pass, same as before` / `k of n pass (was j of n)`.
- `verdictName` — `Fix N` vs `Version N` without the cycles: every version is a fix only when the row accepted as
  many fixes as it has versions past v0.
- `headlineParts` — splits a leading `2 of 2` so pages can colour the number alone.
- `cycleStory(c)` — the row sentence: `blocked` · `got through → no fix tried` · `got through → fix tried → blocked in
  2 of 2 tries → Fix 2` · `got through → fix tried → fix rejected · fix didn't hold`. `ResultsRow.services` became
  `story`; `cycleOutcome` (the `handled safely` wording) is gone.
- `runVerdictFacts(row, cycles)` — `22 cycles · 41 min · $0.94 · Sep 25, 4:30 PM`.
- `baselineOnlyLine(cycles, vuln)` — `Only the baseline was tested · N of M attacks got through`.
- `aboutFacts(row, summary)` — `runFacts` + `summaryCells` as one list.
- Deleted: `homeStats`, `versionSpanLong`, `blocksLine`, `needsAttention`, `attentionWhy`, `fixName` (folded into
  `versionName(v, madeByCycle, null)`; `inboxItemLine` and `Review.tsx` updated). `held` left the vocabulary.

## Pages and components

- **Home** — the verdict sits inside the card's lower half at 20px/medium (the HealOrb slot pattern), detail muted
  under it, the action as a `.u-line` link. `Run Heal →` selects the agent and navigates to `/app/run`;
  `Review Fix N →` opens the review. The facts strip and the Needs-attention panel are gone; Recent runs stays.
  `AgentCard` got a `subline` slot (second call site: Agents). `components/Facts.tsx` deleted (no call sites left).
- **Agents** — each tile's line is the verdict headline from two small reads per agent with runs (`state` +
  `approvals`, cap 6, never `cycles`), polled at 30 s and re-read when the run set changes. Agents past the cap or
  whose reads fail get the verdict the row alone supports — never `…` for good. `example` keeps its state word:
  `stopped · Not tested yet`.
- **Agent** — `RunResults` now opens with the verdict at `displayHead`; the page passes `compareOpen`, so the matrix
  starts open when the run has ≥ 2 versions.
- **RunResults** — order is verdict → cycles timeline (rows are `cycleStory`; the separate status word was dropped
  because it duplicated the sentence) → `Compare versions` disclosure holding the old Versions table, or one line
  when the run has one version (+ Measure when live) → the host's `after` slot. Default rail stop is `all` for a
  finished run, the final version for `live`. Matrix cells: `got through` is `--fg` medium, `blocked` `--muted`;
  `--danger` remains only on the `warn` verdict's leading number and the legit-coverage alert.
- **Run** — orbs render only while `live | starting | watching`; a finished run's one-line header stands down for
  the verdict card (it stays only to carry the crash line). `About this run` is a collapsed key/value `<dl>` of
  `aboutFacts` with the settings line and coverage alert inside; `Watch it back` / `Restore a version` stay in view
  under it. `clear` became `Clear this run` — second click confirms (`Yes, clear it · cancel`), Escape cancels,
  the same pattern as Restore. `StatsPlate` remains for the live run only.
- **Settings** — the Vulnerability-measurement hint no longer says `known attacks`.

## Verified in the browser (Vite :5173, API :8000)

Home, Agents, `/app/run`, `/app/runs/20260927T094224Z` (both disclosures opened), `/app/runs/20260922T131319Z`
(approved eyebrow), `/app/agents/builtin` (one version → single line), `/app/agents/example-airline` (Compare open by
default), Review history rows (`Fix 1 · fixes cycle 2 · …`). `Clear this run` first click shows the confirm; Escape
cancels; nothing was archived.

## Not done / not verified

- No run was started, cleared, measured, rolled back or reviewed during verification, so the live-only actions
  (`Review Fix N →` on a live run with a pending fix, `Measure →` on a live approved-but-unmeasured run, the
  confirmed Clear) are exercised only through the derive check, not end to end.
- Home's `Run Heal →` branch was checked by reading `runVerdict(null, …)`; there is no agent with zero runs in the
  fixture, so the click path was not walked.
- Tone `good` (`Blocks M of the M attacks`, `No weaknesses found`) has no fixture run; only reviewed by reading.
- Browser checks were in Cursor's Chromium at one viewport; no narrow-width or Safari pass.
