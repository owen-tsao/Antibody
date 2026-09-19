"""`/api/manifest` reports the target the API process would attack, resolved like the loop resolves it."""

from __future__ import annotations

import pytest

from api import manifest
from chaos.target import TARGET_ENV


@pytest.fixture(autouse=True)
def _fresh_manifest():
    # `build` is cached for the life of the process (the manifest is static per env); tests change the env.
    manifest.build.cache_clear()
    yield
    manifest.build.cache_clear()


def test_builtin_target_keeps_its_display_name_and_model(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv(TARGET_ENV, raising=False)
    target = manifest.build()["target"]
    assert target == {
        "name": manifest.TARGET_NAME,
        "model": target["model"],
        "model_short": manifest._short_model(target["model"]),
        "transport": "in-process",
    }
    assert "url" not in target


def test_external_target_reports_its_canonical_name_url_and_no_model(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(TARGET_ENV, "http:localhost:8790")
    built = manifest.build()
    assert built["target"] == {
        "name": "http:http://localhost:8790",
        "model": None,
        "model_short": None,
        "transport": "http",
        "url": "http://localhost:8790",
    }
    # Only `target` depends on the env; the rest of the manifest is the same for every target.
    assert set(built) == {"target", "models", "tools", "families", "defaults"}
    assert [t["name"] for t in built["tools"]][:3] == ["lookup_order", "issue_refund", "send_email"]


def test_models_are_the_ones_this_process_resolved() -> None:
    from chaos import config

    models = manifest.build()["models"]
    assert models == {
        "target": config.TARGET_MODEL,
        "chaos": config.CHAOS_MODEL,
        "repair": config.REPAIR_MODEL,
        "judge": config.JUDGE_MODEL,
        "inference_url": config.INFERENCE_URL,
    }
    assert manifest.build()["target"]["model"] == models["target"]


def test_model_names_come_from_the_environment() -> None:
    """`ANTIBODY_*_MODEL` is read when `chaos.config` is imported, so a fresh interpreter is the honest check."""
    import json
    import os
    import subprocess
    import sys

    from chaos.state import ROOT

    code = (
        "import json; from chaos import config; from api import manifest; "
        "print(json.dumps({'judge': config.JUDGE_MODEL, 'url': config.INFERENCE_URL, 'manifest': manifest.build()['models']}))"
    )
    env = {**os.environ, "ANTIBODY_JUDGE_MODEL": "org/stronger-judge", "ANTIBODY_INFERENCE_URL": "https://example.test/v1"}
    r = subprocess.run([sys.executable, "-c", code], cwd=ROOT, env=env, capture_output=True, text=True, timeout=120)
    assert r.returncode == 0, r.stderr
    out = json.loads(r.stdout.strip().splitlines()[-1])
    assert out["judge"] == "org/stronger-judge" and out["url"] == "https://example.test/v1"
    assert out["manifest"]["judge"] == "org/stronger-judge" and out["manifest"]["inference_url"] == "https://example.test/v1"
    # Roles that were not overridden keep their defaults.
    assert out["manifest"]["target"] == "meta-llama/Llama-3.1-8B-Instruct" or "ANTIBODY_TARGET_MODEL" in os.environ
