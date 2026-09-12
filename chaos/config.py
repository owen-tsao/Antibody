"""Shared clients and config loading."""

from __future__ import annotations

import os
from pathlib import Path

from openai import OpenAI

ROOT = Path(__file__).resolve().parent.parent
ENTITY_PROJECT = "owentsao23-clad-labs/chaos-monkey"
INFERENCE_URL = "https://api.inference.wandb.ai/v1"

TARGET_MODEL = "meta-llama/Llama-3.1-8B-Instruct"
CHAOS_MODEL = "deepseek-ai/DeepSeek-V4-Pro"
REPAIR_MODEL = "deepseek-ai/DeepSeek-V4-Pro"
JUDGE_MODEL = "openai/gpt-oss-120b"


def load_env() -> None:
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


def get_client() -> OpenAI:
    key = os.environ.get("WANDB_API_KEY")
    if not key:
        raise SystemExit("WANDB_API_KEY not set (put it in .env)")
    return OpenAI(base_url=INFERENCE_URL, api_key=key, project=ENTITY_PROJECT)
