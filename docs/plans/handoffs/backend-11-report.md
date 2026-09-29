# backend-11 — results, review and Weave (plan 11, lane A)

Lane: the ten backend items of `docs/plans/11-results-review-weave.md` (§7 overriding §1–§4) as scoped by
`review-plan-11.md`. Nothing committed; the working tree holds the change. **520 tests pass** in a clean environment
(`env -i PATH="$PATH" HOME="$HOME" uv run pytest -q`; the suite is keyless and offline), lints clean on every edited
file. `web/` untouched.

Two things a reader should know first:

- **Every Weave call fails soft**, and nothing in `api/` opens a client the keyless suite could hit. The API's only
  client is the existing warm-up in `api/attack.py`; the new decision feedback uses it when it exists and skips
  otherwise. The gateway traces only when opted in.
- **One live bug found and fixed during the end-to-end run** (item 6): the shared legit Evaluation was published under
  the Dataset's name, `legit-users`, and Weave refuses two object types under one name (400 on `obj/create`). The
  loop printed its fail-soft line and ran without a leaderboard. Renamed to `legit-users-evaluation`; the second
  end-to-end run published the leaderboard and every legit leg references it. The unit tests mocked `publish`, so
  only the live run could catch this — which is why the plan asked for one.

## What changed, per item

### 1. `GET /api/review/inbox` — `api/store.py`, `api/main.py`

`review_inbox(runs)` groups every run's saved versions per agent into `pending` and `decided`, in one read instead of
the Review page's 3N+1 polls. The route is two lines. Tests: `tests/test_review_inbox.py`. Live: the route answers on
the scratch API with the two agents on disk (`builtin`: 39 pending / 3 decided; `example-airline`: 1 / 1). Known
follow-up noted by the orchestrator, not done here: archived-run versions nobody decided on are counted as `pending`;
they should sit in their own bucket because only the live run is decidable.

### 2. `by_attack` on the vulnerability payload — `api/store.py`

`read_vulnerability` now returns `by_attack: {version: {scenario_id: [bool, …]}}` from `vulnerability_detail.json`
next to the per-version counts, plus `samples`. Optional: a run without the detail file keeps the counts. Live via
`GET /api/state`: `{'landed': {'v0': 2}, 'suite_size': 2, 'by_attack': {'v0': {'seed-injection-refund': [T,T,T], …}},
'samples': 3}`.

### 3. Measure through the one spawner — `api/loop_ctl.py`, `chaos/loop.py`, `api/main.py`

`LoopStartBody.mode: "run" | "vulnerability"`; the vulnerability mode spawns `chaos.loop vulnerability` through the
same `start()` preflight/pid/`loop_state` path, inherits target/world/domain from the live `run.json`, and leaves the
sidecar alone. The CLI subcommand wraps itself in `set_phase(cycle, "baseline", measuring="vulnerability")` /
`set_phase(cycle, "idle")`, and `_live_row` exposes `measuring` on the live run row. Live: `POST /api/loop/start
{"mode":"vulnerability"}` → row shows `measuring: true` for ~10 s → `vulnerability.json` rewritten → `idle`, exit 0.

### 4. Cost is Weave's — `chaos/loop.py`, `chaos/config.py`, `chaos/schemas.py`, `api/store.py`

`register_costs()` hands the price table to `client.add_cost` **per token** (the table is per million; divided by
1e6 — review H1). `run_cycle` runs inside a `run_cycle` op; after the cycle the loop flushes and reads the call back
with `include_costs=True`, sums every model's cost rows, and writes `cost_usd` with `cost_source: "weave"`; when Weave
cannot price it, the in-process estimate stays and the record says `"estimated"`. `run_manifest` labels the run the
same way (one estimate makes the sum an estimate; an unpriced cycle does not dilute it). Added
`Qwen/Qwen3-235B-A22B-Instruct-2507` to the table. Live model-string check (review H1/W3): W&B Inference returns
`response.model` equal to the requested id for `openai/gpt-oss-20b` and `meta-llama/Llama-3.1-8B-Instruct`, so one
registration per id suffices. End-to-end: all six cycles across both runs priced by Weave (`cost_source: weave`,
$0.003–0.009 each).

### 5. Threads — `chaos/target.py`, `chaos/target_agent.py`, `chaos/toolserver.py`

`run_episode` runs inside `weave.thread(session.session_id)`; the tool server enters the same thread for an external
agent's tool calls when it forwards `X-Antibody-Session` and this process has a client. Live: the last 400 calls held
28 threads; one thread = one episode's `openai.chat.completions.create` calls plus its `lookup_order` / `send_email`
/ `issue_refund` calls. `run_target_agent` itself sits outside the thread (the thread starts at the episode), which is
what the README now says.

### 6. One legit Evaluation, one leaderboard — `chaos/evals.py`, `chaos/loop.py`, `chaos/gate.py`, `chaos/state.py`

`legit_evaluation(dataset)` builds and publishes one `weave.Evaluation` per run; the baseline and every gate's legit
leg run *that object* (`run_evaluation` accepts an Evaluation), so `Leaderboard` (one column,
`judge_scorer` → `passed.true_fraction`) lines the versions up. `_publish_leaderboard` writes `weave_leaderboard_url`
into `run.json` via `amend_run_manifest`, and the manifest exposes it (https only). Live, after the rename fix: the
leaderboard object exists, and all four legit legs of the run (baseline v0 and three candidates) reference
`legit-users-evaluation:XioJC…` with four distinct `TargetAgent` versions — four rows. **Not checked:** the leaderboard
page rendered in a browser (needs a wandb login in the Cursor browser).

### 7. Gateway → Weave, opt-in — `chaos/gateway.py`

`ANTIBODY_GATEWAY_WEAVE=1` **and** `WANDB_API_KEY` → `init_weave()` at start (fails soft, prints one line either
way). Each forwarded call becomes a `gateway.tool_call` op inside the session's thread, then `ToolRuleScorer` — a
`weave.Scorer` holding the live version's `tool_rules` — re-runs `tool_rule_blocks` on the op's inputs and records
`{has_rule, blocks, reason, agrees}` as feedback. Deterministic; shadow mode scores without blocking.

The leak guard is the one the review asked for, and one step stricter:

- The only op takes primitives: `(tool, args, result, decision, elapsed_ms, turns, verified, ran)`. `trace_inputs`
  is the single path into it and reads nothing from a header: no customer id, no gateway token, no `backend_auth`.
  `turns`/`verified`/`ran` are the session *as the rule saw it before the call* (the call is already recorded when
  `after_call` runs), which is what lets the scorer re-run the exact check.
- `redact` drops keys matching `token|auth|password|passwd|secret|bearer|cookie|credential|api[_-]?key` at every depth
  and cuts strings at 500 characters, for `args`, `result` and `turns`.
- `test_gateway_trace_never_carries_secrets` runs a real request through the gateway with a fake gateway bearer, a fake
  backend bearer, a customer header and a credential-looking tool argument, spies the op, and asserts none of them
  appear in the captured inputs, that the real tool still received the real arguments, that the op ran inside the
  session's thread, and that the op's parameter set is exactly the eight above (widening it means editing the test
  on purpose).
- No `attributes={"customer": …}`; the thread id is the opaque session id.

Live (key sourced in a subshell): two calls traced with `thread='live-conv-1'`, `leaks=[]` against four planted
secrets, and `ToolRuleScorer` feedback on each. One finding from that run: `apply_scorer` is a coroutine, and a task
parked on the request's event loop was **cancelled** when that loop stopped (seen with the test client's per-request
loops: first score lost, second kept). The score now runs to completion on a single-worker scoring thread, never on
the request loop; re-checked live under the same harsh harness: both scores attached.

### 8. Prompts as objects — `chaos/evals.py`, `chaos/loop.py`

`publish_prompt(name, text)` publishes a `weave.StringPrompt` (Weave versions it by content — verified live: same text
twice → one version, changed text → a new one). The loop publishes `judge-system` once at start and `system-prompt`
for v0 at start and for every candidate right before its gate builds a Model. `TargetAgent.system_prompt_ref` is
filled from a process-local text→ref map, so every Model version in Weave points at the prompt it was evaluated with
without any call site changing. On read-back Weave dereferences the field into the prompt object itself, which is the
link the UI wants. `save_config` stays Weave-free. Live after two runs: `system-prompt` 2 versions, `judge-system` 1.

### 9. Decisions as feedback — `chaos/evals.py`, `chaos/gate.py`, `chaos/schemas.py`, `api/store.py`, `api/attack.py`, `api/main.py`

`EvalRun.call_id`; `GateResult.weave_eval_call_ids` (gate-new samples first, same order as the URLs; old records load
with `[]`). `store.eval_call_id(source, version)` finds the cycle whose gate promoted the config to `version` and
returns its first gate-new call id (None for v0, for a rejected candidate, or when the run had no client).
`attack.record_decision(call_id, status, note)` adds 👍/👎 (`approved`/`rejected`) and the note to that call; it runs
only when the API's warm-up already succeeded (`_weave_ready`), never opens a client itself, and logs a miss.
`review_config` calls `record_decision_later` (a daemon thread) after `state.review` — the decision is saved and the
route answers before Weave is consulted. Both branches tested; live: 👍 + note landed on the real gate-new call of the
first run's accepted v1, a bogus call id logs and returns False.

Also added `reason` and `method` to `judge_scorer`'s output (they were already on the Verdict) so the judge monitor
below has something to judge. Strings are excluded from Weave's summary, so the leaderboard's `passed.true_fraction` is
unchanged — confirmed by the leaderboard test and the live run.

### 10. Docs — `README.md`, `docs/SMOKE.md`

README: a "How Antibody uses Weave" section (the seven items in plain language, what is opt-in, what fails soft) and a
corrected caveat about external agents' tool calls (root traces, but in the episode's thread). SMOKE: step 11 (what
Weave should show after a Heal, including the decision feedback), step 12 (gateway tracing off by default, secrets
absent from traces — critical), and the one-time judge-monitor recipe with the exact dialog fields as documented by
W&B in September 2026 (`docs.wandb.ai/weave/guides/evaluation/custom-monitors`), a scoring prompt, and the two things
to check the first time — notably that the monitor's `{output}` is the op's return value, since `judge_scorer` also
names an *input* `output`.

## The end-to-end runs

Two short real runs, mock world, built-in target, key sourced in a subshell (`--seeds 1 --chaos-cycles 1
--repair-attempts 1 --no-second-pass`, the first with `--vulnerability`), exit 0 both:

| | Run 1 (before the rename fix) | Run 2 |
| --- | --- | --- |
| Cycles / accepted | 3 / 1 (v1) | 3 / 0 |
| `cost_source` | weave, weave, weave | weave, weave, weave |
| `weave_eval_call_ids` per gated cycle | 3, 4, 4 | 3, 4, 4 |
| Leaderboard | *not published* — the 400 above | published; 4 legit legs reference it |
| `runs/vulnerability.json` | `{"v0": 2, "v1": 1}` | via API measure: `{"v0": 2}` |

The API paths were exercised on a scratch instance (`:8010`, stopped afterwards), not on the `:8000` API that was
already running when the lane started — that process predates these changes and needs a restart to serve the new
routes and the decision feedback. Two spike objects remain in the Weave project (`antibody-retail-legit-spike`,
`target-agent-spike`); harmless, delete at will.

## Not done / not verified

- The leaderboard and thread views were verified through the API (object refs, call `thread_id`s), not by looking at
  the Weave UI.
- The judge monitor is a UI recipe; it has not been created. Whether `{output}` resolves to the op's return value or
  its like-named input in the monitor's template is flagged in SMOKE as the first thing to check.
- `review_inbox` counts archived undecided versions as pending (see item 1).
- Tests pass on macOS; nothing here is platform-specific, but the Linux container path was not run.
- The gateway's `ToolRuleScorer` publishes the version's `tool_rules` as part of the scorer object. Rules are policy,
  not secrets, and the config is already a published Model — but it is one more thing that leaves the box when the
  flag is on, and the README says so.
