# Review 2 — production fit (independent, after backend-9 / frontend-6 / ui-7)

Branch `feature/production-fit`, all uncommitted. Reviewed 2026-09-25 with the "production-readiness" judge's
eyes: correctness, security, code quality, UI quality. Everything below was checked by reading the code, running
the suites, and driving a **scratch copy** of `runs/` and `history/` (`/tmp/antibody_review2/scratch`) behind an
API on :8060 and Vite on :5174 — so nothing here touched the real live run except one thing, called out under
"Edits".

## Verdict

**Ship-ready; no blocker remains.** All nine findings from `review-production-fit.md` are fixed in code and
each has a test. Suites, build and lint are green. Five should-fixes remain (below); none is a correctness hole in
the gateway or the gate. The largest is how the Review page behaves *after* an API outage.

## Previous findings — are they fixed?

| # | Finding (review 1) | Status | Fix | Test | Repro I ran |
| --- | --- | --- | --- | --- | --- |
| B1 | `--version approved` gateway fell to v0 when the approvals file vanished (archive/reset) | **fixed** | `chaos/gateway.py` `reload()` refuses `fresh.version <= cfg.version`, keeps serving with `stale: true` and a `_held` reason | `test_gateway.py::test_reload_never_follows_an_archived_approval_down_to_v0` | `state.archive_previous_run()` then `state.reset()` under a live gateway: `/health` stayed on the approved version, `stale: true` |
| S1 | `/health` created a session per hit | **fixed** | front-door middleware skips session creation on `/health` | `test_health_never_creates_a_session` | 50 unauthenticated `GET /health` with session headers → `session_count() == 0` |
| S2 | `merge_tool_rules` could loosen `on_failure`, `timeout_s`, `intent_words` | **fixed** | `chaos/repair_agent.py` `merge_tool_rules()` keeps class defaults, caps `timeout_s`, intersects `intent_words` | `test_tool_rules.py::test_merge_never_loosens_the_class_default_or_the_intent_check`, `::test_merge_only_tightens` | money rule proposing `on_failure: open`, `timeout_s: 900`, superset intent words → stayed `closed`, 30 s, intersection |
| S3 | Empty legit guard read as 100 % pass | **fixed** | `GateResult.legit_pass_rate: float \| None`; `LEGIT_GUARD_EMPTY` reason | `test_aliases.py::test_an_empty_legit_guard_is_named_not_passed_silently` | `covered == 0` → `None`, reason names the empty guard, UI shows the warning (`legitCoverageWarning`) |
| S4 | Two tool classifiers disagreed | **fixed** | one `tool_class(domain, name, description)` in `chaos/tool_rules.py` | `test_one_classifier_for_the_panel_the_repair_and_the_gateway` | `send_money` → money → fails closed on backend down |
| S5 | `FinTarget` followed `file://` / `data:` SSE URLs | **fixed** | explicit `_opener` handlers, `_same_origin()` scheme+host | `test_fin_target.py::test_the_sse_url_must_be_the_fin_apis_own_scheme_and_host`, `::test_the_stream_is_capped_in_bytes_per_line_and_in_idle_time` | `_opener.open("file://…")` → `URLError`; `data:` and `ftp://` likewise; 64 KiB line / 1 MiB stream caps hold |
| S6 | Onboarding Tools step dead-ended on the 409 target mismatch | **fixed** | "Clear it and apply the rules" action (`Onboarding.tsx:582`) | `test_agents.py::test_tools_apply_refuses_while_running_or_for_another_agents_live_run` | browser: applied a rule while the live run belonged to `builtin` → 409 text + the clear action rendered (did not click clear) |
| S7 | No way to pick the domain in the dashboard | **fixed** | Domain select in Settings › Run defaults, Onboarding Connect and First run; `domainChoice`/`domainHint` in `derive.ts` | `test_domains_loop.py::test_agent_rows_carry_a_domain_and_loop_start_passes_it`, `::test_get_api_domains_lists_every_pack` (the select's options and the value the start body carries; the select itself has no browser test) | browser: Settings shows `Airline · the agent's`; Onboarding step 2 and 5 show `Retail · default · 3 tools · 4 attack families · 11 legit tasks` |
| S8 | `POST /sessions/{id}/turn` unbounded | **fixed** | `MAX_TURN_BODY_BYTES` 64 KiB, `MAX_TURN_CHARS` 16 KiB, `MAX_TURNS_PER_SESSION` 200 | `test_turns_are_capped_per_session_in_length_and_in_body_size` | test read: over-long text → 413, oversize body → 413 before JSON parse, turn 201 → 429, refused turns are neither kept nor logged and open no session |

None is partial.

## Findings

### Should-fix

**F1 — Review page shows the wrong decision state after an API outage, and never recovers without a reload.**
`web/src/pages/Review.tsx:56-66` (`readRuns`) catches every per-file error and returns `null`s, so `usePoll`
treats the outage as a *successful* read and replaces last-good data. Result while the API is down and after it
comes back (screenshots taken): every version shows `pending`, the run says `3 pending` though two were decided,
the title degrades to `v2 · v2`, and **Approve / Reject are offered on versions that are already decided**. Because
the read is one-shot (`usePoll(readFn, 0)`, line 105), nothing re-reads when the shell's polls recover — the page
stayed wrong 30 s after the API was back; a reload fixed it. Risk: a person who clicks Reject on an
"pending" v1 that is really approved changes the certified version a `--version approved` gateway serves.
Minimal fix: let `readRuns` reject when a read fails (drop the `.catch(() => null)` or throw when all three are
null) so `usePoll` keeps last-good data, and re-read on recovery (call `reread()` when the shell's `failing`
returns to 0, or give the two reads a 30 s interval instead of 0).

**F2 — Home hero at 1024 px wide with the sidebar open: the Facts strip is unreadable.** `Home.tsx:62`
`lg:grid-cols-[minmax(0,1fr)_400px]` leaves the hero column 300 px at 1024 (240 px sidebar + gutters). The title
stays one line (it shrinks to 26 px), but every fact truncates — `v0 …`, `not …`, `Sep…` — and `LEGIT USERS` /
`LAST RUN` wrap to two lines (screenshot). Fine at 1280×720 and 1440×900 (only the date truncates at 1280:
`Sep 22, 6:13…`). Minimal fix: make the fixed 400 px side column `xl:` and stack at `lg`, or
`lg:grid-cols-[minmax(0,1fr)_minmax(280px,36%)]` and let `Facts` wrap to 2×2 under ~360 px.

**F3 — The Agent page's Shadow log panel is not backend-scoped, unlike the Review replay.** `Agent.tsx:187,
364-388` polls `api.gateway` (the whole install's log) under the heading "in front of *this agent's* real tools".
With two agents on different backends, A's page lists B's blocked calls; the command it shows is the generic
`command_line()` rather than the per-backend one Review uses (`gatewayCommand(version, tools_backend)`). Minimal
fix: `?backend=` on `/api/gateway/log` filtered with `same_backend` (rows without `backend` only when no filter —
the rule the replay already follows), and pass `agent.tools_backend` from the page.

**F4 — 422 responses echo the whole request body.** A 5 MB `POST /api/scenarios/import` is rejected in 70 ms
(the 20 000-char cap works) but the response is **11 MB**: FastAPI's default handler returns `input` for each
error. There is also no request-size cap below Pydantic, so the body is buffered in full first. `api/main.py:
102-116` already owns a `RequestValidationError` handler; minimal fix there: return `exc.errors()` with the
`input` key stripped (`jsonable_encoder` for `ctx`), and optionally refuse `Content-Length > 1 MiB` with 413 in
the existing middleware.

**F5 — A test wrote into the repo's real `runs/approvals.json`.** `tests/test_gateway.py::
test_health_reports_the_live_policy_version` patched `RUNS_DIR` and `CONFIGS_DIR` but not `REGRESSION_PATH`, which
is where `state.approvals_path()` resolves; every `pytest` run rewrote the live approvals file. **Fixed** (see
Edits). It can recur: any test that calls `state.review()` must patch three module paths. Suggest an autouse
fixture in `tests/conftest.py` that points `state.RUNS_DIR`, `state.CONFIGS_DIR`, `state.REGRESSION_PATH` at
`tmp_path` for every test, so a forgotten patch can never reach `runs/`.

### Nits

- N1 `derive.ts:1527-1530` `diffHeadline`: an *approved* v1 reads `v1 vs v0 · nothing approved yet`. Say
  `v1 vs v0 · first proposal` when the version itself is decided.
- N2 `Page.tsx:29-31`: the eyebrow truncates before the title (`Revi…`) on a long Review title; give the eyebrow
  `shrink-0`.
- N3 `radial-orbital-timeline.tsx`: vendored leftovers — `viewMode` state that is always `"orbital"` (l.43),
  `centerOffset` state with no setter (l.47), `onSelect` and other `setState` calls inside the `setExpandedItems`
  updater (l.75-108; double-invoked under StrictMode dev, idempotent today), literal `bg-black` / `bg-white` /
  `text-white` / `border-white/10` instead of the tokens, 9.5 px monogram text.
- N4 `Review.tsx`: with the API down, the decision POST's failure shows the proxy's raw `502 Bad Gateway`
  twice (alert + "Could not load this version"). One line, in the app's words.
- N5 `derive.ts` exports used only inside the file (`legitCoverageLine`, `PSEUDO_FILES`, `domainLabel`,
  `hasReviewable`) and `api.ts` types exported but unreferenced elsewhere (`FailureKind`, `ToolFault`, `Episode`,
  `Verdict`, `ScheduleResult`, `Source`, `LoopStarted`, `RollbackBody`, `ExampleAgentState`, `ReviewStatus`).
  Harmless; drop `export` where nothing imports it.
- N6 `.env.example` documents every variable a user sets. It does not mention the dev/test overrides the code
  reads (`ANTIBODY_HISTORY_DIR`, `ANTIBODY_IGNORE_EXTERNAL_LOOP`, `ANTIBODY_LOOP_CMD`, `ANTIBODY_NO_SCHEDULER`,
  `ANTIBODY_NO_WEAVE`, `ANTIBODY_RUNS_DIR`, `ANTIBODY_TOOLS_PORT`, `CHAOS_FAMILY`, `WANDB_PROJECT`,
  `OPENAI_API_KEY`). One comment line naming where they live would settle it. Nothing documented is unused.
- N7 `env -u WANDB_API_KEY` does not make the API keyless: `chaos/config.load_env()` re-reads `.env` at import
  (`setdefault`). `docs/SMOKE.md` readers who expect a keyless dashboard should know; the test suite is unaffected
  (it never calls inference).
- N8 Onboarding `CONTRACT` listed `read_ticket` / `set_ticket_status` as retail sandbox tools; the sandbox answers
  `unknown tool` for them unless a ticket world is on (`test_toolserver.py:87`). **Fixed** (Edits).
- N9 Review split view drew an unchanged file as two identical columns. **Fixed** (Edits).
- N10 `derive.ts` `summaryLine` had no caller. **Removed** (Edits).

### UI-7 against the standard

Review is the strongest page: one emphasis (the title), quiet icon row, hairline selection bar, monochrome with
`--danger` only on the coverage warning and the alert; logic (`reviewTree`, `flattenTree`, `approvedBase`,
`diffHeadline`, `splitRows`, `replayRows`, `heroTitle`, `scheduleMark`) lives in `derive.ts`; the page uses
`usePoll`, `api.*`, `.u-line` and `textButton`/`primaryButton` — no second fetch, poll or underline pattern.
Keyboard: roving `tabindex`, ↑/↓/Home/End move, → expands a run or selects a version, ← collapses / climbs,
Enter/Space selects or opens a file, Escape closes the snippets popover — all confirmed in the browser. Hero:
one-line title, subline carries the parenthetical, card height fixed at 689 px through data arrival at 1440×900,
no page scroll at lg. Schedules: chrome nodes with monograms (`SW`, `NR`, `WP`), `every day` / `every 1h`
labels, 0/1/3 states all render, empty state copy is right. The hero art is the one colour on the app pages and
reads as the agent's picture, not a signal — acceptable. Leftover colour fills: none found.

## README sentences that were wrong or unverifiable

| Line | Sentence | Status |
| --- | --- | --- |
| 21 | "CI runs the test suite (473 keyless tests)" | **wrong count** — 474 pass. Fixed to 474. CI itself verified: `.github/workflows/ci.yml` builds web, lints, then `uv run pytest -q`. |
| 41 | "Each pack carries five attack families" | **wrong for retail** — airline 5, retail 4 (`GET /api/domains`). Fixed to "five for airline, four for retail". |
| 67 | Agents page "with its tools, starter rules and shadow log" | true, but the shadow log is the whole install's, not the agent's (F3). |
| 89 | the night-of run: 12 cycles, accepted rule on `cancel_flight`, `book_new_flight`, `issue_compensation`, $0.07 | verified against `history/20260925T233010Z` (v1 rules and cost). |
| 104 | "how many of your recorded real tool calls it would have blocked" | verified (`ReplayDrawer`, `/api/gateway/replay`) — with the caveat that rows written before ui-7 have no `backend` and are counted only when the agent has no `tools_backend` filter. |
| 108 | "will not fall back to an older or empty policy if the approvals file disappears" | verified (B1 repro). "within a minute (or on SIGHUP)" verified: `RELOAD_INTERVAL_S = 60`, `signal.SIGHUP` handler. |
| 112 | "The onboarding wizard runs three quick attacks before it says 'done'" | verified in the browser (step 4 "Run 3 quick attacks"); the run itself not started (inference). |

Every command, port and path I checked (`scripts/dev.sh` → :8000 / :5173, `python -m chaos.gateway … --shadow`,
`python -m chaos.loop check --approved`, `chaos/domains/`, `docs/SMOKE.md`, `.env.example`) exists as written.

## Commands run

| Command | Result |
| --- | --- |
| `env -u WANDB_API_KEY uv run pytest -q` | **474 passed**, 1752 warnings, 55 s (twice: before and after my edits). No file under `runs/`, `history/`, `data/` modified during the run after the F5 fix. |
| `cd examples/agents/openai_cs_airline && uv run pytest -q` | **7 passed**, 1 warning, 1.4 s |
| `npm --prefix web run build` | clean (rolldown chunk-size advice only) |
| `npm --prefix web run lint` | **0 errors**, 10 pre-existing warnings, all in `components/ui/orb.tsx` |
| `npx tsc -p web/tsconfig.app.json --noEmit` | exit 0 |
| unused-export scan over `derive.ts`, `api.ts`, `ui.ts`, `routes.ts`, `settings.ts` | one dead function (`summaryLine`, removed); the rest are types or internally-used helpers (N5) |
| `rg forbidden_tool_calls\|LEGIT_EXPECTED_TOOLS\|TimelineItem.icon\|subline` (source only) | only golden data, one test name and doc comments — no stale code |

## Resilience probes (scratch API on :8060)

| Probe | Result |
| --- | --- |
| Kill the API with Review open | sidebar shows `api unreachable · retry`, last data stays on screen; restart → line clears. But the Review tree degrades as in F1 and does not recover without a reload. |
| Malformed JSON (`{"status": nope`) and wrong shape (`[1,2,3]`) to `/api/loop/start`, `/api/agents`, `/api/configs/1/review`, `/api/schedules`, `/api/scenarios/import` | 422 with the standard envelope on all ten; no 500 |
| `GET /api/runs/does-not-exist` · `?source=run:../../etc` · `/api/configs/999` · `/api/configs/-1` · `/api/agents/nope` | 404 · 400 `invalid run id` · 404 · 404 · 404 |
| 5 MB body to `/api/scenarios/import` (wrong field, then a 5 MB `transcript`) | 422 in ~70 ms both times; response echoes the body (11 MB) — F4 |
| Two concurrent `POST /api/configs/2/review approved` | both 200, one decision on disk (`runs_lock`), same `at`; no duplicate, no 500. UI disables both buttons while busy. |
| `/api/gateway/replay?version=1` with six legacy rows lacking `backend` | no filter → 5 calls counted; `backend=http://localhost:9000` → 0 (legacy rows do not leak into a backend's view); `version=abc` → 400; `version=99` → 404 |
| Schedules: create 2 via API, create 1 via dialog, delete all, delete an already-deleted id | 201/201/201, 204×4, second delete 404; orbit re-rendered live each time |
| Onboarding with a fake agent on :8791 (`POST /episode`, `GET /tools`) | Ping `ok · 1 ms`; Save stored the row; Tools listed 2 tools / 1 proposed rule; Apply hit the S6 409 path; Skip → step 5 rendered with the domain select. Fake agent row deleted afterwards. |

## Browser walk

Scratch stack, Chromium via CDP, viewport emulated. Screenshots in the chat; nothing below was broken except
where a finding is named.

| Page | 1440×900 | 1280×720 | 1024 wide | Notes |
| --- | --- | --- | --- | --- |
| Home (demo + airline agents) | ok — card 716×689, one-line title, no scroll, height constant while data arrived | ok — date fact truncates (`Sep 22, 6:13…`) | **F2** — facts unreadable | subline carries the parenthetical |
| Agents | ok | — | — | dashed "Connect an agent" card slightly taller than the agent cards |
| Agent (airline) | ok | — | — | Shadow log panel is install-wide (F3) |
| Current run | ok (finished demo run) | — | — | |
| Runs | ok, 17 rows | — | — | |
| Cycle 6 of `20260925T233010Z` | ok — `config diff v0 → v1` renders | — | — | ConfigDiff unchanged by ui-7 |
| Schedules 0 / 1 / 3 | ok / ok / ok | — | — | dialog opens and Escape closes; Create enables once named |
| Review | ok — tree keyboard nav, tabs, unified/split, snippets popover, replay drawer, approve refresh (`v1 · approved`, `1 pending`, header `approved · just now`) | — | — | base v0, approved base (`v2 vs approved v1`, rollback-approved v1) and unchanged file all render; F1 after outage; N1 wording |
| Settings › Run defaults | ok — domain select | — | — | |
| Onboarding 1–5 | ok | — | — | 3 (409 path) and 5 (domain select) match S6/S7 |

## Edits made (all small, suites green afterwards)

1. `tests/test_gateway.py:57` — `monkeypatch.setattr(state, "REGRESSION_PATH", runs / "regression.json")` so the
   test stops writing the repo's live `runs/approvals.json` (F5). **Side effect to know:** before this fix the
   suite had already rewritten that file once during this review — content unchanged (v3 `rejected`, empty
   note, set by the frontend-5 browser check), timestamp now `2026-09-26T00:51:26Z`. Gitignored.
2. `README.md:21` — 473 → 474 tests. `README.md:41` — "five attack families" → "five for airline, four for retail".
3. `web/src/pages/Review.tsx:312` — an unchanged file renders in `unified` mode regardless of the toggle (N9).
4. `web/src/pages/Onboarding.tsx:85-87` — the contract text names the three retail sandbox tools and says the
   ticket tools appear only on a ticket world (N8).
5. `web/src/lib/derive.ts` — removed the dead `summaryLine` (N10).
6. This file.

Scratch-only actions (not the repo): approved v1 and v2 of the scratch copy's live run, created and deleted
schedules, connected and deleted a fake agent. The real `runs/` and `history/` were not touched by the browser
work (I could not approve a *history* run's version: the page makes past runs read-only by design —
`Review.tsx:427` "Past runs are a record" — so the approve flow was exercised on the scratch copy's live run).

## Not verified

- The smoke test (Onboarding step 4) and Heal: not started — they call inference. Note the scratch API was not
  keyless despite `env -u WANDB_API_KEY` (N7), so the button was enabled.
- The gateway in `--enforce` in front of a real tools backend outside the test harness; the SIGHUP reload on a
  running process (covered by tests, not run by hand).
- The Fin target against Intercom (fake only).
- macOS only. Nothing was run in a Linux container; the shell scripts (`scripts/dev.sh`) and `find`/`sed` use were
  not exercised under GNU coreutils.
- Runtime performance of the Review tree with many hundreds of runs (17 here).
