# Frontend 5 report — Review page, snippets, onboarding, run numbers

Brief: `frontend-5-review-and-onboarding.md`. Everything below is under `web/`; no dependency added; no git
commands other than `status`/`diff`.

## What shipped

New

- `web/src/pages/Review.tsx` — `/app/review` (`?run=<id>&v=<n>` deep-links). Three columns: queue (pending
  first, then decided, grouped by run), pseudo-file tree with "changed" marks, diff of the selected file
  against the last approved version. Top strip: agent, version, fixes line, gate line, Approve / Reject.
  Below: shadow-replay panel, export strip (`tool_rules.json`, gateway command), framework snippets.

Changed

- `web/src/api.ts` — `GateResult.pass_k`, `CycleRecord.latency_ms / tokens / cost_usd`,
  `RunRow.domain / seed`, new `GatewayReplay` type and `api.gatewayReplay(run, v)` fetcher. All optional.
- `web/src/lib/derive.ts` — all new logic lives here as named pure functions:
  - Review: `reviewQueue`, `defaultReviewItem`, `reviewKey`, `approvedBase`, `PSEUDO_FILES`, `pseudoFiles`,
    `pseudoFileText`, `fileDiff` (`lineDiff` / `listDiff` / `keyDiff`), `fileChanged`, `firstChangedFile`,
    `diffHeadline`, `fixesLine`, `gateLine`, `replayLine`, `replayRows`, `gatewayCommand`.
  - Snippets (B2): `FRAMEWORKS`, `ruleSnippet`, `openaiAgentsSnippet`, `langgraphSnippet`, `promptSnippet`,
    `intentWords` (mirrors the tool-class vocabulary in `chaos/tools.py`).
  - Onboarding (A5): `SMOKE_CYCLES`, `smokeBody`, `smokeCycles`, `smokeLine`, `smokeFinding`, `smokeDone`,
    `smokeEmptyLine`.
  - Run numbers: `RunSummary.costUsd / p50LatencyMs`, `median`, `fmtCost`; `versionCells` shows `pass^k`,
    `summaryCells` adds cost and p50 latency, `runFacts` adds domain and seed.
  - Deleted: `mappingLine`, `mappingRows` (no callers after the onboarding rewrite).
- `web/src/components/ConfigDiff.tsx` — now takes `(before, after, file?)` and renders one pseudo-file's diff;
  fetching moved to the caller. Used by Cycle and Review (two call sites).
- `web/src/pages/Cycle.tsx` — fetches the before/after configs and passes them to `ConfigDiff`.
- `web/src/components/RunResults.tsx` — Approve/Reject buttons replaced by a "Review this version →" link to
  `/app/review?run=…&v=…`. `ReviewMark` gained a `compact` prop for the queue.
- `web/src/pages/Agent.tsx` — approve panel and `onReview` wiring deleted.
- `web/src/lib/routes.ts` — `review` route (with query params), `OnboardingStep` now 1–5, `review()` helper;
  `parse`/`href`/`useRoute`/`redirectLegacy` read and write `window.location.search`.
- `web/src/components/Shell.tsx` — "Review" nav item (`ListChecks` icon).
- `web/src/App.tsx` — routes `review` to the new page.
- `web/src/pages/Onboarding.tsx` — five steps: Choose → Connect → **Tools** (tool-backend URL, save via
  `PATCH /api/agents/{id}`, starter rules from `GET /api/agents/{id}/tools/proposal`, apply or skip) →
  **Smoke test** (starts a 3-attack, no-repair loop via `smokeBody`, polls `api.loop` + `api.cycles`, shows
  per-attack landed/blocked and the finding) → First run. Demo path still jumps Choose → First run.
- `web/src/pages/Run.tsx` — not edited; the new cells flow in through `runFacts` / `summaryCells`.

## Decisions where the handoff was wrong or silent

- **`ConfigDiff` signature.** The handoff assumed the component could be reused as-is for per-file diffs. It
  took a `cycle` and fetched its own configs, so it could not diff a candidate against an arbitrary approved
  base. Refactored it to `(before, after, file?)` and moved the fetch to Cycle. Evidence: the old prop list in
  the pre-change `ConfigDiff.tsx` and the single call site in `Cycle.tsx`.
- **"Last approved" base when nothing is approved yet.** `approvedBase` falls back to v0 (the run's starting
  config). Reason: the diff must always render something meaningful for the first pending version.
- **Default file in the tree.** `firstChangedFile` picks the first pseudo-file that differs; if nothing differs
  (e.g. a rollback that lands on an identical config) it falls back to `tool_rules.json`.
- **Rollback versions have no patch notes.** Their diff headline reads "rollback to run … vN" derived from the
  cycle record, since `patch_notes` is absent for those cycles.
- **Smoke test uses the existing loop.** There is no dedicated smoke endpoint; the step starts the normal loop
  with `chaos_cycles=3`, `repair_attempts=0`, second pass off, and stops itself when 3 cycles exist or the
  loop exits. It refuses to start while another run is live (the Home run would otherwise be clobbered).
- **Loop crash before any cycle.** `smokeEmptyLine` shows "the loop exited (code N) before any attack ran"
  instead of an indefinite spinner. Added after hitting a real backend crash (below).
- **`Chosen.mapping` / tool mapping UI removed** from onboarding: the handoff's tools step is rules-based
  (`tool_rules`), so the older mapping table had no consumer. Its derive helpers went with it.
- **Snippets are templates, not generated code.** `openaiAgentsSnippet` / `langgraphSnippet` emit a guard
  function that the user wires into their framework's tool hook; the rule set is embedded as JSON so it
  matches the export strip byte-for-byte. `promptSnippet` is the plain-language addendum.

## tsc / lint

- `npm --prefix web run build`: clean (tsc -b + Vite). Only the pre-existing >500 kB chunk notice.
- `npm --prefix web run lint`: 0 errors. 9 warnings, all pre-existing and all in files this lane did not
  touch: `components/ui/orb.tsx` (6), `hooks/useDwell.ts`, `components/ui/badge.tsx`,
  `components/ui/button.tsx` (verified with `git status` — none of those four are modified).

## Browser check (scripts/dev.sh — API :8000, Vite :5173)

Screenshots are in the Cursor screenshots folder (`/var/folders/…/T/cursor/screenshots/`), named as listed.

| Page | Result | Screenshot |
| --- | --- | --- |
| `/app/review` (no params) | Queue lists every version of every run, pending first; first pending item selected; tree + diff render | `review-queue.png`, `review-3col.png`, `review-loaded.png` |
| `/app/review?run=live&v=2` | Deep link selects v2; diff is v2 against approved v1 | `review-v2-vs-approved-v1.png` |
| Review → Approve | Mark flips to approved, queue re-sorts, next pending is selected | `review-after-approve.png` |
| Review from a history run's deep link | Works for non-live runs | `review-deeplink-history.png` |
| Agent → Versions → "Review this version →" | Lands on Review with the right run/version | `review-from-versions-link.png` |
| `/app/agents/builtin` | Approve panel gone; versions table intact | `agent-builtin.png` |
| `/app/agents` | Unchanged; cards render | `agents-list.png` |
| `/` Home | Unchanged | `home.png` |
| `/app/run` (live) | Cells render; `pass^k`, cost, latency cells hidden because the backend does not emit them yet | `run-live.png` |
| `/app/runs/<id>` (history) | Facts + summary cells render; domain/seed cells hidden (absent) | `run-history.png` |
| `/app/runs/<id>/cycles/7` | `ConfigDiff` refactor: before/after diff renders, collapsed sections work | `cycle-7.png` |
| `/app/runs` | Unchanged | `runs.png` |
| `/app/schedules` | Unchanged | `schedules.png` |
| `/app/settings` | Unchanged | `settings.png` |
| Onboarding 1–2 (Your own) | Ping against a throwaway `POST /episode` server on :8799 succeeded; save created the agent | — |
| Onboarding 3 Tools | Bad URL → inline error; good URL saved; proposal panel showed 2 starter rules; Apply patched `tool_rules` | `onboarding-3-tools.png`, `onboarding-3-bad-url.png`, `onboarding-3-tools-proposal.png`, `onboarding-3-apply-result.png` |
| Onboarding 4 Smoke | Started when idle; progress line updated until the backend crashed (see below). The 409 "a loop is already running" path is handled in code but was not provoked in the browser | `onboarding-4-smoke.png`, `onboarding-4-smoke-running.png` |
| Onboarding 5 First run | Settings form + Heal; Back returns to step 4; Demo path jumps 1 → 5 with 2–4 marked skipped | `onboarding-5-first-run.png` |

The throwaway agent and fake server were removed afterwards (`DELETE /api/agents/…` → 204; agents list is
back to `builtin` + `example`).

### Panels only seen in their empty state

The backend lane had not landed these fields/endpoints at test time, so these render their empty copy only:

- **Shadow replay panel** — `GET /api/gateway/replay?run=…&v=…` returns 404. Panel shows "no gateway traffic
  recorded for this agent yet". The row rendering (`replayRows`) is exercised only by types, not by data.
- **Run cells `pass^k`, cost, p50 latency** — no cycle has `pass_k` / `cost_usd` / `latency_ms`; cells are
  omitted, so the number formatting (`fmtCost`, `median`) is unverified in the browser.
- **Run facts domain / seed** — `RunRow.domain` and `seed` are `null` on every run; cells omitted.
- **Smoke test result** — the loop started, then the backend crashed with
  `ImportError: cannot import name 'ORDERS' from 'chaos.tools'` before producing a cycle. The "landed/blocked
  per attack" rows and the finding line were never populated with real data; only the crash message path
  (`smokeEmptyLine`) was seen. This is a backend bug outside `web/` and should be raised with that lane.
- **Reject** — not clicked in the browser. It calls the same `api.review` fetcher as Approve with
  `decision: "rejected"`, and the rejected mark/ordering in the queue is exercised only by types.

## Not tested

- Reject on the Review page (see above) and the smoke step's 409 branch.
- Any of the empty-state panels above with real data (needs the backend lane's endpoints).
- Framework snippets pasted into a real OpenAI Agents SDK or LangGraph project — the templates compile as text
  only; they have not been executed.
- Concurrent approve/reject from two tabs.
- Mobile / narrow viewport for the three-column Review layout (checked at 1024 px only).
- Backend `tests/` — not run; this lane did not change Python.
- Production build served (`vite preview`) — only the dev server was exercised.
