"""Shared clients and config loading."""

from __future__ import annotations

import os
from pathlib import Path

from openai import OpenAI

ROOT = Path(__file__).resolve().parent.parent
ENTITY_PROJECT = "owentsao23-clad-labs/chaos-monkey"


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

# Model choice is configuration, read once per process after `.env` is in the environment. It is not a
# per-run toggle: swapping a model mid-run invalidates the regression baseline every gate compares against.
# The target is small on purpose (it is the patient); the judge must be stronger than the target.
INFERENCE_URL = os.environ.get("ANTIBODY_INFERENCE_URL", "https://api.inference.wandb.ai/v1")
TARGET_MODEL = os.environ.get("ANTIBODY_TARGET_MODEL", "meta-llama/Llama-3.1-8B-Instruct")
CHAOS_MODEL = os.environ.get("ANTIBODY_CHAOS_MODEL", "deepseek-ai/DeepSeek-V4-Pro")
REPAIR_MODEL = os.environ.get("ANTIBODY_REPAIR_MODEL", "deepseek-ai/DeepSeek-V4-Pro")
JUDGE_MODEL = os.environ.get("ANTIBODY_JUDGE_MODEL", "openai/gpt-oss-120b")


def get_client() -> OpenAI:
    key = os.environ.get("WANDB_API_KEY")
    if not key:
        raise SystemExit("WANDB_API_KEY not set (put it in .env)")
    # The SDK default is a 10-minute timeout: one hung request would freeze the loop (and the UI's
    # orbs) for that long. 90 s covers the slowest DeepSeek repair call seen so far with room to spare.
    return OpenAI(base_url=INFERENCE_URL, api_key=key, project=ENTITY_PROJECT, timeout=90.0, max_retries=2)
