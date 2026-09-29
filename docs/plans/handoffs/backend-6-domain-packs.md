# Handoff — Backend lane 6: domain packs, honest judging, first-week fixes (plan 10, A1 + A2 + C1 + review blockers 1–2)

Repo `/Users/owentsao/Coreweave Hacks`, branch `feature/production-fit` (already checked out; working tree holds
uncommitted roadmap-v1 work — **do not commit, stash, reset or checkout anything**). Read
`docs/plans/10-production-fit.md` in full first — §1 (what is true), §4 (tracks), §5 (review blockers), §5b
(build scope). House rules: `.cursor/rules/code-organization.mdc` — fewer concepts, extend types don't fork,
routes thin, delete what you replace, no new dependency. Tests run keyless: `env -u WANDB_API_KEY uv run pytest -q`
→ 390 pass now. Never print `.env` values.

A second backend lane (handoff 7: gateway contract, `FinTarget`, airline example agent) starts **after you finish**
and depends on your `Domain` and `Scenario` shapes. A frontend lane runs in parallel and consumes the API contracts
in §Contracts below — implement them exactly.

## Facts (verified Sep 21–22; re-verify before relying on each)

- External contract: `POST {url}/episode` `{session_id, message, customer_id, customer_email, tools_url}` →
  `{reply}` (`chaos/target.py:59-98`). Repair for `HttpTarget` is limited to `CODE_LEVEL_PATCH_KINDS =
  {tighten_tool_policy, add_tool_validator}` (`target.py:28-31, 68`).
- Pass-through: `_call_passthrough` (`chaos/toolbus.py:135-162`) runs only `tool_rule_blocks` + scenario fault +
  `post_json(f"{backend}/tools/{name}", args, 30 s)`; **no session header is sent** (`:156`; `post_json` in
  `target.py:127` sets only Content-Type). Validators never run here.
- Repair prompt menu (`chaos/repair_agent.py:56-69`) lists the seven flags and validators; **`tool_rules` is never
  mentioned to the model**; `_canned("tighten_tool_policy")` sets flags (`:475-477`); `suggest_patch_kind` and
  `_acted_without_verified_lookup` key on `issue_refund`/`send_email`/`lookup_order` by name (`:239-241, 392-402`).
  `merge_tool_rules` constructs `ToolRule` field-by-field (`:531-543`) — a new field must be added there or it drops.
- Northwind coupling (the full list — the plan's original five-file claim was wrong): `chaos/tools.py:20-24`
  (`ORDERS`), `:43-62` (tools), `:69-103` (Zendesk tools), `:212-242` (`tool_rule_blocks`), `:267-329`
  (`policy_blocks`, reads ORDERS); `chaos/schemas.py:50-56` (seven flags), `:105` (`customer_id="cust_owen"`),
  `:110-113` (`Scenario.forbidden_tool_calls` — **never read by the judge**); `chaos/judge.py:17` (imports ORDERS),
  `:59-183` deterministic checks by tool name; `chaos/chaos_agent.py:45-58` prompt, `:100-125` default faults on
  `lookup_order`, `:301` customer pinned, `:346` `orders_in_system`; `chaos/scenarios.py:27-65` families, `:73-111`
  seeds, `:172-261` legit rows, `:270-295` `LEGIT_EXPECTED_TOOLS/_ORDERS`; `chaos/target_agent.py:25-33` v0 prompt,
  `:54-57` `_TOOL_JSON_RE` compiled from `TOOL_FUNCS` at import, `:73`, `:229`; `chaos/zendesk.py:161-163`;
  `chaos/toolserver.py:112, 179-192`; `chaos/toolbus.py:18, 95, 118, 128, 173`; `api/agents.py:43-51, 71, 289-295`;
  `api/manifest.py:31-34`; `api/main.py:632`; `api/incidents.py:24`; `tests/test_scenarios.py` (61 hits, enforces
  `LEGIT_EXPECTED_TOOLS` coverage).
- `ORDERS` is never mutated (refund/email append to ledgers, `tools.py:49-59`) — that is why 3 concurrent gate
  episodes (`toolserver.py:26`) are safe today.
- Gate: `chaos/gate.py:9-15` (`GATE_FIX_SAMPLES`, protected rows one retry), `:96` ignores legit rows that already
  failed at baseline. `_note_verified` needs a dict result and an `*_id` arg (`toolbus.py:185-188`).
  `starter_rule` sets `requires_verified_lookup=True` for money/message/mutate/unknown (`chaos/tool_rules.py:62-68`).
- Judge: LLM fallback `judge.py:193-230` with `JUDGE_SYSTEM` `:19-39`; payload `:199-209` includes raw tool results.
- Retail v0 prompt must stay byte-identical (`tests/test_target.py:212`); seed ids (`seed-injection-refund`…) and
  `data/golden/cycles.jsonl` must keep parsing (new schema fields need defaults).
- No `random.seed`/`Random(` anywhere in `chaos/`. No token/cost/latency fields in `schemas.py`. Weave traces exist
  per model call (`chaos/config.py`, `weave.op` usage — find it).
- Tests: `tests/conftest.py` `FakeAgent` (`:103-106` hard-codes `lookup_order`/`A-1001`), `FakeToolBackend`
  (`tests/test_passthrough.py` imports it), `tests/test_toolserver.py:174-200` runs `run_target_agent` in-process
  against an HTTP target, `tests/test_gateway.py:29, 97` builds a `Gateway` from a config.

## Build, in this order (all tests green after each step; add tests for each)

### Step 0 — C1: smoke checklist + in-process end-to-end test (½ day)

- `docs/SMOKE.md`: a 10-minute manual checklist Owen runs at the end of a build session (start API + web, connect
  example agent, Heal 2 cycles, approve, schedule, gateway shadow log, Settings token). Each step names the failure it
  catches. Adversarial: one invalid input, one empty state, one "neighbour still works".
- `tests/test_e2e_passthrough.py`: `run_target_agent` in-process with `ANTIBODY_TARGET=http:<FakeAgent>` and
  `ANTIBODY_TOOLS_BACKEND=<FakeToolBackend>` → a deterministic judge failure → `apply_patch` with a `tool_rules`
  patch → `state.save_config` → `POST /api/configs/{v}/review` approved → `Gateway(load_policy_config("approved"))`
  blocks the same call. No model calls (deterministic path only; monkeypatch anything that would call inference).

### Step 1 — Review blockers 1–2 (small; needed regardless)

1. `_call_passthrough` and the gateway forward `X-Antibody-Session: <session id>` to the backend. `post_json` gains
   an optional `headers` argument (extend, don't fork). Test in `test_passthrough.py` asserts the header arrives.
2. Repair learns `tool_rules`: the model-facing menu (`repair_agent.py:56-69`) gains item 3 — per-tool rules with
   the fields of `ToolRule`, and the payload lists **the target's tool names** (from the session/`GET /tools`) so the
   model can name them. `_canned("tighten_tool_policy")` for an HTTP target with `tools_backend` emits a `tool_rules`
   entry for the offending tool (deny or requires_user_intent by class) rather than the seven flags.
   `suggest_patch_kind`/`_acted_without_verified_lookup` use `chaos.tool_rules.classify` (money/message/mutate/read)
   instead of hard-coded names. When `tools_backend` is set, `add_tool_validator` is **not** offered
   (`CODE_LEVEL_PATCH_KINDS` minus it, decided per session, not per class).
3. `starter_rule` sets `requires_verified_lookup` only when the tool list contains at least one read-class tool
   (the rule is unsatisfiable otherwise — `_note_verified` needs a dict-returning read). Document in the docstring.

### Step 2 — A1: domain packs

Shape (decided): `chaos/domains/<name>/` with `tools.py` (tool functions + validators + the pack's `policy_blocks`
equivalent, if any), `db.json` (seed records), `policy.md` (the policy text the built-in target's prompt embeds),
`tasks.json` (legit rows: `{id, customer_id, customer_email, message, expected_calls, forbidden_calls}`),
`attacks.json` (attack families: `{name, faults, forbidden_calls_by_class, expected_behavior}`).
`chaos/domains/__init__.py` exposes `load_domain(name) -> Domain` (a Pydantic model in `chaos/schemas.py`:
`name, tools: dict[str, ToolSpec], db, policy_text, legit: list[Scenario], families: list[AttackFamily]`) and
`Domain.fresh_db()` returning a **per-session copy** of `db` (airline tools mutate state; retail today does not, but
the copy is the rule for every pack).

- Move Northwind into `chaos/domains/retail/`: `ORDERS` → `db.json`; `lookup_order/issue_refund/send_email` and
  Zendesk tools → `tools.py`; the v0 prompt text → `policy.md` **byte-identical** (`test_target.py:212`); seeds and
  legit rows → `tasks.json`/`attacks.json` keeping ids. `chaos/tools.py` keeps `tool_rule_blocks` (world-agnostic)
  and re-exports what tests import from the retail pack so existing imports keep working — then fix the imports and
  delete the re-exports (delete what you replace; grep tests).
- `ToolSession` gains `domain: Domain` and `db` (the fresh copy). `call_tool` dispatches to `session.domain.tools`,
  not a module-level `TOOL_FUNCS`. `_TOOL_JSON_RE` is built per session. `_is_read_tool` non-passthrough uses the
  pack's tool class (from `tool_rules.classify`), not `name == "lookup_order"`.
- The seven `ToolPolicy` flags **stay on the schema** (decision Q18), each with a docstring line "retail-only";
  `policy_blocks` moves into the retail pack and is called only when `session.domain.name == "retail"`. The repair
  prompt's flag list is generated from the active pack (empty for airline).
- Chaos agent: prompt and payload built from `session.domain` — tool specs, a sample of `db`, `policy_text`; the
  customer id/email come from the pack's `tasks.json`. No Northwind words in `chaos_agent.py` after this
  (`rg -i 'northwind|A-1001|cust_owen|lookup_order' chaos/chaos_agent.py chaos/judge.py` → empty).
- Judge: deterministic checks become class-based and pack-fed — data leak = a read returned a record whose owner ≠
  scenario customer (owner field named in `ToolSpec.owner_key`); unauthorized = a money/mutate call whose target id
  is not the customer's or was never asked for (`requires_user_intent` words from the pack); over-refusal / wrong
  action = `expected_calls` not made / made against the wrong id. **Delete** `LEGIT_EXPECTED_TOOLS/_ORDERS` and
  `Scenario.forbidden_tool_calls`; replace with `Scenario.expected_calls: list[CallSpec]` and
  `forbidden_calls: list[CallSpec]` where `CallSpec = {tool, args: dict (subset; `...` = any)}` matched on the
  declared subset with `_coerce_amount` and `.strip()` normalisers. `test_scenarios.py`'s coverage check moves to the
  pack loader (every legit task has at least one expected call).
- State check (pack mode only): `Domain.end_state(db)` → canonical JSON; a scenario may carry `expected_state`
  (derived by replaying `expected_calls` on a fresh db at load time, τ²-bench style); judge compares end state when
  present, else calls. `Episode.domain: str | None` tells the judge which mode it is in (`None`/pass-through → calls
  and transcript only).
- **Judge sees typed facts, never raw tool output** (AgentDojo's injection-of-the-judge point): the LLM payload
  replaces `result` with `{kind: "record"|"error"|"empty"|"text", ids: [...], owner: ...}` computed in code.
- Zendesk ticket mode reads the requester email from the pack (`zendesk.py:161-163`) — retail-only, guarded.
- `ANTIBODY_DOMAIN` env (default `retail`) selects the pack in the loop; `loop_ctl` passes it; the agent row gains
  optional `domain`. `run.json` records it; `api/manifest.py` exposes it.

### Step 3 — A2: airline pack + five families + pass^k + seeded determinism + cost

- `chaos/domains/airline/`: tools modelled on the OpenAI cs-agents demo's airline tools (names/signatures:
  `lookup_reservation`, `get_flight_status`, `cancel_flight`, `book_new_flight`, `update_seat`,
  `issue_compensation`, `send_confirmation`) but **our own** data and behaviour; `db.json` with ~6 customers, ~10
  reservations, ~8 flights; `policy.md` written by you (cancellation window, compensation caps, identity check
  before any change). Ten legit tasks with `expected_calls`.
- Five families in class terms in `attacks.json`, each with a fault (`inject`, `null|malformed|timeout|wrong_record`
  on a read tool) or none, and `forbidden_calls_by_class`: injection via read output → money/message;
  garbage/timeout → any mutate on no data; social engineering for another customer's record → leak or unauthorized
  mutate; ambiguous request → over-refusal or wrong record; **exfiltration** → a message-class call whose
  destination is not the customer's own contact and whose body contains an id the read returned. Budget abuse is
  **not** built (needs `max_total`; see plan §5 should-fixes).
- Retail's four families are re-expressed in the same class terms in `retail/attacks.json`; behaviour of the golden
  replay must not change (run the replay tests).
- **pass^k**: `GateResult` gains `pass_k: {k: int, passed: int}` (defaults so golden parses); the run summary
  endpoint exposes per-version `pass_k`. k = `GATE_FIX_SAMPLES`.
- **Seeded determinism**: one `random.Random(seed)` per run, seed in `run.json` (`ANTIBODY_SEED`, default from
  time), passed to anything that samples (chaos prompt variety, fault choice, db sampling). Model temperature stays.
- **Cost/latency per cycle**: `CycleRecord` gains optional `latency_ms: int | None` and
  `tokens: {input: int, output: int} | None` and `cost_usd: float | None` (from Weave call summaries if available,
  else from the response `usage`; price table in `chaos/config.py`, per model, with a comment that it is an estimate).
  `GET /api/runs/{id}` and cycle rows carry them.

## Contracts the frontend consumes (implement exactly; keep `api.ts` types in sync — the frontend lane edits
`api.ts`, you do not)

- `CycleRecord`: `+ latency_ms?: number | null`, `+ tokens?: {input: number; output: number} | null`,
  `+ cost_usd?: number | null`.
- `GateResult`: `+ pass_k?: {k: number; passed: number}`.
- Run manifest (`GET /api/runs`, `GET /api/runs/{id}`): `+ domain: string`, `+ seed: number | null`,
  `+ target: "builtin" | "http"`.
- `GET /api/domains` → `[{name, tools: [{name, class}], families: [name], legit: number}]`.
- Scenario rows (`/api/regression`) expose `expected_calls`/`forbidden_calls` in place of `forbidden_tool_calls`.

## Do not

- Do not add dependencies. Do not touch `web/`. Do not commit. Do not change the gate's `fix_samples` or the
  fail-closed behaviours listed in plan §5 "Keep as-is". Do not run inference in tests.
- Do not "improve" `merge_tool_rules` into reflection; extend it field-by-field.

## Deliver

`docs/plans/handoffs/backend-6-report.md`: what shipped (file list), decisions taken where this handoff was wrong or
silent (with file:line evidence), test count before/after, what is **not** tested (anything needing a key), and the
exact `Domain`/`Scenario`/`CallSpec` shapes lane 7 will import. Then stop.
