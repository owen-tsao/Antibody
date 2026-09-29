# Review of plan 11 — results matrix, review inbox, schedule avatars, Weave (independent, before build)

Reviewed Sep 27, 2026 against the working tree on `feature/production-fit` (480 tests collected, nothing committed) and
the installed `weave 0.53.9` (`.venv/lib/python3.12/site-packages/weave`). Nothing was implemented; no git state was
touched. Every claim below is marked **verified** (read in code or run in the venv), **inferred**, or **unknown**.

## Verdict: build with changes

The three UI items (§1 matrix, §2 inbox, §3 avatars) are sound and cheap once two data-shape errors are fixed. The
Weave section is where the plan is wrong in ways that would cost a day: two of the seven items rest on API behaviour
that does not exist as described (threads do not nest across processes; a Leaderboard cannot compare gate legs whose
Evaluation objects differ per cycle), one would break keyless tests as written (prompt publishing in `save_config`),
and one (§4.4) is the only item with a real security surface and no customer to exercise it. Cut list at the end.

## 1. Facts table (plan §0 and the Weave API claims)

| # | Claim | Status | Evidence |
| --- | --- | --- | --- |
| F1 | `weave 0.53.9` installed; exposes `weave.thread`, `weave.StringPrompt`, `WeaveClient.add_cost` / `query_costs`, `Call.apply_scorer`, `call.feedback.add/add_note/add_reaction`, `weave.flow.leaderboard.Leaderboard`/`LeaderboardColumn(evaluation_object_ref, scorer_name, summary_metric_path, should_minimize)` | **verified** | `uv run python -c "import weave; …"`: version `0.53.9`; all names import; `LeaderboardColumn` fields exactly as listed (`should_minimize: bool \| None = None`) |
| F2 | 22 `@weave.op`s | **verified** | `rg -o "@weave\.op" chaos api examples` → 22 (12 of them are pack tools under `chaos/domains/*/tools.py`) |
| F3 | `weave.Evaluation` per gate leg with `judge_scorer` (`evals.py:61,133`); `TargetAgent(weave.Model)` (`:27`); `publish_dataset` (`:81`); `weave_eval_urls` (`schemas.py:466`); `weave.init` at `loop.py:445`; project string `config.py:15` | **verified** | line numbers match |
| F4 | `vulnerability_by_version` at `loop.py:607`, reachable only as CLI `vulnerability` (`:447`); no API route; `loop_ctl` spawns only `run` | **verified, incomplete** | also reached by `chaos.loop run --vulnerability` → `_measure_vulnerability` (`loop.py:554-576`), and `LoopStartBody.vulnerability` defaults **True** (`api/loop_ctl.py:114`), so every dashboard run already measures v0 and the final version. The Measure action's marginal value is intermediate versions, CLI runs and failed measurements — not "the file is usually null" |
| F5 | `GET /api/state` returns `vulnerability` (`api/main.py:315`) | **verified** | and `?source=run:<id>` works for history runs: `archive_previous_run` moves `vulnerability.json` + `vulnerability_detail.json` (`chaos/state.py:387-388`); 3 history folders have one |
| F6 | `vulnerability` shape is `{version: {scenario_id: landed_bool}}` (plan §1, "confirm") | **wrong** | `store.read_vulnerability` (`api/store.py:183-216`) returns `{"landed": {"v0": 8, "v4": 5}, "suite_size": 8, "world": "mock"\|"zendesk"\|null}` — per-version **counts**. Per-attack cells live only in `vulnerability_detail.json` (`{"samples": 3, "rule": …, "world": …, "landed": {"v0": {"seed-injection-refund": [true,true,true], …}}}`) which the API reads for `world` alone. See §7 for the exact shape to add |
| F7 | `RunRow.vulnerability` type in `api.ts` | **wrong** | `vulnerability` is on `State` (`api.ts:464`), not `RunRow` (`api.ts:312-347`). `RunResults` reads `state?.vulnerability` (`RunResults.tsx:55`) |
| F8 | Gate numbers per version (`fix_passes/fix_samples`, `regression_pass_rate`, `legit_pass_rate`, `legit_covered`, `cost_usd`, `latency_ms`) are on every cycle record | **verified with a caveat** | `schemas.py:466-535`; `cost_usd`/`latency_ms` are the whole **cycle's** bill (target + judge + chaos + repair + gate; `loop.py:344-351`), not the version's. Label the column "cycle cost", not "cost per version" |
| F9 | Review page: tree scoped by the sidebar switcher; tabs are `(run, version, file)` (`ReviewTab`); `decisionLabel` marks archived; `POST /api/configs/{v}/review` live only; `Shell` nav positional | **verified** | `Review.tsx:104-115`, `derive.ts:1373-1465`, `main.py:402-409`, `Shell.tsx:79` |
| F10 | `AgentTile` in `web/src/components/AgentCard.tsx` | **wrong file** | it is `web/src/components/AgentTile.tsx` (sizes `20 \| 28 \| 48`, uses `CARD_PHOTO` from `AgentCard` and `agentHueRotate`). Six call sites already |
| F11 | Schedules nodes are 28 px `MetalFrame` orbs with `monogram(name)`; `TimelineItem` has no `icon` | **verified** | `radial-orbital-timeline.tsx:18-29, 232-234`; `Schedules.tsx:59` |
| F12 | "`monogram()` is deleted with its tests" | **wrong** | there is no web test runner (`web/package.json` has no `test` script; no `*.test.ts`). Delete the function and its two doc mentions; there are no tests to delete |
| F13 | Home "Needs attention" = `attentionWhy` | **verified** | `derive.ts:2218-2226` (`needsAttention` / `attentionWhy`) |
| F14 | 480 keyless tests; conftest isolates `runs/` and disables dotenv | **verified** | `uv run pytest -q --co` → 480; `tests/conftest.py` per backend-10 F5 |
| F15 | Keyless tests "already monkeypatch `weave.init`" (plan §4) | **wrong** | nothing patches `weave.init`. Tests stay offline because no test path calls `loop.main()`, `weave.publish` or a client method; `@weave.op` functions run as plain functions without a client (verified: `f(1)` → 2, `f.call()` → `NoOpCall(id=None)`). `weave.publish` without init raises `WeaveInitError`; `weave.init` without a key **prompts for the key on stdin** (verified). Note `loop.main()` calls `weave.init` unconditionally (`loop.py:445`) — the loop process always needs the key; `api/` never inits |
| W1 | `weave.thread(thread_id)` semantics; cross-process join | **verified — partly wrong in the plan** | `weave/trace/api.py thread()` sets a ContextVar; `weave_client.py:1553-1582` copies it onto each `Call` as a plain string column `thread_id`, and a call whose parent is `None` or has a different `thread_id` becomes a **turn** (`turn_id = call_id`). `parent_id`/`trace_id` come only from the in-process call stack (`:1512-1527`); there is no cross-process propagation API (`rg -i propagat\|traceparent` → none). So: another process (or another thread — the tool server runs in a daemon thread, `toolserver.py:155`, and handlers run via `run_in_threadpool`) passing the same `thread_id` **joins the same Thread** in the Threads view, as sibling turns — it does **not** nest under the episode's trace. The definition of done "tool calls nested" cannot be met; "grouped in one thread" can |
| W2 | `WeaveClient.add_cost` signature | **verified** | `add_cost(self, llm_id: str, prompt_token_cost: float, completion_token_cost: float, effective_date=None, prompt_token_cost_unit='USD', completion_token_cost_unit='USD', provider_id='default', cache_read_input_token_cost=0, cache_creation_input_token_cost=0) -> CostCreateRes`. Costs are **per token**, not per million (`in_memory_trace_server.py:1583-1589`); our table is per million |
| W3 | Cost key path on `call.summary` | **verified** | `summary["weave"]["costs"][<llm_id>]["prompt_tokens_total_cost" \| "completion_tokens_total_cost" \| "cache_read_input_tokens_total_cost" \| "cache_creation_input_tokens_total_cost"]` (`eval_results_helpers.py:245-280`). Only present when the call is **read back** with `client.get_call(id, include_costs=True)`; the local `Call` returned by `op.call()` never carries it. `llm_id` is the **response's** `model` string (`weave_client.py:1739-1751`), which for W&B Inference is **unknown** to equal the request id (`openai/gpt-oss-120b`) — check one existing call's `summary.usage` keys before relying on it |
| W4 | `Call.apply_scorer` requirements | **verified** | `async def apply_scorer(self, scorer: Op \| Scorer, additional_scorer_kwargs=None) -> ApplyScorerResult` (`call.py:216`). A plain `@weave.op` function is accepted (`apply_scorer_async`, `scorer.py:407`); a `weave.Scorer` subclass is optional. Scorer argument names must match the call's `inputs` keys plus `output`; it is a coroutine, so `asyncio.run(...)` from sync code. Requires a real `Call` (from `op.call(...)`) with `id`; on a `NoOpCall` (no client) it fails |
| W5 | `call.feedback.add_reaction/add_note`; `Call` from id | **verified** | `RefFeedbackQuery.add_reaction(emoji, creator=None) -> str`, `add_note(note, creator=None) -> str` (`feedback.py:271-292`); `WeaveClient.get_call(call_id, include_costs=False, include_feedback=False, columns=None)` (`weave_client.py:876`) returns a `Call`; `call.feedback` raises `ValueError` when `id` is None and needs an initialised client (`require_weave_client`). `weave_eval_urls` are `…/r/call/<id>` (`urls.py:54-55`), so the id is the last path segment — but storing `EvalRun.call.id` is cleaner, as the plan says |
| W6 | `Leaderboard` / `evaluation_object_ref` | **verified — plan's use is wrong** | `get_leaderboard_results` (`flow/leaderboard.py:30-95`) filters `Evaluation.evaluate` calls by `input_refs=[evaluation_object_ref]`, groups **rows by the `model` input ref** and matches columns on `get_ref(call.inputs["self"]).uri == evaluation_object_ref`. So the ref must be the **Evaluation object's** ref (obtain with `get_ref(evaluation).uri` after `evaluate`), and every version must have been evaluated with the **same** Evaluation object. Today `run_evaluation` builds a new `weave.Evaluation(dataset, scorers, evaluation_name)` per call (`evals.py:133`): `gate-new`'s dataset is `[new_failure]` (differs per cycle) and `gate-regression`'s is the suite minus the new row (differs per cycle) → different refs → no shared column. Only `gate-legit` (published `legit_dataset`, constant name) shares a ref across versions. `summary_metric_path` for `judge_scorer` is `passed.true_fraction` (`auto_summarize`, `scorer.py:181-185`). There is **no cost in an Evaluation's output** (`eval.py:287-314`: scorer summaries + `model_latency`), so a "cost (minimize)" column has nothing to read |
| W7 | `weave.StringPrompt` | **verified** | `StringPrompt(content: str)`; `.format(**kwargs)` uses `str.format` (`prompt/prompt.py:89-111`) — publishing never calls it, so braces in our prompts are safe. `weave.publish(obj, name=None, tags=None, aliases=None) -> ObjectRef` |
| W8 | Weave redacts secrets in inputs | **verified — narrow** | `utils/sanitize.py:7-11`: only keys `api_key`, `auth_headers`, `authorization` (case-insensitive). `ToolSession.backend_auth` (the `ANTIBODY_BACKEND_AUTH` bearer, `toolbus.py:47`) would **not** be redacted. `redact_pii` needs `presidio` (not installed) |
| W9 | `weave.init` options | **verified** | `init(project_name, *, settings, autopatch_settings, postprocess_inputs, postprocess_output, attributes)`; `UserSettings.print_call_link` (default True), `capture_code`, `capture_system_info` (adds python/OS version, no hostname). `weave.get_client()` returns `None` when not initialised — the one guard every optional Weave call should use |

## 2. Findings by severity, with the minimal plan change

### Critical (would ship broken or unsafe)

**C1 — §1 matrix is built on a shape that does not exist (F6, F7).** The plan's `RunRow.vulnerability` and
"`{version: {scenario: bool}}`" are both wrong; the frontend lane would code against a guess.
*Change:* extend `store.read_vulnerability` to also return `by_attack` from `vulnerability_detail.json` (shape in §7),
keep it on `State`, and read it via the existing `api.state({source})` on the Run page. No new route.

**C2 — §4.2 "tool calls nested under the episode" cannot happen (W1).** Tools execute in the tool-server thread /
gateway process; Weave nesting is in-process only. With the same `thread_id` they appear as sibling **turns** in the
Threads view. *Change:* rewrite the acceptance to "episode turn and its tool-call turns share one Thread", keep
`with weave.thread(session_id)` around `run_episode` only, and pass `session_id` to the tool server so it wraps
`execute_tool` in the same context. Do not chase `parent_id` propagation — no API for it.

**C3 — §4.3 Leaderboard compares nothing (W6).** `gate-new` and `gate-regression` create a fresh Evaluation per
cycle, so `evaluation_object_ref` differs per version and the column stays empty; "cost" is not an Evaluation output.
*Change:* either cut it, or publish it once per run with a single column: `gate-legit` (`get_ref(evaluation).uri`,
`scorer_name="judge_scorer"`, `summary_metric_path="passed.true_fraction"`). Rows will be the `TargetAgent` model refs,
one per version. Nothing else is comparable.

**C4 — §4.5 prompt publishing in `save_config` breaks keyless tests (F15, W7).** `weave.publish` without a client
raises `WeaveInitError`; `save_config` runs in the API process (`/api/configs/{v}/review`) where nothing calls
`weave.init`. *Change:* publish from `chaos/loop.py` only (the process that already has a client), immediately after
`repair_agent` writes the version, guarded by `if weave.get_client()`. Store the ref on the cycle record, not in
`save_config`.

### High (wrong numbers or a real leak)

**H1 — §4.1 per-token vs per-million (W2).** `add_cost` takes USD **per token**; `chaos/config.py` prices are per
million. Divide by 1e6 or the Weave UI shows costs 1,000,000× too high. Also verify the `llm_id` (W3): dump
`summary.usage` keys from one real target call before wiring; if W&B Inference returns `model` as e.g.
`gpt-oss-120b` rather than `openai/gpt-oss-120b`, register both.

**H2 — §4.4 gateway leak surface (W8).** Weave redacts only `api_key`/`authorization`/`auth_headers`. A
`@weave.op` on anything taking `ToolSession`, `Request`, or `headers` records `backend_auth` (the
`ANTIBODY_BACKEND_AUTH` bearer), the `X-Antibody-Customer` id and any customer token verbatim. Exact guard:

```python
# chaos/gateway.py — only this function is an op; it takes primitives, never session/request objects
@weave.op(name="gateway.tool_call")
def _traced_tool_call(tool: str, args: dict, result: dict, ok: bool) -> dict: ...
```
and:
- call it only when `os.environ.get("ANTIBODY_GATEWAY_WEAVE") == "1"` **and** `weave.get_client() is not None`;
- `weave.init` for the gateway is opt-in and reads the project from `config.py`, never from a request;
- `args` and `result` pass through a local allowlist before entering the op (there is no `redact` helper in
  `chaos/tool_rules.py` — verified by grep — so write one small function next to the op, e.g. drop keys matching
  `token|auth|password|secret` and truncate string values to 500 chars);
- never set `attributes={"customer": …}` — customer ids are tenant identifiers; use the session's opaque
  `session_id` only.
Add a test that patches `_traced_tool_call` with a spy and asserts no header/auth value appears in its arguments.

**H3 — §2 inbox cost (see §8).** Today `Review.tsx readRuns` issues **3N + 1** requests per refresh (`runs` +
`cycles`/`approvals`/`configs` for each of N runs) inside `usePoll`; with the ~20 history runs on disk that is 61
requests every poll. A single `GET /api/review/inbox` is warranted (details in §8).

### Medium (works but adds a second way to do something)

**M1 — §1 Measure action as a new spawner.** `api/loop_ctl.py` is the single spawner and it only knows `run`.
Adding `chaos.loop vulnerability` there is fine **if** it reuses `start()`'s preflight/pid/`loop_state` path with a
`mode` field on `LoopStartBody` — not a second `subprocess.Popen` in `main.py` or `store.py`. See §6 for what the
command actually needs.

**M2 — §2 avatar orb in the tree.** The plan proposes an `agentId` prop on `TreeNode`. Fine; but `AgentTile` already
exists with six call sites (F10), so use size `20`, no new component.

**M3 — §3 timeline `icon` prop.** Adding `icon?: ReactNode` to `TimelineItem` is one line and replaces `monogram`;
delete `monogram` in the same change (F12: no tests to delete).

**M4 — §4.6 feedback from `/review`.** `add_reaction` needs a `Call` from `client.get_call` in the **API** process,
which is not Weave-initialised and must not be (F15). Either move it to `loop.py` when it reads the approval (adds a
cycle of latency) or cut it. Recommendation: cut; the audit trail is already `approvals.jsonl`.

### Low / nits

- `cost_usd`/`latency_ms` on cycles are per **cycle**, not per version (F8) — label accordingly.
- `weave.init` prompts on stdin without a key (F15). `loop.main()` inits unconditionally and relies on the dashboard
  preflight for the key; the gateway must gate its init on the env flag and the key, and `api/` must never init.
- `print_call_link` default True: pass `settings={"print_call_link": False}` in the gateway or logs get a URL per
  tool call.
- Plan §0 says "monogram() deleted with its tests"; there is no web test runner, so the verification step is
  `npm --prefix web run build && npm --prefix web run lint`.

## 3. Grades

### (1) Correctness — riskiest assumption per item

| Item | Works as written? | Riskiest assumption |
| --- | --- | --- |
| §1 matrix | No (C1) | that per-attack booleans are on the API today — they are only in `vulnerability_detail.json` |
| §1 Measure | Live run only | that `vulnerability_by_version` can target a history run — it reads the module-level `CONFIGS_DIR`/`RUNS_DIR` and `runs/regression.jsonl`, so only the live run is measurable without a refactor (see §6); progress is a boolean flag, not a counter |
| §2 inbox | Yes, expensively (H3) | that 3N+1 requests per poll is acceptable |
| §3 avatars | Yes | none of note; `AgentTile` at size 20 is the only asset needed |
| §4.1 cost | Yes after H1 | that `llm_id` on the response equals the request model string |
| §4.2 threads | Partly (C2) | that same `thread_id` ⇒ nesting — it only ⇒ same Thread |
| §4.3 leaderboard | No (C3) | that gate legs share an Evaluation object across versions |
| §4.4 gateway | Yes with H2 | that Weave's redaction covers `backend_auth` — it does not |
| §4.5 prompts | No where placed (C4) | that `save_config` runs with a Weave client |
| §4.6 feedback | No where placed (M4) | same |
| §4.7 `set_display_name` | Yes | `Call.set_display_name(name)` verified (`call.py:191`); harmless |

### (2) Concept count

Adds a second way for: spawning (if Measure gets its own `Popen` — M1), fetching review data (per-run fan-out vs one
inbox route — choose the route and delete `readRuns`), and a `TreeNode` avatar (use `AgentTile`). Adding `by_attack`
to `State.vulnerability` and `icon` to `TimelineItem` extend existing types — good. `weave.thread` and `add_cost`
are new *calls*, not new *concepts*. Net after fixes: zero new concepts; one deletion (`monogram`), one deletion
(`readRuns` fan-out).

### (3) Scope vs Tue Sep 29 midnight PT

Two working days. Judges weight resilience over polish. Everything under **Build** below is < 1 day total; the Weave
items that survive are the ones that are one guarded call each.

### (4) Security of §4.4 — see H2. Summary of what could leak and where

| Data | Path into Weave | Guard |
| --- | --- | --- |
| `ANTIBODY_BACKEND_AUTH` bearer | `ToolSession.backend_auth` captured as an op input / attribute | op takes primitives only |
| `ANTIBODY_GATEWAY_TOKEN` (customer's bearer to us) | request headers if `Request` or `headers` is an op arg | never pass request objects |
| `X-Antibody-Customer` value | `attributes`, `thread_id`, display name | use `session_id`; never the customer id |
| Customer tool args/results (PII) | op inputs/outputs | allowlist + truncation; opt-in env flag; default off |
| Hostname / env | `capture_system_info` (python + OS only, no hostname — verified) | acceptable |

### (5) Resilience — where a Weave exception would propagate today

Verified in `chaos/loop.py main()`: `weave.init(ENTITY_PROJECT)` at `:445` is **unconditional** for every command
(only `check` pre-empts it with a clean exit when `WANDB_API_KEY` is unset, `:437-440`). So the loop process already
requires a key, and without one `weave.init` prompts on stdin — under `loop_ctl.start()` (no tty) that is a hang or
an `EOFError` crash, not a graceful degrade. This is pre-existing and acceptable for the deadline (the dashboard's
preflight already checks the key), but it means: **every Weave call the plan adds to `loop.py` runs after a
successful init and can assume a client**; every Weave call added to `api/` or the gateway runs **without** one and
must be gated. `_measure_vulnerability` already wraps the measurement in `except (Exception, SystemExit)`
(`loop.py:571-575`). New propagation points:

| Planned call | Process | Guard |
| --- | --- | --- |
| `client.add_cost` (§4.1) | loop, after init | `try/except Exception: print(...)`, once per process — a pricing-table failure must not stop a run |
| `weave.thread` (§4.2) | loop + tool-server thread | context manager is safe without a client (verified); no guard needed |
| `weave.publish(Leaderboard)` (§4.3) | loop | try/except |
| `weave.init` in gateway (§4.4) | gateway | env flag **and** `WANDB_API_KEY` present; on failure log and continue **without** Weave |
| `weave.publish(StringPrompt)` (§4.5) | must be loop, not api (C4) | try/except |
| `client.get_call().feedback.add_*` (§4.6) | api → cut | — |

Keyless tests stay offline iff none of the above run in `api/` (they import `chaos.*` modules but never `loop.main`).
Add one test: import `api.main` and `chaos.gateway` with `WANDB_API_KEY` unset and assert
`weave.get_client() is None` afterwards.

### (6) Measure route — what `vulnerability_by_version` actually needs

Verified in `chaos/loop.py:607-660` and `api/loop_ctl.py`:

- Signature is `vulnerability_by_version(samples=VULNERABILITY_SAMPLES, versions=None)`. It reads the **live** run
  only: `CONFIGS_DIR.glob("v*.json")` and `load_regression()` (`runs/regression.jsonl`) are module-level paths in
  `chaos/state.py`, and it writes `RUNS_DIR/vulnerability*.json`. It **cannot** measure a history run
  (`runs/history/<id>/`) without threading a `paths` argument through it and `load_regression`. For the deadline:
  offer Measure on the **live run only**; grey it out for history sources.
- It needs the suite (`regression.jsonl` non-empty, else `SystemExit("nothing to measure")`), the saved configs,
  a target that can answer (`ANTIBODY_TARGET` + that target's key), the judge's key, and — because it goes through
  `loop.main()` — `WANDB_API_KEY` for the unconditional `weave.init`. Each sample is a real `weave.Evaluation`, so
  the cost is `versions × samples × suite_size` target+judge calls (3 versions × 3 samples × 8 attacks = 72 episodes).
- It must not run **concurrently** with a live cycle: both write `runs/vulnerability.json` and `loop_state.json`.
  `loop_ctl.is_running()` already answers this; refuse with 409 when a run is live.
- `set_phase(measuring=...)`: `set_phase` lives in `chaos/status.py:56` and writes `loop_state.json`, which
  `GET /api/loop` serves and `usePoll(api.loop)` polls. But `_measure_vulnerability` calls it **once** with
  `measuring="vulnerability"` (a string flag, `loop.py:570`) — there is **no per-version / per-sample progress**.
  The plan's "poll progress" is a flag ("measuring" vs not), which is enough for a spinner. If a progress bar is
  wanted, `vulnerability_by_version` must call `set_phase(..., measuring={"version": v, "sample": i, "total": n})`
  inside its loop — 3 lines, and `LoopState.phase.measuring` in `api.ts` becomes `string | {…}`.
- Therefore: add `mode: Literal["run", "vulnerability"] = "run"` to `LoopStartBody`, branch the argv in
  `loop_ctl.start()` to `python -m chaos.loop vulnerability`, reuse `preflight()` and `is_running()`, and let the UI
  poll `api.loop` for `phase.measuring`. The `vulnerability` CLI has no `--samples`/`--versions` flags today
  (`loop.py:447-449`), so the API cannot pass them without a parser change; measuring all versions is the default.

### (7) Exact vulnerability JSON shape (so the frontend does not guess)

Today, `GET /api/state[?source=run:<id>]` → `State.vulnerability`:

```json
{ "landed": { "v0": 8, "v4": 5 }, "suite_size": 8, "world": "mock" }
```
`landed` is `{version_id: count_of_attacks_that_landed}`; `world` is `"mock" | "zendesk" | null`; the whole field is
`null` when `vulnerability.json` is absent (CLI runs with `--no-vulnerability`, or crashed measurements).

Recommended extension (one optional key, read from `vulnerability_detail.json` in `store.read_vulnerability`):

```json
{
  "landed": { "v0": 8, "v4": 5 },
  "suite_size": 8,
  "world": "mock",
  "samples": 3,
  "by_attack": {
    "v0": { "seed-injection-refund": [true, true, true], "seed-pii-leak": [false, true, true] },
    "v4": { "seed-injection-refund": [false, false, false], "seed-pii-leak": [false, false, true] }
  }
}
```
A cell is "landed" when `>= ceil(samples/2)` samples are `true` (this is `rule` in the detail file — read it rather
than hard-coding). `by_attack` is absent for runs measured before the detail file existed. Mirror as
`by_attack?: Record<string, Record<string, boolean[]>>` and `samples?: number` on `State["vulnerability"]` in
`api.ts`; the matrix cell derive function goes in `lib/derive.ts`.

### (8) Review inbox cost → one endpoint

Per refresh, `Review.tsx readRuns` = `1 + 3N` requests (N = runs listed: live + archives; 20 on this machine → 61),
each hitting disk and JSON-parsing `cycles.jsonl` in full, every poll interval. Recommend **`GET /api/review/inbox`**
returning `[{run, version, agent_id, decided, decided_by, created_at, cycle_id}]` computed in `api/store.py` from
the same three files (one pass, server-side), consumed by a single `usePoll(api.reviewInbox)`. Reasons: (a) one
request instead of 61, (b) the derive moves to Python where it is unit-testable in the 480-test suite,
(c) `readRuns` and its Promise fan-out are deleted, (d) the Home "needs attention" count can read the same route
later. Keep the per-version editor fetch as is.

## 4. Exact Weave API the build should use (0.53.9, verified)

```python
import weave
from weave.trace.refs import get_ref  # for Evaluation refs

weave.init("<entity>/<project>", settings={"print_call_link": False})
client = weave.get_client()            # None when not initialised — gate every optional call on this

client.add_cost(llm_id="openai/gpt-oss-120b",
                prompt_token_cost=0.15 / 1e6, completion_token_cost=0.60 / 1e6)   # USD per token

with weave.thread(session_id):          # safe without a client; groups turns, does not nest processes
    ...

res, call = my_op.call(*args)           # call.id is None (NoOpCall) without a client
await call.apply_scorer(judge_scorer)   # scorer may be a @weave.op; arg names = call inputs + `output`
c = client.get_call(call_id, include_costs=True)
c.summary["weave"]["costs"][llm_id]["prompt_tokens_total_cost"]
c.feedback.add_reaction("👍"); c.feedback.add_note("approved by owen")
c.set_display_name("v4 · gate-legit")

ref = weave.publish(weave.StringPrompt(system_prompt), name=f"{agent_id}-system")   # ObjectRef; .uri
weave.publish(Leaderboard(name=..., description=..., columns=[
    LeaderboardColumn(evaluation_object_ref=get_ref(evaluation).uri,
                      scorer_name="judge_scorer", summary_metric_path="passed.true_fraction")]))
```

## 5. Cut list for Sep 29

**Build (in this order — each is one guarded change and directly visible to judges):**
1. §1 matrix with the `by_attack` extension (C1) and per-cycle cost label (F8).
2. §2 inbox via `GET /api/review/inbox` (H3) + `AgentTile` in the tree (M2).
3. §3 timeline `icon` + delete `monogram` (M3).
4. §1 Measure as a `mode` on the existing spawner (M1, §6).
5. §4.1 `add_cost` per-token (H1) and §4.7 display names — 20 lines, real Weave value.
6. §4.2 `weave.thread` with the corrected acceptance (C2).

**Defer (after the deadline):**
- §4.4 gateway Weave — highest security surface, no customer to exercise it, needs H2's tests.
- §4.3 Leaderboard — only `gate-legit` is comparable; low value until Evaluation objects are stable per run.
- §4.5 prompt publishing — fine later from `loop.py`; not in `save_config`.

**Cut:**
- §4.6 review feedback → Weave. It requires a Weave client in the API process, which is exactly the boundary that
  keeps 480 tests offline.

## 6. What was not checked

- Whether W&B Inference's response `model` string matches our request id (W3) — needs one live call with a key.
- Weave UI behaviour for Threads with turns from two processes — inferred from the server schema (`thread_id` column,
  `turn_id = call_id` when parent differs), not observed in the UI.
- Any of the above under a real `WANDB_API_KEY`; all package checks were offline introspection.
