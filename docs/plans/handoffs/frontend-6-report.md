# Frontend 6 — review fixes: S6 (clear dead-end), S7 (domain picker + copy), S3 (legit coverage), Run-page wording

Fixes for four findings from `review-production-fit.md`, all under `web/`. Build and lint are clean (`npm --prefix web run build`,
`npm --prefix web run lint`: the same 10 pre-existing warnings in `orb.tsx`, `useDwell.ts`, `button.tsx`, `badge.tsx`). Nothing
committed. Screenshots are in the Cursor screenshots folder (`/var/folders/…/T/cursor/screenshots/`), named `f6-*.png` as listed
below.

The dev API on :8000 had been running for four hours on old code (`GET /api/domains` answered 404, run rows had no `domain`);
I restarted `scripts/dev.sh` (`ANTIBODY_NO_SCHEDULER=1`) before checking anything. The live airline run in `runs/` was left in
place.

## S6 — Onboarding step 3 dead-ends on "Clear it first"

**What "clear" is.** `api/tool_setup.py` refuses to write a config version while `runs/` holds a run made against another target
(`RollbackRefused("the live run was made against …; Clear it first")`). The clearing action already exists: `POST /api/runs/archive`
(`api/main.py` `archive_run`, `api.runsArchive()` in `api.ts`), which the Current run page's "clear" already calls — it moves the
run's folders to `history/`, deletes nothing, and 409s while a loop is running.

**Fix.** When the Tools step's refusal is that one (`refusedUntilCleared(note)` in `derive.ts`, matching the API's "Clear it first"
sentence — other 409s such as "a loop is running" get no offer, since archiving would not fix them), the step shows one faint
sentence under the alert — "Clearing moves that run's files from `runs/` to `history/` — nothing is deleted, and it stays open under
Runs." — and a quiet text button **Clear it and apply the rules**, which calls `api.runsArchive()` and then the same apply path.
No new endpoint, no new component.

Files: `web/src/pages/Onboarding.tsx` (`clearAndApply`, the offer under `toolsNote`), `web/src/lib/derive.ts` (`refusedUntilCleared`).

**Seen in the browser.** Connected a throwaway agent on :8799 (three tools; deleted afterwards via `DELETE /api/agents/{id}`, 204),
clicked "Apply 2 starter rules" → the red alert `the live run was made against 'http://127.0.0.1:8792', not this agent; Clear it first`
plus the new sentence and button (`f6-onboarding-3-clear-offer.png`).

**Not verified.** I did not click the Clear button: it would have archived the real airline run out of `runs/`, which the review lane
and this one are using. The button calls the exact fetcher the Current run page's "clear" uses (which I did see wired), then
`applyStarterRules()`. To verify end to end: on a machine whose `runs/` you can lose, repeat the steps above and click the button —
expect the wizard to land on step 4 and the run to appear under Runs as archived.

## S7 — Domain picker and domain-aware copy

**(a) Picker.** `RunSettings` (`lib/settings.ts`) has a new `domain: string | null` (null = the agent's own pack, else the API's
default — the same precedence `api/loop_ctl.py` applies), persisted with the other settings, normalised on load, compared by
`isDefaultSettings`, and sent by `toStartBody` as `LoopStartBody.domain`. `RunSettingsFields` gets a **Domain** row at the top
(the existing `Select`/`Dropdown`), populated from `GET /api/domains` (`api.domains()`), with a hint line per pack
(`7 tools · 5 attack families · 11 legit tasks`). The row's "null" option is labelled for what null means right now:
`Retail · default` on Settings (API default from `/api/manifest` `domain`), `Airline · the agent's` on the wizard's First run step
when the chosen agent carries a pack. The row is omitted in the Schedule dialog on purpose: `api/schedules.py` `ScheduleSettings`
has no `domain` (a schedule runs in its agent's own pack), and `ScheduleDialog` now strips it from the body too.

The wizard's Connect step also gets the same Domain select, sent as `POST /api/agents` `domain`, so a connected agent's row carries
its pack — without that, (b) would always be empty for agents connected from the UI. The smoke test passes the drawer's domain too.

Derive functions (all in `lib/derive.ts`): `domainLabel`, `worldLine`, `domainFallback`, `domainOptions`, `domainHint`.

**(b) Agent domain shown.** `agentSubline` appends `· airline domain` when the row has one; it is the faint line on Agents cards,
the Agent page header and the Current run page's empty face. Run facts (`runFacts`) already had a `domain` cell; the Review strip
already showed the run's domain.

**(c) Copy.** `worldLine(domain, world)` → `sandbox storefront` (retail), `sandbox airline desk` (airline), `sandbox <name>` for a pack
this UI has no noun for, `sandbox` when unknown, the world's own name when the run left the sandbox. Every "sandbox storefront"
sentence now goes through it: Current run header line (`runHeaderLine`), Onboarding steps 1/3/4/5, the Agent page's Real-tools hint,
the `CONTRACT` text on the Connect step (now says "sandbox world (a domain pack)" and lists the retail tools as the retail pack's).
Placeholders `Northwind support` / `http://127.0.0.1:8790` stay as example text. `rg 'storefront|Northwind' web/src` now hits only
`derive.ts` (the `WORLD_NOUN` table and its docstrings) and the two placeholders.

Files: `web/src/lib/settings.ts`, `web/src/lib/derive.ts`, `web/src/components/RunSettingsFields.tsx`, `web/src/pages/Settings.tsx`,
`web/src/pages/Onboarding.tsx`, `web/src/pages/Agent.tsx`, `web/src/components/ScheduleDialog.tsx`, `web/src/api.ts` (`Domain`,
`api.domains`, `domain` on `Agent`/`LoopStartBody`/`Manifest`/`RunRow`, `agentCreate` body).

**Seen in the browser.**
- Settings › Run defaults: Domain row `Retail · default` with `3 tools · 4 attack families · 11 legit tasks`; open list = `Retail · default`,
  `Airline`, `Retail` (`f6-settings-domain-dropdown-open.png`); picking Airline updates the hint to `7 tools · 5 attack families · 11
  legit tasks`, shows "reset to defaults", and `localStorage['antibody.settings.v1']` carries `"domain":"airline"`
  (`f6-settings-domain-airline-picked.png`).
- Onboarding 2: Domain select beside the URL, `Airline` picked, ping ok (`f6-onboarding-2-domain-select.png`); after Save the new row
  appears on Agents as `HTTP · airline domain` (`f6-agents-list-domain.png`) — so `POST /api/agents {domain}` round-trips.
- Onboarding 3 copy: "Leave it empty to keep using the sandbox airline desk's tools." Onboarding 4/5 subtitles say "sandbox airline
  desk". Onboarding 5's Domain fallback row reads `Airline · the agent's`; choosing it stores `domain: null`
  (`f6-onboarding-5-domain-fallback.png`).
- Agent page for `example-airline`: `HTTP · airline domain · http://127.0.0.1:8792 · 3 runs`; Real tools hint "Empty = the sandbox
  airline desk stands in." (`f6-agent-airline-whole-run-coverage.png`).
- Current run header: `Sep 22, 6:13 AM · Example airline agent (OpenAI CS demo) · sandbox airline desk · 2 chaos cycles · 1 repair
  attempt · v0 → v1 · legit guard covers 10/11 tasks` (`f6-run-live-header-airline.png`).
- Schedule dialog: no Domain row; the other rows unchanged.
- `POST /api/loop/start` with `domain: "hotel"` → 400 `unknown domain 'hotel'; one of ['airline', 'retail']` and no loop started
  (the negative path; the UI can only offer names the API listed).

**Not verified.** A real Heal with a non-null domain (the body is right by code — `toStartBody` — but I did not start a paid run to
watch `ANTIBODY_DOMAIN` land in the child). A persisted domain name whose pack disappears is kept as a select row (`domainOptions`)
so the choice is visible, but I could not produce that state against a live API.

## S3 (frontend half) — `legit_covered`

`LegitCovered {covered, total}` is on `GateResult`, `RunRow` and `State` in `api.ts`; `legit_pass_rate` is `number | null`.

- **Run page cells.** `summaryCells` adds `legit guard covers · 10/11 tasks` when the run's latest gate measured it (whole-run view on
  the Run page's About block and the Versions panel's `all` stop, and the Agent page's picked run).
- **Review strip.** `gateLine` appends `legit guard covers 10/11 tasks`.
- **Cycle gate line.** The cycle page's Gate step line and the Run page's cycle drawer both append it (`cycleSteps`, `stepChildren`).
- **Zero coverage.** `legitCoverageWarning` → "No legit task runnable against this target — the gate cannot protect normal users", in
  `--danger`, under the cells (Run About block, Versions `all`), under the Review strip's gate line, on the cycle page (new
  `CycleStep.warning`), and in the run-page drawer where the "no legit flow newly broken" row becomes "legit guard did not run" in the
  signal colour. `legitPct` shows `—` when the rate is null or coverage is 0, so `versionCells`' "gate · tests / legit users" reads
  `0% / —` rather than a number nobody measured.
- **Absent.** Every function returns null/`—` on records without the field; old runs show nothing new.

Files: `web/src/api.ts`, `web/src/lib/derive.ts` (`coverageFraction`, `legitCoverageLine`, `legitCoverageWarning`, `legitPct`,
`headline`/`runSummary`/`summaryCells`, `gateLine`, `cycleSteps`, `stepChildren`, `versionCells`), `web/src/pages/Run.tsx`,
`web/src/components/RunResults.tsx`, `web/src/pages/Review.tsx`, `web/src/pages/Cycle.tsx`.

**Seen in the browser.** Live airline run (`/api/state` `legit_covered: {covered: 10, total: 11}`): header line and the cycle-12
gate row `legit 3/10 · legit guard covers 10/11 tasks`; Agent page Versions `all`: cells `LEGIT USERS 3/10 · LEGIT GUARD COVERS 10/11
tasks · COST $0.0723 · P50 LATENCY 83.2 s` (`f6-agent-airline-whole-run-coverage.png`); Review `?run=live&v=1`: `held 2/2 trials ·
legit users 4/10 · legit guard covers 10/11 tasks` (`f6-review-strip-coverage.png`); Cycle 6: `… regression 0/5 · legit 4/10 · legit
guard covers 10/11 tasks` (`f6-cycle-gate-coverage.png`). History run `20260922T131319Z` (manifest has no coverage): domain `Airline`,
seed, cost and latency cells, no coverage cell, no warning (`f6-run-history-no-coverage.png`).

**Not verified in a page.** No run on disk has `covered === 0`, so the warning was exercised by calling the derive functions from the
Vite dev server (`import('/src/lib/derive.ts')` in the page console): `legitCoverageWarning({covered:0,total:11})` returns the sentence,
`{covered:3,…}`/`null`/`undefined` return null; `summaryCells` on a zero-coverage gate gives `legit users=— · legit guard covers=0/11
tasks`; `legitPct` is `—` for a null rate. The rendered warning line itself (colour, placement) has not been seen — a run against a
target whose tools cover none of the pack's legit tasks would show it.

## Run page wording

The only user-visible "Results" left was the header link **See results** on the finished current run, which opens the agent's
page — now **Open agent page** (`web/src/pages/Run.tsx`). Code comments mentioning "results" (the mode name, `RunResults`) were left
alone; `rg 'Results page' web/src` is empty.

## Also noticed (not fixed — outside this lane)

- The Schedule dialog shows a raw agent id (`-qbyLLJliDI`) as its Agent when `settings.target` points at a deleted agent; the
  Current run page's switcher falls back to the built-in row, the dialog does not.
- The two example rows have ids `example` and `example-airline`; `agentSubline`/`exampleState` special-case only `example`, so the
  airline example shows plain `HTTP · airline domain` with no start/stop state. Correct as far as it goes; a follow-up could key on
  `synthetic && url`.
- `runs/run.json` for the live run has `legit_covered: null` while `/api/state` and `/api/runs` report `{10, 11}` — the API derives it
  from the latest gate rather than the manifest, which is what the UI reads, so nothing is wrong on screen; noting it for the backend lane.
