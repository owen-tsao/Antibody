# Example: OpenAI's airline customer-service demo under Antibody

This is the agent Antibody attacks when the domain is `airline`: the six-agent airline flow from OpenAI's
[openai-cs-agents-demo](https://github.com/openai/openai-cs-agents-demo) (triage, flight information, booking and
cancellation, seats and special services, refunds and compensation, FAQ), with its handoffs and both input guardrails
(relevance and jailbreak). The agents and tools are the demo's own code, MIT-licensed — the licence is in
`LICENSE-openai-cs-agents-demo` and `airline/__init__.py` lists exactly what was changed. It lives in its own project with
its own lockfile and **imports nothing from Antibody** (`rg -t py "^(from|import) chaos" .` finds nothing).

What was taken out: ChatKit. The demo's UI streamed progress events from inside its tools and wrapped the context in a
ChatKit `AgentContext`; here the streams are no-ops and the tools read the context directly. What was added: the two
routes Antibody talks to, and a second server so Antibody can stand between the agents and their tools.

## How it fits Antibody's contract

- **`POST /episode`** (agent port, default 8792) runs the triage agent on one customer message with a fresh context for
  that `session_id`. A tripped guardrail becomes the reply the customer would have heard (`Sorry, I can only answer
  questions related to airline travel.` / `Sorry, I can't help with that request.`); running out of turns replies
  `(agent hit max turns without replying)`, the words Antibody's built-in agent uses, so the judge scores what the
  agent did rather than a crashed request.
- **The tools are proxies.** Every tool an agent holds keeps the original's name, description and JSON schema, but its
  body is `POST {tools_url}/tools/{name}` with `X-Antibody-Session: <session_id>`. That header is the whole integration.
- **The real tools run on a second port** (`TOOLS_PORT`, default 8793): `GET /tools` and `POST /tools/{name}`, each call
  applied to the context of the session named in the forwarded `X-Antibody-Session` header. In Antibody this is the
  agent's *tools backend*: the loop receives the proxied call, injects the fault or enforces the approved policy, then
  forwards it here. A handoff callback that hydrates the itinerary and the real `cancel_flight` that reads it share one
  object per session, as they did in the demo.
- **`GET /tools`** on the agent port lists the ten tools the agents hold (the demo's `baggage_tool` exists but no agent
  holds it), answered without a model call so it doubles as the readiness probe.

## Run it

The dashboard can do this for you: on the connect screen, start the airline example (`POST /api/agents/example/start`
with `{"name": "airline"}`; log in `runs/example_agent-airline.log`). By hand, from this folder:

```bash
uv sync
set -a; source ../../../.env; set +a      # WANDB_API_KEY, never committed
uv run python agent.py                    # agent on AGENT_PORT (8792), tools on TOOLS_PORT (8793)
```

Then from the repo root, with the airline pack:

```bash
ANTIBODY_DOMAIN=airline ANTIBODY_TARGET=http://127.0.0.1:8792 ANTIBODY_TOOLS_BACKEND=http://127.0.0.1:8793 \
  uv run python -m chaos.loop run --chaos-cycles 2 --repair-attempts 1
```

The ports are one pair above the other example's (8790) so both examples can be up at once and each dashboard row's
`running` means its own process.

## The model

`AGENT_MODEL` names an OpenAI-compatible chat model; where it runs follows the key present. With `WANDB_API_KEY` the
agents run on W&B Inference, default **`Qwen/Qwen3-235B-A22B-Instruct-2507`**; with `OPENAI_API_KEY` and no W&B key
they run on OpenAI directly, default `gpt-5.2` (the demo's own choice). The guardrails use the same model as the
agents — the demo used a separate small model, which W&B Inference does not serve.

Why Qwen and not gpt-oss: the plan named `openai/gpt-oss-120b`, and it does answer — but through the Agents SDK it
*narrates* the handoff ("I'm transferring you to our Flight Information specialist…") instead of calling the
`transfer_to_*` tool, so no specialist ever runs and no tool is ever called. In a 12-episode Antibody run on Sep 22
2026 every episode ended with zero tool calls and took 75–170 s. Qwen3-235B completes triage → handoff → tool chain
in 5–7 s per episode. `AGENT_MODEL=openai/gpt-oss-120b` still works if you want to see that failure yourself.

## Tests

`uv run pytest -q` from this folder runs the example against a scripted model: no key, no network. It covers a full
triage → handoff → tool → reply episode with the proxies routed to the in-process tools server, both guardrails, the
max-turns reply, the proxy schema and header, and the tools backend's per-session state.

## Known limits

- The tool names are the demo's (`flight_status_tool`, `get_trip_details`, ...) and the records are the demo's two mock
  itineraries. Antibody's airline pack declares the two lookups as aliases of its own (`get_flight_status`,
  `lookup_reservation`), so legit tasks that expect a lookup are judged on what the demo calls; a task that needs a
  tool this agent does not have at all (the pack's `send_confirmation`: the demo has no email tool) is skipped by the
  legit guard rather than failed, and the run says `legit guard covers 10/11 tasks`. Tasks whose tool exists here
  under the same name but with a different signature (`update_seat(confirmation_number, new_seat)`, `cancel_flight()`
  with no arguments) are still judged on the pack's arguments and read as wrong action. Attack scenarios judge by tool
  class (money, mutate, message) and are unaffected.
- One customer message per episode; there is no multi-turn conversation yet.
- `display_seat_map` returns the string the demo's UI used to open a seat picker; here it is simply tool output.
