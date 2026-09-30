"""OpenAI's customer-service airline demo (six agents, handoffs, two guardrails), served the way Antibody attacks an
agent. Imports nothing from Antibody. The agents and tools are the demo's (MIT; LICENSE-openai-cs-agents-demo) —
see airline/__init__.py for what was changed.

Two servers in one process:

- `AGENT_PORT` (default 8792): `POST /episode` runs the triage agent on one customer message with a fresh
  `AirlineAgentContext` for that `session_id`; `GET /tools` lists the tools the agents own. Every tool the agents
  hold is an HTTP proxy with the original's schema that POSTs to `{tools_url}/tools/{name}` with the session id in
  `X-Antibody-Session` — that header is the whole integration.
- `TOOLS_PORT` (default 8793): the real tool functions, `POST /tools/{name}` + `GET /tools`, run against the
  per-session context found by the forwarded `X-Antibody-Session`. This is what Antibody calls the `tools_backend`:
  the loop injects faults and enforces policy in between, then forwards here.

    uv sync && uv run python agent.py

Model: `AGENT_MODEL` names an OpenAI-compatible chat model. With `WANDB_API_KEY` set it is served by W&B Inference
(default `Qwen/Qwen3-30B-A3B-Instruct-2507`); with `OPENAI_API_KEY` and no W&B key, by OpenAI directly
(`AGENT_MODEL=gpt-5.2` is the demo's own choice). One variable, both branches.
"""

from __future__ import annotations

import json
import logging
import os
import threading

import httpx
import uvicorn
from agents import (
    Agent,
    FunctionTool,
    InputGuardrailTripwireTriggered,
    MaxTurnsExceeded,
    ModelBehaviorError,
    ModelSettings,
    OpenAIChatCompletionsModel,
    RunContextWrapper,
    Runner,
    set_tracing_disabled,
)
from agents.tool_context import ToolContext
from airline.agents import TRIAGE, build_agents
from airline.context import AirlineAgentContext
from airline.guardrails import JAILBREAK_REFUSAL, RELEVANCE_REFUSAL, build_guardrails
from airline.tools import ALL_TOOLS
from fastapi import FastAPI, Header, HTTPException
from openai import AsyncOpenAI
from pydantic import BaseModel

set_tracing_disabled(True)  # never phone home to OpenAI's trace exporter

WANDB_INFERENCE_URL = "https://api.inference.wandb.ai/v1"
WANDB_PROJECT = os.environ.get("WANDB_PROJECT", "owentsao23-clad-labs/chaos-monkey")
# Qwen, not gpt-oss: on W&B Inference gpt-oss-120b narrates the handoff ("Transferring you now…") instead of calling
# the transfer tool, so no specialist runs and no tool is ever called (12 of 12 loop episodes, Sep 22 2026); Qwen3
# completes triage → handoff → tool chain in seconds. Qwen3-235B left the W&B catalogue by Sep 29 2026 (every episode
# was a 404 from the model, surfaced as HTTP 500); the 30B sibling from the same release is what it serves now. See README.
DEFAULT_WANDB_MODEL = "Qwen/Qwen3-30B-A3B-Instruct-2507"
DEFAULT_OPENAI_MODEL = "gpt-5.2"
MAX_TURNS = 10  # a triage handoff plus a specialist's tool chain is several turns; the demo let its UI run unbounded
MAX_TURNS_REPLY = "(agent hit max turns without replying)"
# What the customer hears when the model asks for something the SDK cannot carry out — most often, after a tool
# call came back blocked, a call to a tool the current specialist does not hold (`ModelBehaviorError`). The demo's
# UI would have shown a stack trace; a customer gets the agent declining, and the judge scores that, not a 500.
CANNOT_COMPLETE_REPLY = "Sorry, I wasn't able to complete that action. Is there anything else I can help you with?"
SESSION_HEADER = "X-Antibody-Session"
# Tests point this at the tools app in-process; None means real sockets.
http_transport: httpx.AsyncBaseTransport | None = None
log = logging.getLogger("airline.agent")


class Session(AirlineAgentContext):
    """The demo's context plus what the proxy tools need: where to send the call and which session it belongs to.

    One object per session id, shared by the agent run and the tools server in this process — so a handoff callback
    that hydrates the itinerary and the real `cancel_flight` that reads it see the same state, as in the demo.
    """

    session_id: str
    tools_url: str = ""


class EpisodeRequest(BaseModel):
    session_id: str
    message: str
    customer_id: str | None = None
    customer_email: str | None = None
    tools_url: str


def proxy_tool(tool: FunctionTool) -> FunctionTool:
    """A tool with `tool`'s name, description and JSON schema whose body is an HTTP call to Antibody's tool URL."""

    async def invoke(ctx: RunContextWrapper[Session], args_json: str) -> str:
        async with httpx.AsyncClient(timeout=30, transport=http_transport) as http:
            r = await http.post(
                f"{ctx.context.tools_url.rstrip('/')}/tools/{tool.name}",
                json=json.loads(args_json or "{}"),
                headers={SESSION_HEADER: ctx.context.session_id},
            )
        # A blocked or unknown tool comes back as {"error": ...}; it is tool output the model should see verbatim.
        return r.text

    return FunctionTool(
        name=tool.name,
        description=tool.description,
        params_json_schema=tool.params_json_schema,
        on_invoke_tool=invoke,
        strict_json_schema=tool.strict_json_schema,
    )


def model_from_env():
    """The one place the model is chosen: W&B Inference when its key is present, OpenAI otherwise."""
    if os.environ.get("WANDB_API_KEY"):
        # max_retries=3: W&B Inference enforces a per-user concurrency cap per model (HTTP 429); Antibody's gate runs its
        # legit rows concurrently and each episode is three model calls (two guardrails + the agent), so the cap is hit.
        client = AsyncOpenAI(base_url=WANDB_INFERENCE_URL, api_key=os.environ["WANDB_API_KEY"], default_headers={"OpenAI-Project": WANDB_PROJECT}, timeout=60.0, max_retries=3)
        return OpenAIChatCompletionsModel(model=os.environ.get("AGENT_MODEL", DEFAULT_WANDB_MODEL), openai_client=client)
    client = AsyncOpenAI(api_key=os.environ.get("OPENAI_API_KEY", "missing"), timeout=60.0, max_retries=1)
    return OpenAIChatCompletionsModel(model=os.environ.get("AGENT_MODEL", DEFAULT_OPENAI_MODEL), openai_client=client)


def build(model) -> dict[str, Agent]:
    """The agents with proxy tools in place of the originals."""
    agents = build_agents(model, {name: proxy_tool(t) for name, t in ALL_TOOLS.items()}, build_guardrails(model))
    for a in agents.values():
        # temperature 0 like Antibody's built-in target; gpt-oss reasons before it answers and that counts against max_tokens.
        a.model_settings = ModelSettings(temperature=0.0, max_tokens=1200)
    return agents


agents = build(model_from_env())
sessions: dict[str, Session] = {}
_sessions_lock = threading.Lock()


def session_for(session_id: str, tools_url: str | None = None) -> Session:
    """The session's shared context; a `tools_url` starts the session afresh (a new episode), its absence joins the existing one."""
    with _sessions_lock:
        if tools_url is not None or session_id not in sessions:
            sessions[session_id] = Session(session_id=session_id, tools_url=tools_url or "")
        return sessions[session_id]


def owned_tools() -> list[dict[str, str]]:
    """Every tool some agent holds, once, in the order the demo lists them; `baggage_tool` exists in the demo but no agent holds it."""
    held = {t.name for a in agents.values() for t in a.tools}
    return [{"name": t.name, "description": t.description or ""} for t in ALL_TOOLS.values() if t.name in held]


app = FastAPI(title="Airline agents (openai-cs-agents-demo, no ChatKit)", docs_url=None, redoc_url=None)
tools_app = FastAPI(title="Airline demo tools", docs_url=None, redoc_url=None)


@app.get("/tools")
async def tools() -> list[dict[str, str]]:
    """Answered without a model call, so it doubles as the readiness check Antibody polls after starting this process."""
    return owned_tools()


@app.post("/episode")
async def episode(req: EpisodeRequest) -> dict[str, str]:
    session = session_for(req.session_id, req.tools_url)
    try:
        result = await Runner.run(agents[TRIAGE], req.message, context=session, max_turns=MAX_TURNS)
    except InputGuardrailTripwireTriggered as e:
        name = getattr(getattr(e.guardrail_result, "guardrail", None), "name", "") or ""
        return {"reply": JAILBREAK_REFUSAL if "Jailbreak" in name else RELEVANCE_REFUSAL}
    except MaxTurnsExceeded:
        return {"reply": MAX_TURNS_REPLY}
    except ModelBehaviorError as e:
        log.warning("session %s: model misbehaved, replying with a refusal: %s", req.session_id, e)
        return {"reply": CANNOT_COMPLETE_REPLY}
    return {"reply": str(result.final_output or "")}


@tools_app.get("/tools")
async def backend_tools() -> list[dict[str, str]]:
    return [{"name": t.name, "description": t.description or ""} for t in ALL_TOOLS.values()]


@tools_app.post("/tools/{name}")
async def backend_call(name: str, body: dict | None = None, x_antibody_session: str | None = Header(default=None)) -> dict:
    """Run the real tool against the session's context. A tool that raises answers 200 with the SDK's own error text, the
    way it would inside a run; an unknown tool is 404 — the caller's mistake, not a failure of this backend."""
    tool = ALL_TOOLS.get(name)
    if tool is None:
        raise HTTPException(404, {"error": f"unknown tool {name!r}"})
    args = json.dumps(body or {})
    ctx = ToolContext(context=session_for(x_antibody_session or "anonymous"), tool_name=name, tool_call_id=f"antibody-{name}", tool_arguments=args)
    return {"result": await tool.on_invoke_tool(ctx, args)}


def serve(agent_port: int, tools_port: int) -> None:
    """The tools server on a daemon thread (uvicorn only installs signal handlers on the main thread), the agent on main."""
    tools_server = uvicorn.Server(uvicorn.Config(tools_app, host="127.0.0.1", port=tools_port, log_level="info"))
    threading.Thread(target=tools_server.run, daemon=True, name="tools-server").start()
    uvicorn.run(app, host="127.0.0.1", port=agent_port, log_level="info")


if __name__ == "__main__":
    serve(int(os.environ.get("AGENT_PORT", "8792")), int(os.environ.get("TOOLS_PORT", "8793")))
