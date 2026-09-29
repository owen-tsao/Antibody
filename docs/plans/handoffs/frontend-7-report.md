# Frontend 7 — results matrix (plan 11 §1) and review inbox → editor (plan 11 §2)

Both sections of `docs/plans/11-results-review-weave.md` that belong to the web lane, following `review-plan-11.md` §7–§8 and
`ui-7-report.md`. Everything is under `web/`. Build and lint are clean (`npm --prefix web run build`; `npm --prefix web run lint`
reports the same pre-existing warnings in `components/ui/*` and `useDwell.ts`, none in touched files). Nothing committed.

**How it was checked.** Owen's `make dev` API on :8000 (started 00:52, no `--reload` by design) predates the backend's inbox code,
so I left it alone and ran a second stack: `runs/` + `history/` + the root `cycles.jsonl` copied to `/tmp/antibody_fe7/`, an API on
:8060 (`ANTIBODY_RUNS_DIR`, `ANTIBODY_HISTORY_DIR`, `ANTIBODY_NO_SCHEDULER=1`, `ANTIBODY_NO_ZENDESK=1`) and Vite on :5174
(`API_PORT=8060`). Real data shape, no writes to the real run. Both are still running in background terminals; kill them when done.

## §1 — Results matrix (`components/RunResults.tsx`)

The Versions panel is now one `<table>` with scoped headers: `scope="col"` for each version (with `ReviewMark`), `scope="row"` for
every row label, `scope="rowgroup"` for the two group headings.

- **Gate numbers per version** (row group 1): `fixed k/k`, `regression`, `legit · coverage`, `cost`, `p50 latency`, `decision` (the
  mark, linking to the version's editor at `/app/review/:run/:v`). Numbers come from the cycle that made each version
  (`gateRows(cycles, columns)` in `derive.ts`); v0 shows `—` where nothing was measured.
- **Attack matrix** (row group 2): one row per attack, grouped by family (`matrixRows`), one cell per version reading `landed` /
  `blocked` / `not measured` (`matrixCell`). Every cell that has a cycle behind it is a button that opens that cycle; its accessible
  name reads `<attack> on v4: blocked · open cycle 2`.
- **Fallbacks.** A run with per-version counts but no per-attack detail shows `5 of 8 land` per column (`landedLine`). A run with no
  measurement shows `ATTACKS · NOT MEASURED FOR THIS RUN` with the estimate and a **Measure** button.
- **Measure.** Estimate = `attacks × versions × 3 samples` episodes, cost and time extrapolated from the run's own per-episode cost and
  latency (`measureEstimate`), rendered `36 episodes · about $0.0362 · ~3 min`. Live only: `measureBlocker` disables it (with the reason
  as the title) on history runs, without an API key, while a loop is running, and when `/api/manifest` `defaults` has no `mode`. It
  calls `api.loopStart({mode: "vulnerability"})`; while a measurement runs (`isMeasuring`: the row's `measuring` flag, a running loop
  started in that mode, or the status line on it) the button reads `measuring…`.
- **Weave.** When a run row carries `weave_leaderboard_url`, the panel's aside gets an "Open in Weave" link (new tab).
- The Run page shows the matrix for the current run at rest (`lastRun`), not only for history runs, and re-reads on loop exit.

`api.ts`: `LoopStartBody.mode`, `RunRow.weave_leaderboard_url / cost_source / measuring`, the `Vulnerability` type
(`by_attack: {"v0": {scenario_id: boolean[]}}`, one flag per sample — matched to `api/store.py` `read_vulnerability`, which I had
first typed the other way round; the cell rule is the backend's majority rule, `hits * 2 > samples`).

Deleted: `versionStats`, `versionCells` and the old cell grid.

**Seen in the browser (scratch stack).** Current run (`live`, retail, v0→v4, measured on v0 and v4): the gate rows read
`fixed — 2/2 2/2 2/2 2/2 · regression — 0/1 1/4 2/4 4/7 · legit 11/11 · cost $0.0614 … $0.3061 · p50 61.7 s … 117.3 s · decision
— pending pending ×rejected pending`; the matrix has four families (prompt injection via tool, tool returns garbage, social
engineering, ambiguous request) with `landed` on v0, `not measured` on v1–v3 and a mix on v4 — matching `vulnerability_detail.json`.
Clicking `Order lookup returns null on v4: blocked` opened `/app/run/cycles/2`. History run `20260925T233010Z` (airline, never
measured): the counts/none fallback `ATTACKS · NOT MEASURED FOR THIS RUN · 36 episodes · about $0.0362 · ~3 min · Measure`, the
button disabled (`History runs are read-only; measure from Current run.`). Agent page for `builtin` renders the same matrix.
`POST /api/loop/start {mode: "nonsense"}` → 422 from the API, so the UI can only send the two literals.

**Not verified.** Clicking Measure on the live run: the scratch stack has no measurement-free live run, and a real one costs money
and needs a key. The `measuring…` state and the `weave_leaderboard_url` link were checked by reading `/api/runs` (`cost_source:
"estimated"`, `weave_leaderboard_url: null` on every row today) and by the type, not on screen. The counts-only fallback (`5 of 8
land`) needs a run measured before the detail file existed; none on disk.

## §2 — Review inbox → editor (`pages/Review.tsx`, `lib/routes.ts`)

- **`/app/review` — the inbox.** One poll of `GET /api/review/inbox` (`api.reviewInbox`; the old page's 3N+1 fan-out —
  `/api/runs` then cycles + approvals + configs per run — is gone). One row per agent: tile, name, a pending badge (`35 pending`) or a
  quiet `nothing pending`; agents with something to decide open by default. Inside: pending versions, the current run's first, then
  archived runs' marked `archived` in `--faint` (they can be looked at, not decided — `api/main.py` review is live-only), each as
  `v1 · fixes cycle 6 · Timeout on lookup · held 2/2 · legit 40%` with when. A `show decided · 2` toggle per agent lists the decided
  ones with their marks. Header aside: total pending across agents.
- **`/app/review/:run/:version` — the editor.** The agent is the run's (`runOwner(runs, run)`), not the switcher's. Breadcrumb
  `Review / <agent> / <title strip>`; the eyebrow's `Review` links back to the inbox. `←` / `→` step through the pending sequence in
  inbox order across agents (`pendingOrder`, `pendingNeighbours`), disabled at the ends, tooltip naming the neighbour. The tree lists
  the run's agent's runs and versions from the same inbox payload (`inboxTree`), the open run's own cycles filled in from
  `readRun(run)`; selecting a version or a tab from another version is a navigation to that version's address. The document, tab strip,
  diff-against-last-approved, shadow replay and Approve / Reject are the ui-7 editor unchanged; a decision re-reads the inbox too.
- **Addresses.** `routes.ts` gets `reviewVersion(run, v)`; `/app/review?run=&v=` (the Versions link's old form) redirects to the new
  path — seen: `?run=live&v=4` → `/app/review/live/4`. The address is the selection: `/app/review/live/9` shows `This run has no v9.`
  with the tree still there to pick from; `/app/review/nope/1` shows `No such run — it may have been cleared.` with `unknown agent`
  in the crumb. (`defaultReviewItem`, which used to fall back to another version silently, is replaced by the exact `reviewItemAt`.)
- Shell nav and the Run page's decision cells point at the new routes; `App.tsx` no longer passes `settings` into Review.

Deleted: `readRuns`, `RunReview`, `reviewRuns`, `reviewKey`, `reviewRunAgent`, the agent-switcher coupling and the `?run=&v=`
prefill logic in the page.

**Seen in the browser (scratch stack).** Inbox: Demo agent `38 pending` (live v4, v2, v1 first without `archived`, then 35 archived
across 11 runs, `show decided · 2`), Example airline agent `1 pending` + `show decided · 1`; header `39 pending`. Clicking the airline
v1 → `/app/review/20260925T233010Z/1`, crumb `Review / Example airline agent (OpenAI C… / v1 · fixes cycle 6 · Timeout on lookup`,
`held 2/2 · legit 4/10 · guard 10/11`, `pending · archived run` pill, tree scoped to that agent's two runs, `→` disabled (last pending).
`←` → `/app/review/20260913T073345Z/1` (the demo agent's oldest pending), tree now the demo agent's 11 runs, both arrows live. Live
editor `/app/review/live/4`: `Current run` first in the tree with v4/v3 (rejected)/v2/v1, Reject / Approve present, `←` disabled (first
pending).

**Not verified.** Approve / Reject through the new page (it would write `approvals.json`; the handler is the ui-7 one plus a
`rereadInbox()`). An inbox with a `golden` run, or an agent with pending on the live run *and* a live loop running. The old
`?run=&v=` redirect was checked for one pair; `routes.ts` rejects a non-integer or negative `v` and falls back to the inbox.

## Also noticed (not fixed — outside this lane)

- Inbox rows do not name their run: the demo agent's 35 archived pending versions are 11 runs' worth of `v1 · fixes cycle 1 …` lines
  distinguished only by the `14 d ago` column. If the backend keeps reporting every archived version as pending, the inbox wants a
  per-run sub-heading (or the backend should stop counting archived versions as pending, since they cannot be decided).
- The live run's `cycles.jsonl` lives at the repo root while `ANTIBODY_RUNS_DIR` expects it inside the runs dir — harmless for the
  app, but a copy of `runs/` alone does not carry the live run (found while building the scratch stack).
