# Handoff — Backend lane 7: gateway as production infrastructure, `FinTarget`, the airline example agent (plan 10, C2 + A7 + A3 no-key branch)

Repo `/Users/owentsao/Coreweave Hacks`, branch `feature/production-fit` (checked out; uncommitted work — **never
commit, stash, reset or checkout**). Read `docs/plans/handoffs/backend-6-report.md` **first** (lane 6 shipped the
`Domain`/`Scenario`/`CallSpec` shapes you build on and may have corrected facts below), then
`docs/plans/10-production-fit.md` §4 Track A/C, §5 blockers 1–2, 4, 8–9, §5b loop 3 (the gateway contract — your
spec), and `.cursor/rules/code-organization.mdc`. Tests keyless: `env -u WANDB_API_KEY uv run pytest -q`. No new
dependency in the main project. The example agent lives in its own `uv` project under `examples/` and may use
`openai-agents`, `fastapi`, `httpx`, `uvicorn` (already used by the existing example) — **not** `openai-chatkit`.

## Facts (re-verify)

- Gateway: `chaos/gateway.py` — argparse `:186-200` (`--backend --port --version --enforce`), `build_app` from
  `toolserver.py:81-109`, sessions created on first sight and idle-dropped after 3600 s (`:44, 144-156`),
  `X-Antibody-Customer` header logged (`:43, 128-139`), `history/gateway.jsonl` rows with `decision:
  blocked|would_block|allowed` (`:88-100`), `GET /health` (`:124-126`), `POST /sessions/{id}/turn`.
  `GET /api/gateway` (api/main.py) reads the log for the dashboard.
- Pass-through now forwards `X-Antibody-Session` (lane 6, blocker 1). `PASSTHROUGH_TIMEOUT_S = 30.0`
  (`toolbus.py:165`). `tool_rule_blocks` is pure Python (`chaos/tools.py:212-242`).
- API auth: `api/auth.py` bearer middleware, `ANTIBODY_API_TOKEN`; `/api/health` open.
- `Target` classes: `chaos/target.py` — `BuiltinTarget`, `HttpTarget` (`:59-98`), selection by `ANTIBODY_TARGET`
  (`:149-159`: `builtin` | `http:<url>` | bare URL). `HttpTarget.run_episode` posts once and reads `{reply}`.
- Existing example: `examples/agents/openai_agents_support/` — own `pyproject.toml`, `agent.py` uses
  `OpenAIChatCompletionsModel` + W&B Inference `openai/gpt-oss-20b` (`:26-30, 105-117`), registers tools as HTTP
  proxies to Antibody's tool server with the session header (`:58-67, 70-97`), `GET /tools`, `POST /episode`
  (`:128-145`). `api/example_agent.py` spawns it for the connect screen.
- The OpenAI cs-agents demo (MIT, `openai/openai-cs-agents-demo`, `python-backend/airline/`): agents triage /
  flight status / booking & cancellation / seat & special services / FAQ / refunds & compensation; tools
  `lookup_reservation`… `cancel_flight(context)` (no args, reads context state), `update_seat`, `issue_compensation
  (reason)` (vouchers, no amount), progress streamed via `context.context.stream(...)`; `MODEL = "gpt-5.2"`;
  relevance + jailbreak guardrails on every agent. Fetch the current files from GitHub raw before adapting.
- Intercom Fin Agent API (verified Sep 22): `POST https://api.intercom.io/fin/start` `{conversation_id, message:
  {author: "user", body}, user: {id, name, email}, conversation_metadata?: {history: [...]}, settings?:
  {follow_up_questions}}` → `{conversation_id, status}`; `POST /fin/reply` same body; statuses `thinking → replying
  → awaiting_user_reply | escalated | resolved → complete`; events `fin_replied` by webhook or SSE
  (`sse_subscription_url` in the response, 3-minute JWT). Header `Intercom-Version: 2.16`, bearer token with
  `write_conversations`. Access is by request form — you will have **no workspace**; build against a fake.

## Build, in this order

### C2 — the gateway contract (plan §5b loop 3)

1. **Auth.** `ANTIBODY_GATEWAY_TOKEN`: when set, every gateway route except `/health` requires
   `Authorization: Bearer`; reuse `api/auth.py`'s check (extend it to be importable, don't copy). Forward to the
   backend: `X-Antibody-Session`, and `Authorization` from `ANTIBODY_BACKEND_AUTH` (a header value the customer
   configures) — never the inbound token.
2. **Failure semantics per class.** In pass-through, when the rule check raises or the backend is unreachable/times
   out: class `money`/`mutate` (from `chaos.tool_rules.classify`, overridable per tool in the approved config via
   `ToolRule.on_failure: "closed" | "open" | None`) → `{"error": "gateway: refused — <reason>"}`,
   `blocked_by="failure:<reason>"`; class `read`/`message` → forward result if any, else `{"error": ...}` with
   `degraded=True` recorded. Add `ToolRule.on_failure` to the schema **and** to `merge_tool_rules` (field-by-field)
   and to `rule_detail`.
3. **Budgets and timing.** Per-tool timeout: `ToolRule.timeout_s: float | None` (default the constant). Record
   `elapsed_ms` (rule check + backend) on every gateway log row and on `ToolCall`. Assert in a test that the rule
   check alone for 1,000 calls stays under 1 s.
4. **Policy version live.** `GET /health` → `{ok, version, approved_at, rules}`; the gateway re-reads the approved
   config every 60 s and on `SIGHUP` (thread + signal handler; test the reload function directly).
5. **Replay endpoint** (frontend contract): `GET /api/gateway/replay?version=<n|approved>&source=live` → `{version,
   calls, would_block, by_tool: {name: {calls, would_block}}, samples: [{tool, args, reason, at}]}` (≤ 20 samples):
   re-run version N's `tool_rules` over `history/gateway.jsonl` rows (per-session state rebuilt from the log's
   session ids in order). Behaviour lives in a module (`api/gateway_replay.py` or inside the gateway module) —
   the route is thin.
6. `command_line()` and Settings → Environment string include `--shadow` explicitly; docs say "shadow for a week,
   read the replay panel, then `--enforce`".

### A7 — `FinTarget`

`chaos/target.py`: `FinTarget(Target)` selected by `ANTIBODY_TARGET=fin:<workspace-or-label>` with
`INTERCOM_FIN_TOKEN`. `run_episode`: `POST /fin/start` with the customer's message and `user` from the scenario,
then poll (`GET`? — the API has no poll; use the SSE URL from the response if present, else webhook is impossible
here, so poll `/fin/reply`'s status by re-sending? **No** — verify the docs for a status endpoint; if none exists,
subscribe to `sse_subscription_url` with a plain `httpx` stream and read `fin_replied`/`fin_status_updated` until
`awaiting_user_reply|complete|escalated`, with a 120 s cap). The reply body is HTML → strip tags. Tools are not
observable for Fin (its Data connectors call the customer's API directly), so `supported_patch_kinds` is
`{tighten_tool_policy}` and the gateway is the only enforcement point — document this in the class docstring.
Tests: a `FakeFin` in `tests/conftest.py` serving `/fin/start`, `/fin/reply` and an SSE endpoint; test the happy
path, an `escalated` end, and the timeout.

### A3 (no-key branch) — `examples/agents/openai_cs_airline/`

Own `uv` project mirroring the existing example's layout. Adapt the demo's `airline/agents.py` and `tools.py`
(MIT — add `LICENSE-openai-cs-agents-demo` and an attribution line in the README): keep the six agents, handoffs,
and both guardrails; **replace** `context.context.stream(ProgressUpdateEvent(...))` with no-ops; model from env
`AGENT_MODEL` (default W&B `openai/gpt-oss-120b` through `OpenAIChatCompletionsModel` exactly as the existing
example does; `OPENAI_API_KEY` + `AGENT_MODEL=gpt-5.2`-style switches to the stock client — one variable, both
branches). Serve:
- `POST /episode` — runs the triage agent with a fresh `AirlineAgentContext` per `session_id`; catches
  `InputGuardrailTripwireTriggered` (→ `{"reply": "<the guardrail's refusal message>"}`) and `MaxTurnsExceeded`.
  Registers every tool as an HTTP proxy to `tools_url/tools/{name}` with `X-Antibody-Session`, like the existing
  example.
- `GET /tools` — the tool list with descriptions.
- `POST /tools/{name}` + `GET /tools` on a **second port** (`TOOLS_PORT`, default 8791): the real tool functions
  invoked with a fake `RunContextWrapper` whose `.context` is the per-session `AirlineAgentContext` (keyed by the
  forwarded `X-Antibody-Session`). This is the `tools_backend`.
`api/example_agent.py` learns a second example (`airline`) for the connect screen (`POST /api/agents/example/start
{"name": "airline"}`), and the agent row it creates sets `tools_backend` to the second port and `domain` to
`airline`. Tests for the example use its own tiny pytest with a fake model (no inference).

**Manual check you run (needs the key in `.env`; record the result and date in the report, never the key):** start
the airline example, set `ANTIBODY_DOMAIN=airline`, run `uv run python -m chaos.loop run --chaos-cycles 2
--repair-attempts 1` with `ANTIBODY_TARGET=http://127.0.0.1:8790` and `ANTIBODY_TOOLS_BACKEND=http://127.0.0.1:8791`.
Definition of done for the plan: at least one cycle judged, one `tool_rules` patch proposed, and — after approving
it — the gateway in shadow mode logging `would_block` for the same call. If inference fails (W&B model refuses the
SDK tool round-trip — the existing example needed `gpt-oss-20b`), try `gpt-oss-20b`, and if it still fails record
exactly what failed; do not fake the result.

## Do not

Do not weaken fail-closed defaults; do not run validators in the gateway; do not add `openai-chatkit`, `mcp`, or
any dependency to the main project; do not touch `web/`; do not commit.

## Deliver

`docs/plans/handoffs/backend-7-report.md`: files shipped, decisions with evidence, test counts, the manual loop
result (or exact failure), what is not tested. Then stop.
