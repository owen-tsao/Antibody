# Example: a stock OpenAI Agents SDK agent under Antibody

This is the support agent Antibody attacks in the "bring your own agent" story. It is built on the
unmodified [OpenAI Agents SDK](https://github.com/openai/openai-agents-python), lives in its own
project with its own lockfile, and **imports nothing from Antibody** (`rg -t py "^(from|import) chaos" .` finds nothing).
Antibody breaks it, judges it, and hardens it without touching a line of its code — the accepted
policies are enforced in Antibody's tool server, in front of the agent's tools.

## What Antibody needs from your agent

- **Accept an episode.** `POST /episode` with `{session_id, message, customer_id, customer_email,
  tools_url}`. Treat `message` as the customer's opening turn; the customer fields belong in your
  prompt so the agent knows who it is talking to.
- **Call your tools at `tools_url`.** Every tool call is `POST {tools_url}/tools/{name}` with the
  arguments as a JSON object and the header `X-Antibody-Session: <session_id>`. The response body is
  the tool result — including `{"error": ...}` when a policy blocked the call, which the model should
  see as ordinary tool output.
- **Reply.** Return `200 {"reply": "<the agent's final message>"}`. Antibody has 120 s.

In this example that is one dataclass on the run context and one `headers=` kwarg per tool
(`_call_tool` in `agent.py`). Everything else is what a stock Agents SDK agent looks like anyway.

## Run it

From this folder (never from the repo root — the example is deliberately not a workspace member):

```bash
uv sync
set -a; source ../../../.env; set +a      # WANDB_API_KEY, never committed
uv run python agent.py                    # listens on AGENT_PORT, default 8790
```

Then, from the repo root, point the loop at it:

```bash
ANTIBODY_TARGET=http://localhost:8790 ANTIBODY_NO_ZENDESK=1 uv run python -m chaos.loop run --seeds 1 --chaos-cycles 1
```

The tool server starts inside the loop process on `ANTIBODY_TOOLS_PORT` (default 8765); the agent
learns its address from each `/episode` request, so nothing else needs configuring.

To poke at the agent without the loop, serve one fixed session from the repo root with
`uv run python -m chaos.toolserver --config v0 --scenario seed-injection-refund --session dev`, then
`POST /episode` with `"session_id": "dev"` and `"tools_url": "http://127.0.0.1:8765"`. Ctrl-C on the
tool server prints every call it recorded.

## The model

The example runs on **`openai/gpt-oss-20b`** (`AGENT_MODEL` to change it), not the
`Llama-3.1-8B-Instruct` the built-in target uses. Through a stock SDK every Llama on W&B Inference
fails the tool round-trip because the endpoint returns a constant tool-call id that the SDK treats as
a protocol violation — a quirk Antibody's built-in harness never notices because it only reads the
first tool call. Details are in the spike log of `docs/plans/01-pluggable-target.md`. gpt-oss-20b and
Qwen3-235B were the two models that both complete tool calls reliably *and* still fall for the seed
injection at v0, which is the behaviour the loop needs to have something to repair.

## Known limits

- The five tools are Antibody's five (orders, refunds, email, tickets); "bring your own tools" is roadmap.
- Ticket mode (`read_ticket` / `set_ticket_status`) has not been exercised over HTTP; the Zendesk world is suspended.
- Tool calls arrive at Antibody on server threads, so in Weave they show up as root traces rather than
  nested under the episode.
