"""Shared clients and config loading."""

from __future__ import annotations

import os
import threading
from dataclasses import dataclass
from pathlib import Path
from types import SimpleNamespace
from typing import Any

from openai import OpenAI

ROOT = Path(__file__).resolve().parent.parent
ENTITY_PROJECT = "owentsao23-clad-labs/chaos-monkey"
NO_DOTENV_ENV = "ANTIBODY_NO_DOTENV"


def load_env() -> None:
    """Fill the environment from `.env`, never overriding a variable that is already set.

    `ANTIBODY_NO_DOTENV=1` skips the file altogether: the test suite sets it (tests/conftest.py) so a checkout's
    key — or any other setting a developer keeps in `.env` — can never reach a test through this side door.
    """
    if os.environ.get(NO_DOTENV_ENV):
        return
    env_path = ROOT / ".env"
    if not env_path.exists():
        return
    for line in env_path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


load_env()

# Model choice is configuration, read once per process after `.env` is in the environment. It is not a
# per-run toggle: swapping a model mid-run invalidates the regression baseline every gate compares against.
# The target is small on purpose (it is the patient); the judge must be stronger than the target.
INFERENCE_URL = os.environ.get("ANTIBODY_INFERENCE_URL", "https://api.inference.wandb.ai/v1")
TARGET_MODEL = os.environ.get("ANTIBODY_TARGET_MODEL", "meta-llama/Llama-3.1-8B-Instruct")
CHAOS_MODEL = os.environ.get("ANTIBODY_CHAOS_MODEL", "deepseek-ai/DeepSeek-V4-Pro")
REPAIR_MODEL = os.environ.get("ANTIBODY_REPAIR_MODEL", "deepseek-ai/DeepSeek-V4-Pro")
JUDGE_MODEL = os.environ.get("ANTIBODY_JUDGE_MODEL", "openai/gpt-oss-120b")

# USD per million tokens (input, output). ESTIMATES, typed in from public list prices at the time of writing and
# rounded; the provider's price list is the source of truth and this table is only good enough to show a cycle's
# order of magnitude. A model not listed contributes tokens but no cost (`Meter.cost_usd` is None if nothing priced).
# The loop registers the same table with Weave at start (`chaos.loop.register_costs`, per token there), so the cost
# column in the Weave UI and the estimate here cannot disagree. Keys are the request ids: W&B Inference echoes the
# request id back as the response's `model` (checked live Sep 27 2026 for gpt-oss-20b and Llama-3.1-8B), and the
# response string is what Weave keys usage and cost on.
# Prices from wandb.ai/site/pricing/inference, read Sep 29 2026.
PRICE_PER_MILLION_USD: dict[str, tuple[float, float]] = {
    "meta-llama/Llama-3.1-8B-Instruct": (0.22, 0.22),
    "deepseek-ai/DeepSeek-V4-Pro": (1.15, 2.55),
    "deepseek-ai/DeepSeek-V3.1": (0.55, 1.65),
    "openai/gpt-oss-120b": (0.03, 0.17),
    "openai/gpt-oss-20b": (0.03, 0.13),
    # The bundled airline example's model (examples/agents/openai_cs_airline): its calls land in the same project.
    "Qwen/Qwen3-30B-A3B-Instruct-2507": (0.10, 0.30),
}


@dataclass
class Usage:
    input: int = 0
    output: int = 0
    # Tokens billed to a model this table has no price for: shown as tokens, not as cost.
    unpriced: int = 0
    cost_usd: float = 0.0

    def add(self, model: str, prompt_tokens: int, completion_tokens: int) -> None:
        self.input += prompt_tokens
        self.output += completion_tokens
        price = PRICE_PER_MILLION_USD.get(model)
        if price is None:
            self.unpriced += prompt_tokens + completion_tokens
        else:
            self.cost_usd += (prompt_tokens * price[0] + completion_tokens * price[1]) / 1_000_000

    def minus(self, earlier: Usage) -> Usage:
        return Usage(self.input - earlier.input, self.output - earlier.output, self.unpriced - earlier.unpriced, self.cost_usd - earlier.cost_usd)

    def snapshot(self) -> Usage:
        return Usage(self.input, self.output, self.unpriced, self.cost_usd)


class Meter:
    """Process-wide token count across every model call made through `get_client()`, whatever the role.

    The loop snapshots it at the start of a cycle and reads the difference at the end (`chaos.loop.run_cycle`),
    which is the whole cycle's bill: target episodes, judge, chaos, repair and every gate evaluation. Weave has the
    same numbers per call in its summaries; this is the in-process sum so a record can carry it without a query.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._total = Usage()

    def record(self, model: str | None, usage: Any) -> None:
        if usage is None:
            return
        prompt = int(getattr(usage, "prompt_tokens", 0) or 0)
        completion = int(getattr(usage, "completion_tokens", 0) or 0)
        with self._lock:
            self._total.add(model or "", prompt, completion)

    def snapshot(self) -> Usage:
        with self._lock:
            return self._total.snapshot()

    def since(self, earlier: Usage) -> Usage:
        with self._lock:
            return self._total.minus(earlier)


METER = Meter()


class _MeteredCompletions:
    def __init__(self, inner: Any) -> None:
        self._inner = inner

    def create(self, **kwargs: Any) -> Any:
        resp = self._inner.create(**kwargs)
        METER.record(kwargs.get("model"), getattr(resp, "usage", None))
        return resp


class MeteredClient:
    """`OpenAI` with `chat.completions.create` counted into `METER`; everything else passes through to the real client."""

    def __init__(self, inner: OpenAI) -> None:
        self._inner = inner
        self.chat = SimpleNamespace(completions=_MeteredCompletions(inner.chat.completions))

    def __getattr__(self, name: str) -> Any:
        return getattr(self._inner, name)


def get_client() -> MeteredClient:
    key = os.environ.get("WANDB_API_KEY")
    if not key:
        raise SystemExit("WANDB_API_KEY not set (put it in .env)")
    # The SDK default is a 10-minute timeout: one hung request would freeze the loop (and the UI's
    # orbs) for that long. 90 s covers the slowest DeepSeek repair call seen so far with room to spare.
    return MeteredClient(OpenAI(base_url=INFERENCE_URL, api_key=key, project=ENTITY_PROJECT, timeout=90.0, max_retries=2))
