# Independent review — `feature/production-fit` (plan 10 §5b build)

Reviewer: independent security + correctness pass, 2026-09-22. Scope: the whole uncommitted working tree
(`git diff` + untracked), read as one change: roadmap-v1 work (auth, approvals, incidents, schedules, gateway v0)
plus lanes backend-6/7/8 and frontend-5. Nothing was committed, stashed or checked out.

## Verdict: **blockers remain** (one), otherwise close to ship-ready

The core loop holds up: the same `tool_rule_blocks` runs in the sandbox (`chaos/toolbus.py:126`), in pass-through
(`:183`) and in the replay (`chaos/gateway.py:315`), so a rule the gate approves is the rule the gateway enforces.
Auth is sound (no path-normalisation bypass, constant-time compare, token never in a URL, backend auth never logged).
Fail-closed holds when the rule check itself throws (`toolbus.py:184-187`). Old records parse (golden replay tests
pass; `GateResult` defaults `fix_samples/fix_passes/legit_covered` sensibly).

The one blocker is the default gateway mode: `--version approved` silently falls to **v0 with zero rules** the
moment anyone starts a new run or runs `reset`, because those archive `approvals.json`. In `--enforce` that is
production falling open within 60 s of a click on Heal. Reproduced below.

---

## Findings

### Blocker

**B1 — `--version approved` follows a run archive down to v0 (0 rules).** `chaos/gateway.py:253-271` +
`chaos/state.py:185-189`, `chaos/state.py:368`.
`reload()` calls `check_config(None, approved=True)`; `approved_version()` returns `0` when `approvals.json` is
absent, and `archive_previous_run()` (every new run, and `reset`) moves that file to `history/`. Reload then sees a
*valid* v0, swaps it in, prints `policy now v0 (0 rules)`. The docstring promise ("keeps enforcing rather than
falling open") only covers a load *error*. Repro (temp dirs, no network):

```
live: 1 rules 1
archived to: 20260922T141106Z
gateway: policy now v0 (0 rules)
after reload: changed True -> v 0 rules 0 approved_at None
```

The pinned path (`--version 1`, what the Review page's Export copies) is safe: the file is gone → `FileNotFoundError`
→ live config kept. Minimal fix: in `reload()`, when `self.version == "approved"` and the fresh config's version is
lower than the live one (or `approved_version()` is 0 while live > 0), keep the live config and print a warning; add
a test beside `test_gateway.py`'s reload tests that archives and asserts the version is unchanged.

### Should-fix

**S1 — Unauthenticated `/health` can create unbounded sessions.** `chaos/gateway.py:189-197`.
The middleware skips the bearer for `/health` but still runs the session block: any request carrying
`X-Antibody-Session` + `X-Antibody-Customer` creates a `ToolSession` (with its own `fresh_db()` copy). The idle
sweep lives only in `_session_for` (`:207-210`), which `/health` never calls, so with no authenticated traffic the
map only grows. Repro: 50 unauthenticated `GET /health` → `session_count() == 50`; `POST /tools/...` without bearer →
401 (auth itself is fine). Fix: `if sid and customer and request.url.path != "/health":` (or run the block only after
the bearer passed), and sweep idle sessions in the middleware too. Consider a hard cap on `len(self._sessions)`.

**S2 — `merge_tool_rules` can loosen relative to the class default and the intent check.**
`chaos/repair_agent.py:628-647`. "Tighten only" holds field-by-field only when both sides are set. With
`current.on_failure=None` (= class default `closed` for money) an incoming `open` wins; with `current.timeout_s=None`
(= 30 s bus default) an incoming `9999` wins; and `intent_words` is a **union**, which makes `requires_user_intent`
*easier* to satisfy (any word counts, `chaos/tools.py:53-56`). Repro:

```
current : {requires_user_intent, intent_words:['refund'], requires_verified_lookup, max_calls:1}
incoming: {intent_words:['hello'], on_failure:'open', timeout_s:9999}
merged  : {... intent_words:['hello','refund'], on_failure:'open', timeout_s:9999}
failure_mode('issue_refund') before: closed  after: open
```

The repair prompt (`:63-68`) never mentions `on_failure`/`timeout_s`, so today the LLM is unlikely to emit them, but
`Patch` accepts them and the onboarding/tool_setup path merges too. Fix: resolve `None` against the defaults before
comparing (`closed` if either side is `None` and the class fails closed; `min(timeouts + [PASSTHROUGH_TIMEOUT_S])`),
and treat `intent_words` as *intersection when both non-empty, else the non-empty side* — or simply reject
`intent_words` growth in a patch. Note `aliases` is a `ToolSpec` field (pack), not a `ToolRule` field, so there is
nothing to merge there; the review brief's "incl. aliases" does not apply.

**S3 — Gate's legit leg vanishes silently when coverage is 0.** `chaos/loop.py:89-94`, `chaos/gate.py:101-126, 162-166`.
A target whose listed tools match none of the pack's (by name or alias) gets an empty `legit_suite`; `legit_run` has
no verdicts, `newly_broken_legit` is empty, so `accepted=True` with reason "… legit users unaffected" while
`legit_pass_rate` is `0.0` and `legit_covered = {covered: 0, total: 11}`. The UI shows `legit 0/0`-style numbers
and never shows `covered/total` (see UI-1). Fix: in `run_gate`, when `legit_covered` says `covered == 0`, say so in
`reason` ("no legit task could be run against this target; the legit guard did not run") and surface it on the Run
page; optionally refuse `--enforce`-bound approval of such versions on the Review page.

**S4 — Fail semantics use a different classifier than the Tools panel.** `chaos/tool_rules.py:108-112` vs
`chaos/tool_rules.py:93-94` and `chaos/repair_agent.py:533`.
`failure_mode()` classifies by **name only**; the panel/starter rules classify by name **and description**, and the
pack's `ToolSpec.cls` overrides both where the pack knows the tool. So the class a person saw at onboarding is not
necessarily the class that decides open/closed in production: `send_money` → `message` → fails **open**;
`get_refund`/`check_out_payment` → `read` → open; a tool whose description says "charges the card" but whose name
does not → whatever the name says. Fix: decide once — store the resolved class on the rule (or resolve via the active
pack + description at gateway start) and have `failure_mode` read that.

**S5 — `FinTarget` follows any URL scheme and has no size cap.** `chaos/target.py:199-202, 219-249, 289-305`.
`sse_subscription_url` comes from the remote response and is opened with `_opener`, whose default handler set
includes `FileHandler`, `DataHandler` and `FTPHandler` (verified: `file:///etc/hosts` opens; `data:` returns JSON).
A hostile or mis-set `INTERCOM_FIN_URL` can make Antibody read local files into the transcript that the judge and
history then see. No token is sent on that request, so nothing leaks outbound. Separately, `resp.readline()` and
`resp.read()` have no byte cap: one huge `data:` line or a multi-GB JSON body is read whole; a byte-a-time drip that
never sends `\n` defeats the deadline (checked only between lines). Fix: require `sse_url` to be `https://` on the same
host as `base_url`; build the opener from an explicit handler list (HTTP/HTTPS only); `readline(64 * 1024)` and a
total-bytes cap; `_fetch_json` reads at most N MB. HTML stripping (`html_to_text`) is fine — output is text, never
rendered.

**S6 — Onboarding dead-ends for a second agent.** `api/tool_setup.py:46-48`, `web/src/pages/Onboarding.tsx` step 3.
"Apply N starter rules" refuses with *"the live run was made against 'http://127.0.0.1:8792', not this agent; Clear it
first"* whenever `runs/live` belongs to another agent — correct guard, but the wizard offers no way to clear and the
alert has no link. Reproduced with a fake agent on :8799. Fix: link the alert to the Run page's *clear*, or let the
wizard call the same clear endpoint after confirming.

**S7 — No way to pick a domain from the UI.** `web/src` has no domain control (only display in `derive.ts:1618`,
`Review.tsx:248`). `POST /api/loop/start {domain}` and `add_agent(domain=…)` exist (`api/loop_ctl.py:283`,
`api/agents.py:193`), so airline is CLI/env only, and the wizard's copy says "sandbox storefront" for every agent.
Not in §5b's frontend scope, so filed as should-fix rather than blocker; the lead should decide.

**S8 — Gateway `turn` endpoint is unbounded.** `chaos/gateway.py:169-177`. `customer_turns` grows per session with no
count or length cap and the body has no size limit (the tools routes cap at `MAX_BODY_BYTES`, `toolserver.py:53`).
Fix: cap `len(text)` and the list length. Also note (by design, worth a README line): whoever holds the bearer can
satisfy `requires_user_intent` by posting a turn — the rule trusts the agent to relay the customer's words.

### Nits

- `chaos/gateway.py:170` — `body: dict = Body(...)` (ruff B008; FastAPI idiom, harmless). A typed Pydantic body would
  also give the 400 for free.
- `api/main.py:690-704` — replay truncates at `tail` rows *before* rebuilding sessions, so a session whose `turn` rows
  fell outside the window looks intent-less and inflates `would_block`. Read `turn` rows for the sessions in scope, or
  note it in the panel.
- `chaos/judge.py:180-182` — class-level `forbidden_calls` (no args) are deliberately not matched here (tested in
  `test_aliases.py:130`), but `chaos/domains/__init__.py:78` says "any call of it". A `message`-class call to the
  customer's own address, unrequested, reaches only the LLM judge. Align the docstring or the check.
- Northwind strings outside the retail pack (`rg` run as asked; comments excluded): `api/agents.py:69`
  `PING_CUSTOMER_ID = "cust_owen"` (ping uses a retail customer for airline agents); `chaos/schemas.py:182`
  `Scenario.customer_id` default; `chaos/scenarios.py:64` fallback; `api/manifest.py:31,33` per-domain dicts keyed
  by literal tool names (`TARGET_NAMES`, `FREE_TEXT_FIELDS`) that a third pack would silently miss — these belong on
  the pack. `chaos/repair_agent.py:218,565` are inside retail-only branches (fine).
- `web/src/lib/derive.ts:591,1617` — `world === "mock"` renders "sandbox storefront" regardless of `row.domain`; the
  live airline run reads "Example airline agent · sandbox storefront". Same copy in `Onboarding.tsx:46,387,482,499,546,616`
  and `Agent.tsx:306`.
- `web/src/lib/derive.ts:1411` builds the gateway command string a second time (backend has
  `gateway.command_line()`, used by Settings via `/api/gateway`); the two differ (`--shadow` spelled out only on the
  backend). One source: return it from the API.
- `web/src/pages/Onboarding.tsx:191-199` hand-rolled boot-wait loop and `Agent.tsx:71` `setInterval` — second
  polling patterns beside `usePoll`. Minor; both are one-shot waits.
- `web/src/components/ui/radial-orbital-timeline.tsx:162` hard-codes `bg-black`/`border-white` instead of tokens.
  Centre orb (`:172-176`) has **no** pulse — verified in code and on screen.
- ruff (not configured in `pyproject.toml`; run via `uvx` with the user-level config): 95 findings, none in the bug
  classes except `F811` ×9 in `tests/test_archive.py` (pytest fixture shadowing — false positives), `PLW1510` ×6
  (`subprocess.run` without `check=` in tests, intentional), `F401` ×1 (fixed, below). Suggest adding a `[tool.ruff]`
  section so the number means something.
- Lint (`oxlint`): 0 errors, 10 warnings, all in files this change did not touch (`ui/orb.tsx`, `ui/button.tsx`,
  `ui/badge.tsx`, `hooks/useDwell.ts`).

### Checked and clean (so nobody re-reviews them)

- Bearer covers every gateway route but `/health` (`gateway.py:186-188`); every `/api/*` but `/api/health`
  (`api/auth.py:43-48`, global middleware `api/main.py:95-98`). Probed `//api/runs`, `/api//runs`, `/API/runs`,
  `/api/%72uns`, `/api/./runs`, `/api/health/`, `Basic`, `?token=` — all refused or 404; `/app/api/runs` serves the SPA
  shell (static, holds nothing).
- Inbound token never forwarded: `_backend_headers` sends only `X-Antibody-Session` and `ANTIBODY_BACKEND_AUTH`
  (`toolbus.py:223-229`). Backend auth appears in no log row (`log_line`), no status line (`'forwarded'|'none'`), no
  health/replay payload.
- `X-Antibody-Customer` is a log field only (`gateway.py:190-197, 217-220`).
- Session ids are dict keys and JSON values, never paths. Idle drop works on the authenticated path (S1 is the gap).
- Reload reads only `state.CONFIGS_DIR` (fixed by env at process start); `--version` is `approved|int`.
- Frontend token: `localStorage`, sent as a header only (`api.ts:507-528`); the log is fetched, not linked
  (`Run.tsx:86-97`).
- Incident import parser: 20 000-char cap, linear, tolerant of `>`/`Customer:`/case; all prefixes contain `:` or are
  `> ` so `split(":", 1)[1]` cannot IndexError.
- `elapsed_ms` covers check + backend (`toolbus.py:177, 208`); `prior_calls` counts only calls that ran (`:68-70`), so
  a blocked attempt does not consume `max_calls`; `verified_by`/`_note_verified` only trust read-class tools.
- Replay is pure and ordered per session; `samples` capped at 20 (`gateway.py:286-331`).
- Airline example uses only `openai-agents`, `fastapi`, `httpx`, `uvicorn`; no new dependency in `pyproject.toml` or
  `web/package.json`.
- New components with one call site: `ImportIncidentDialog`, `ScheduleDialog` (dialogs — allowed), `RadialOrbitalTimeline`
  (a widget). `Facts` ×3, `TokenField` ×2, `ConfigDiff` ×2.

### UI

**UI-1 — `legit_covered` is not shown.** `web/src/lib/derive.ts` (gate strip, `:1380`), `Run.tsx`. The API returns
`legit_covered: {covered, total}` per gate and per run; the UI only ever shows the covered count as a denominator
("legit 3/10"), so a target with 0 or 3 of 11 tasks in reach looks the same as full coverage. Frontend-5 did not
build it (out of its scope); one Facts row "legit coverage 10/11" closes it.

(continued in Part 2 below)

---

## Part 2 — what was run, what was seen

### Commands and results

| Command | Result |
| --- | --- |
| `env -u WANDB_API_KEY uv run pytest -q` | **464 passed**, 1753 warnings, 88 s (golden replay tests included) |
| `cd examples/agents/openai_cs_airline && uv run pytest -q` | **7 passed**, 1 warning |
| `npm --prefix web run build` | built in ~2 s (rolldown chunk-size advisories only) |
| `npm --prefix web run lint` | exit 0; 10 warnings, all pre-existing files (see nits) |
| `uv run ruff check …` | ruff is **not configured or installed** for this project (`Failed to spawn: ruff`) |
| `uvx ruff check api chaos tests --statistics` | 95 findings under the user-level config; see nits |
| `GET /api/domains` | `[{airline: 7 tools, 11 legit}, {retail: 3 tools, 11 legit}]` |
| `GET /api/gateway/replay?version=abc` | 400 `version must be 'approved' or a saved version number` |
| `GET /api/gateway/replay?version=99` | 404 `no saved config v99` |
| `GET /api/gateway/replay?version=1` | `{calls: 5, would_block: 3, by_tool: {book_new_flight: 3/3, get_matching_flights: 0/2}}` |
| `GET /api/runs` | `domain`, `seed`, `legit_covered` present on the live airline run (`{covered: 10, total: 11}`), `null` on pre-pack runs |
| `POST /api/loop/start {"domain":"hotel"}` | 400 `unknown domain 'hotel'; one of ['airline', 'retail']` |
| Auth probe (TestClient, token set) | all `/api/*` variants 401/404; `/api/health` 200; good bearer 200 |

Probes were run from `/tmp` scripts with `PYTHONPATH=.` and temp `ANTIBODY_RUNS_DIR`/`ANTIBODY_HISTORY_DIR`; none
touched the repo's `runs/` or `history/`. The one agent row I created via the wizard was deleted through the API
afterwards (`history/agents.json` is gitignored either way).

### Browser walk (API on :8060 + Vite on :5174, separate from `scripts/dev.sh` to avoid the :8000 loop)

| Page | Result |
| --- | --- |
| Home | Needs-attention list (11 rejected patches of the live run), recent runs. OK. |
| Agents | Three rows (built-in with *Attack next*, example, example-airline) + connect card. The example rows have no start/stop control — by design (spawned from the wizard/Agent page). OK. |
| Agent — example-airline | Versions (v0/v1 radio, *Review this version*), attacks on v1, **Tools** panel (*"This agent has not listed its tools. Ping it"* — the example was not running), **Shadow log** panel with `book_new_flight … would block` rows, regression suite (6). Copy says "sandbox storefront stands in" for an airline agent (nit). |
| Review `/app/review?run=live&v=1` | Queue (1 pending), Files (`tool_rules.json`, 1 changed), diff v1 vs v0 (3 rules added), **Shadow replay** panel ("would have blocked 3 of the last 5 real calls", per-tool bars, 3 samples), Export (rules JSON + pinned gateway command). Header: "held 2/2 trials · legit users 4/10". Approve/Reject present, not clicked. |
| Run (live) | Header "Sep 22, 6:13 AM · Example airline agent · **sandbox storefront** · 2 chaos cycles · 1 repair attempt · v0 → v1" (domain not named; nit). Cycle 12 strip shows gate `regression 3/5 · legit 3/10`, `fixed 1/2 — not accepted` (pass^k). Cost and latency are in the Facts strip per `derive.ts:1610-1618` (domain, seed shown there). **`legit_covered` is displayed nowhere** — only the covered count appears as the legit denominator, never `covered/total` (UI-1, ties to S3). |
| Cycle | Config diff renders (shared `ConfigDiff` with Review). OK. |
| Schedules | Orbital timeline with one schedule ("Sweep"); centre orb static, **no pulse**. OK. |
| Settings | Run defaults / Display / Models / Environment / Access; Environment shows the gateway command from the API; Access shows the token form. OK. (The seeds stepper briefly reads "all (10)" before the manifest loads — the API cap fallback, not a bug.) |
| Onboarding 1 → 5 | Step 1 choose; step 2 connect — Ping against a fake agent on :8799 → "ok · 0 ms · “hello from fake”", Save → step 3; step 3 Tools lists 3 tools classified (`issue_compensation` money · `send_sms` message · `get_trip_details` read), **Apply 2 starter rules fails** with the "Clear it first" alert (S6), *Continue without rules* works; step 4 smoke test shown, **not run** (see below); step 5 First run renders settings + Heal, no domain control (S7). Screenshots of steps 3 and 5 taken; nothing visually broken. |

### Edits made (all nits, tests green afterwards)

1. `tests/test_domains_loop.py:20` — removed unused `Scenario` import (ruff F401). `pytest tests/test_domains_loop.py` → 14 passed.
2. `web/src/api.ts:37` — replaced the stale `forbidden_tool_calls: string[]` on `Scenario` (backend dropped it in
   backend-6) with optional `expected_calls`/`forbidden_calls` mirroring `CallSpec`. No web code read the old field.
   Build + lint re-run clean.
3. `docs/FRONTEND.md:240` — same field rename in the cycle-record contract.

Everything else above is a finding, not a fix.

### Not verified

- **The 3-cycle smoke attack and a full loop on W&B.** `WANDB_API_KEY` was not in my shell (it is in `.env`, which the
  API process loads, but the brief said not to spend inference without it in *my* env, and the only target I had up
  was a fake). backend-8's report describes one accepted `tool_rules` patch reaching the shadow log; the shadow-log
  rows and replay numbers I saw are consistent with that, but I did not reproduce it.
- **Linux.** Everything ran on macOS; the gateway, `signal.SIGHUP`, `os.replace` and the subprocess tests are
  untested on the target container.
- **Real Fin, real customer tools, real Zendesk.** `FinTarget` was reviewed and probed against a fake only; Zendesk
  is suspended.
- **`--enforce` under real traffic.** Only shadow rows exist in `history/gateway.jsonl`.
- **The OpenAI Agents SDK example (`openai_agents_support`)** was not started; only its airline sibling's tests ran.

---

## README drift (specific stale sentences — for the lead to rewrite)

- L16 "Target Agent is a customer-support bot (Llama 3.1 8B) working a real Zendesk ticket with tools for orders,
  refunds, and email." — retail-only; there are two domain packs (`chaos/domains/{retail,airline}`), chosen by
  `ANTIBODY_DOMAIN` / the agent row / `POST /api/loop/start {domain}`. Neither the env var nor the airline pack is
  mentioned anywhere in the README.
- L46 "API on :8000, web UI on :5173" — still true (`scripts/dev.sh`); but the gateway's own port (8766) and
  `ANTIBODY_GATEWAY_PORT` are absent.
- L49 "Results lists every cycle" / L79 "The Results page's seed-attack preview…" — there is no Results page; the
  routes are Home, Agents, Current run, Runs, Schedules, Review, Settings (`web/src/lib/routes.ts`).
- L71 "The worked example is `examples/agents/openai_agents_support/`" and L112 "today one stock OpenAI Agents SDK
  agent" — there are two: `openai_cs_airline/` (the OpenAI CS demo on `gpt-oss-120b`, MIT-attributed) is new.
- L86 "On the run page you approve or reject it" — approval moved to the Review page (`/app/review`), which also
  carries the diff, the shadow replay and the export.
- L90 "classified by name (money, message, mutate, read)" — also `unknown`, and by description as well as name.
- L15/L17 describe attacks and judge checks in Northwind terms only ("someone else's order", "refund an order");
  the judge is now class-based with pack-defined families, aliases and an end-state check.
- L41 command list omits `--domain`-equivalent (`ANTIBODY_DOMAIN`) and `ANTIBODY_SEED` (seeded determinism, recorded
  in `run.json`).
- L92 is accurate. Missing from the whole README: cost/latency per cycle, pass^k, legit coverage, the wizard's
  smoke-test step, `FinTarget` (`ANTIBODY_TARGET=fin:<label>`), and the Northwind→"retail pack" rename.
- L116 docs map: `docs/plans/` (the roadmap and handoffs) and `docs/SMOKE.md` are not listed.
