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
    assert set(built) == {"target", "tools", "families"}
    assert [t["name"] for t in built["tools"]][:3] == ["lookup_order", "issue_refund", "send_email"]
