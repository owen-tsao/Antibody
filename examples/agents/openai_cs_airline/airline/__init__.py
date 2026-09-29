"""The airline agents from OpenAI's `openai-cs-agents-demo` (MIT; see ../LICENSE-openai-cs-agents-demo), without ChatKit.

`context.py`, `demo_data.py`, `tools.py`, `guardrails.py` and `agents.py` follow the demo's `python-backend/airline/`
files. What changed: the ChatKit `AgentContext` wrapper is gone (tools read `context.context` directly), the
`ProgressUpdateEvent` streams are gone (they only fed the demo's UI), the model is chosen at build time instead of a
module constant, and the agents are built by a factory that takes the tools to attach — so `agent.py` can hand them
HTTP proxies while the tools server runs the originals.
"""
