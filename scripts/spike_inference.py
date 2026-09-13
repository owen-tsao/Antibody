"""Spike: verify the two riskiest assumptions before building anything.

1. W&B Inference works through the plain OpenAI SDK.
2. Weave traces a decorated function and shows tool-call-style structure.

Run:  uv run python -m scripts.spike_inference
"""

import os
import sys
from pathlib import Path

import weave
from openai import OpenAI

ENTITY_PROJECT = "owentsao23-clad-labs/chaos-monkey"
INFERENCE_URL = "https://api.inference.wandb.ai/v1"
MODEL = "OpenPipe/Qwen3-14B-Instruct"


def load_env() -> None:
    env_path = Path(__file__).resolve().parents[1] / ".env"
    if not env_path.exists():
        return
    for line in env_path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


load_env()
if not os.environ.get("WANDB_API_KEY"):
    sys.exit("WANDB_API_KEY not set. Put it in .env as WANDB_API_KEY=... (file is gitignored).")

weave.init(ENTITY_PROJECT)

client = OpenAI(
    base_url=INFERENCE_URL,
    api_key=os.environ["WANDB_API_KEY"],
    project=ENTITY_PROJECT,
)


@weave.op
def lookup_order(order_id: str) -> dict:
    """Mock tool. Later the chaos agent will make this return garbage."""
    return {"order_id": order_id, "status": "shipped", "total": 42.00}


@weave.op
def support_agent(message: str) -> str:
    order = lookup_order("A-1001")
    response = client.chat.completions.create(
        model=MODEL,
        messages=[
            {"role": "system", "content": "You are a support agent. Answer briefly."},
            {"role": "user", "content": f"Order data: {order}\n\nCustomer: {message}"},
        ],
        max_tokens=120,
    )
    return response.choices[0].message.content or ""


if __name__ == "__main__":
    reply = support_agent("Where is my order?")
    print("\nMODEL REPLY:\n", reply)
    print("\nSPIKE OK — check the Weave UI for a nested trace: support_agent -> lookup_order + chat.completions")
