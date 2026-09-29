# Backend lane 9 — production-fit review fixes: report

Brief: fix the blocker and the six "should" findings in `docs/plans/handoffs/review-production-fit.md`, each with a
regression test that fails on the pre-fix code and passes after. Everything below is in the working tree, uncommitted.
Tests: **464 → 473** in the main suite (`env -u WANDB_API_KEY uv run pytest -q`, ~70 s on macOS, no model calls); nine
new tests, zero changed expectations elsewhere except where a finding said the old expectation was the bug (S3's
`legit_pass_rate`). Nothing under `web/` was touched; no dependency was added; `.env` was never printed.

How "fails before" was checked: every source file involved is untracked or modified in the working tree, so `git
stash`/`checkout` were not an option (and are forbidden). For each finding the new test was run first against the
unfixed code (red, with the reviewer's symptom in the assertion), then the fix was written, then the test and the
full suite were run. Where a test could not be run against the old code as-is (its cap constants did not exist yet),
the reviewer's repro was reproduced by hand and the numbers are quoted below.

## B1 — gateway follows an archived approval down to v0 (blocker)

**Root cause, confirmed.** `Gateway.reload()` re-read `load_policy_config("approved")` and swapped in whatever came
back if it differed from the live config. `state.approved_version()` reads `runs/approvals.json`; `archive_previous_run()`
moves that file under `history/<stamp>/` when a new run or `reset` starts. So one reload tick after a new run began,
"approved" read as v0 (`check_config(None, approved=True)` → the run-less v0 with **0 rules**) and production went from
the certified policy to no policy. Reproduced in the test: a gateway serving v3 with two rules, `archive_previous_run()`,
`reload()` → before the fix `/health` said `version: 0, rules: 0`.

**Fix** (`chaos/gateway.py`). Under `--version approved`, a reload that reads a version **not above** the live one is
held: the live config stays, the refusal is printed once with the reason (`approvals.json is gone (archived by a new
run or reset)` or `approved is vN, not above the live version`), and `/health` reports `stale: true` alongside the
`version` actually being served. `stale()` is also true when the approvals file no longer certifies the live version
(so the flag appears the moment the file is archived, not only after a refused reload). A pinned `--version N` is
never stale. Module docstring says why the policy only moves up: version numbers restart at v0 every run, so "v1
approved" in a new run is not this run's v1; rollback lands as a new, higher pending version anyway.

**On reading archived approvals under `history/`:** not done, deliberately. The gateway would have to remember which
run's lineage its policy came from and pick the matching archive, and the effect would be to keep silently serving a
policy from a run the operator has explicitly reset — the failure would just move from "fell open" to "never notices".
Holding the live policy and shouting `stale` on `/health` (the Review page can show it) until someone approves a higher
version or restarts is the smaller change with no new ambiguity.

**Test:** `tests/test_gateway.py::test_reload_never_follows_an_archived_approval_down_to_v0`.

## S1 — `/health` created sessions that were never swept

**Root cause, confirmed.** The `_front_door` middleware created a session for any request carrying both
`X-Antibody-Session` and `X-Antibody-Customer`, before checking the path and *before* the bearer check for the
routes that need one. `/health` is open, so an unauthenticated caller could grow the session map one header pair at a
time, and the sweep only runs inside `_session_for` on an authenticated call.

**Fix.** The middleware returns early for `/health` — no bearer, no session. For every other route the bearer is
checked first; only then is the customer name recorded. Audit of the other session-creating paths: `GET /tools`,
`POST /tools/{name}` (both via `build_app`'s `session_for`) and `POST /sessions/{id}/turn` all sit behind the same
middleware, so none of them creates a session before auth passes.

**Test:** `tests/test_gateway.py::test_health_never_creates_a_session` (50 `/health` calls with session + customer
headers, with and without a valid bearer → `sessions: 0`; a real tool call still records the customer once and the
idle sweep still drops sessions). The wrong-bearer → 401 path is covered by the existing
`test_bearer_required_when_configured_and_health_stays_open`.

## S2 — `merge_tool_rules` loosened policy

**Root cause, confirmed.** `chaos/repair_agent.py` merged with "incoming wins when set": `on_failure` `None → "open"`
(None means the class default, which for a money tool is closed — so this opened it), `timeout_s` `None → 9999`
(None is the bus default, `PASSTHROUGH_TIMEOUT_S` = 30 s), and `intent_words` as a **union**, which widens what counts as the customer having
asked. Reproduced in the test: a money tool with the default fail-closed became `on_failure="open"` after one patch.

**Fix.** The docstring now states the rule and the code follows it field by field: `deny`/`requires_*` true wins;
`max_calls` min; `on_failure` is `closed` if either side says so, otherwise the current value stays (so `None` is
never replaced by `open`); `timeout_s` is the smaller, and `None` only gives way to a value below the bus default
(`PASSTHROUGH_TIMEOUT_S`); `intent_words` is the intersection when both sides set it, the one that is set otherwise,
and if the intersection is empty the existing words are kept — a merge can narrow the intent check but never make it
impossible to satisfy, and never widen it. The comment in `apply_patch` that described the union is gone.

**Test:** `tests/test_tool_rules.py::test_merge_never_loosens_the_class_default_or_the_intent_check`.

## S3 — an empty legit guard passed silently

**Root cause, confirmed.** `run_gate` built the legit suite from the covered tasks; with `covered == 0` the suite was
empty, so the "legit users unaffected" leg trivially held and `legit_pass_rate` was `0.0` (0 of 0). The reason
string said nothing about it and the loop status line printed `legit 0.00`.

**Fix.** `GateResult.legit_pass_rate` is `float | None` (default `None`, so the golden tape still parses; the web
types already declared `number | null` and `legitPct` already renders `—` for it — verified, not changed).
When `covered == 0` the legit leg is not evaluated, the rate is `None`, and the reason carries
`legit guard empty — no legit task is runnable against this target` (constant `LEGIT_GUARD_EMPTY` in `chaos/gate.py`).
Acceptance is **not** blocked on it, per plan 10 ("indicate, not refuse"). `chaos/loop.py` gained `gate_status_line()`
so the printed line says `legit n/a: guard empty` instead of a number.

**Test:** `tests/test_aliases.py::test_an_empty_legit_guard_is_named_not_passed_silently`.

## S4 — two tool classifiers, `send_money` failed open

**Root cause, confirmed.** `chaos.toolbus.failure_mode(tool, rule)` classified by **name only** with a word list that
did not include "money"; the Tools panel (`api/tool_setup.py`) classified by name + description + pack class. So the
panel showed `send_money` as money (fail-closed) while the gateway, on a backend outage, let it through `degraded`.
Reproduced in the test with a backend that returns 503.

**Fix.** One classifier: `chaos.tool_rules.tool_class(domain, name, description)` — pack class (including aliases)
when the tool is in the active pack, else name + description, `unknown` when nothing matches. `classes()`,
`starter_rules()`, the repair agent's `_rules_for`, the tools proposal and the gateway all call it. `failure_mode`
now takes the resolved class, `unknown` is closed. The gateway resolves classes once at start from the backend's
`GET /tools` (descriptions included) and again on every reload tick, and pushes the result into open sessions
(`ToolSession.tool_classes`). The name-only word list also learned "money"/"funds" so the fallback agrees with the
panel when no description is available. The duplicate name-only path in `toolbus` is deleted.

**Tests:** `tests/test_tool_rules.py::test_one_classifier_for_the_panel_the_repair_and_the_gateway`,
`tests/test_gateway.py::test_failure_semantics_use_the_class_the_tools_panel_showed`.

## S5 — FinTarget followed `file://`, `data:`, `ftp://`; no byte or drip cap

**Root cause, confirmed.** `_opener` was `build_opener(ProxyHandler({}), _NoRedirect())`, and `build_opener` adds
`FileHandler`, `DataHandler` and `FTPHandler` by default; `sse_subscription_url` from `/fin/start` was opened as-is.
Reproduced: with the old opener, a `/fin/start` answering `file:///…/hosts` had the file **opened and read** by the
episode (the test's stand-in secret file; the episode then reported "did not finish" because a hosts file has no
`status` event). There was also no cap on bytes per line, bytes per stream, or time between bytes — only the 120 s
episode cap.

**Fix** (`chaos/target.py`).
- The opener lists its handlers (`HTTPHandler`, `HTTPSHandler`, `UnknownHandler`, error processors, `_NoRedirect`),
  so anything but http(s) raises `URLError: unknown url type`. This is the one HTTP client Antibody points at an agent,
  so the loop's episodes and the API's ping get the same restriction.
- `_same_origin(url, base)`: the SSE URL must use the **same scheme** as the configured Fin API and a host that is the
  API's host or a subdomain of its registrable domain (`sse.intercom.io` under `api.intercom.io` is allowed; an IP
  must match exactly; no https → http downgrade). `http://` is therefore allowed exactly when the operator configured
  an `http://` Fin API — which is how the tests run — with no separate flag to forget.
- `_sse_lines()` reads the stream with `FIN_LINE_CAP_BYTES` (64 KiB per line), `FIN_STREAM_CAP_BYTES` (1 MiB total)
  and `FIN_IDLE_CAP_S` (60 s between bytes, via the socket timeout), inside the existing 120 s episode cap. A capped
  stream ends the episode with what was read so far and an error naming the cap. `_fetch_json` caps JSON replies at
  `MAX_JSON_BYTES` (4 MiB).

**Tests:** `tests/test_fin_target.py::test_the_sse_url_must_be_the_fin_apis_own_scheme_and_host`,
`tests/test_fin_target.py::test_the_stream_is_capped_in_bytes_per_line_and_in_idle_time`. `tests/conftest.py::FakeFin`
gained `sse_url`, `raw`, `trickle`/`drip` to play a hostile URL, exact bytes and a byte-a-time server.

## S8 — `turn` endpoint unbounded

**Root cause, confirmed.** `POST /sessions/{id}/turn` appended to `customer_turns` with no count or length check and
FastAPI's `Body(...)` read any size. Reproduced before the fix: 300 turns of 1 MiB each → 300 × 200, **300 MB** held
by one session until the idle sweep.

**Fix.** Three constants together in `chaos/gateway.py`: `MAX_TURNS_PER_SESSION = 200` (→ 429
`session X has reached 200 turns; start a new session`), `MAX_TURN_CHARS = 16 KiB` (→ 413), `MAX_TURN_BODY_BYTES =
64 KiB` (→ 413, checked on the raw body before JSON parsing, same figure as `toolserver.MAX_BODY_BYTES`). All checks
run before the session is touched, so a refused turn creates no session and writes no log row. The docstring carries
the reviewer's design note: whoever holds the bearer can satisfy `requires_user_intent` by posting a turn.

**Test:** `tests/test_gateway.py::test_turns_are_capped_per_session_in_length_and_in_body_size`.

## Ruff

The one `F401` the reviewer found (`Scenario` in `tests/test_domains_loop.py`) was already removed by the reviewer
(review §"Edits made", item 1) — verified absent. The `Body` import in `chaos/gateway.py` became unused with the S8
change and was removed. No ruff config or dependency added.

## Counts

| step | new tests | suite |
| --- | --- | --- |
| start | — | 464 |
| B1, S1, S2, S3 | 1 each | 468 (derived) |
| S4 | 2 | 470 (derived) |
| S5 | 2 | 472 (derived) |
| S8 | 1 | **473 passed** (measured, 70 s) |

The suite was run after each fix; only the start and end figures are quoted from captured output, the intermediate
ones follow from the test additions.

## Where I differed from the reviewer, and what is not covered

- **B1**: did not make `approved_version()` read archives under `history/` (reasoning above).
- **S5**: no separate "allow http" flag — the SSE URL must match the configured API's scheme, which already lets the
  test fake run over `http://` and refuses a downgrade in production. Same-scheme + same-registrable-domain is a
  little looser than "host equals the configured host" because Intercom serves the stream from a sibling host; an
  exact-host rule would have broken the real integration.
- **S4**: `unknown` was already fail-closed in `failure_mode`; the finding was the *classification* disagreement.
- Not tested: a real Intercom account (the SSE origin rule is exercised only against the fake, which uses
  `127.0.0.1`), and a live uvicorn process under `SIGHUP` (reload is tested in-process). The 1 MiB / 60 s caps are
  judgement calls against Fin's stream and may need tuning against real traffic. `_same_origin`'s "same domain" is
  the last two host labels with no public-suffix list, so a Fin API configured under a two-label suffix such as
  `co.uk` would accept any host under that suffix; Intercom's hosts are `*.intercom.io`, where the rule is exact.
