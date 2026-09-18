"""`POST /api/attack` refuses to preview an external target.

The preview runs the target inside the API process. For an external agent that would start Antibody's tool
server there, on the port the loop process needs, and the next real run would die trying to bind it. So the
route must refuse before it does anything — before the lock, before the worker, before `HttpTarget`.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from api import attack
from chaos import toolserver
from chaos.scenarios import SEED_SCENARIOS
from chaos.target import TARGET_ENV

INJECTION = next(s for s in SEED_SCENARIOS if s.id == "seed-injection-refund")


@pytest.fixture
def no_side_effects(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(toolserver, "ensure_server", lambda *a, **k: pytest.fail("the API process must never start the tool server"))
    monkeypatch.setattr(attack._executor, "submit", lambda *a, **k: pytest.fail("no attack may be queued for an external target"))


def test_external_target_is_refused_before_the_lock(monkeypatch: pytest.MonkeyPatch, no_side_effects: None) -> None:
    monkeypatch.setenv(TARGET_ENV, "http:localhost:8790")
    cfg = attack.find_config(0)
    assert cfg is not None

    with pytest.raises(attack.AttackUnsupported, match=r"built-in agent.*http:http://localhost:8790"):
        attack.run(cfg, INJECTION)
    assert not attack.is_running(), "a refused attack must not leave the lock held"
    assert issubclass(attack.AttackUnsupported, attack.AttackFailed), "api.main maps AttackFailed; the refusal rides on it"


def test_unknown_target_name_is_refused_the_same_way(monkeypatch: pytest.MonkeyPatch, no_side_effects: None) -> None:
    monkeypatch.setenv(TARGET_ENV, "mcp:foo")
    with pytest.raises(attack.AttackUnsupported, match="unknown target"):
        attack.run(attack.find_config(0), INJECTION)


def test_builtin_target_is_not_refused(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv(TARGET_ENV, raising=False)
    assert attack.unsupported_target() is None


def test_route_surfaces_the_refusal_with_a_clear_detail(monkeypatch: pytest.MonkeyPatch, no_side_effects: None) -> None:
    from api.main import app

    monkeypatch.setenv(TARGET_ENV, "http:localhost:8790")
    monkeypatch.setenv("ANTIBODY_NO_WEAVE", "1")  # the route's key check comes first; this is not about keys

    response = TestClient(app).post("/api/attack", json={"scenario_id": INJECTION.id, "version": 0})

    # Until api.main maps AttackUnsupported to 501 itself, the refusal rides on the AttackFailed → 500 mapping.
    assert response.status_code == 500
    assert "built-in agent" in response.json()["detail"] and "http://localhost:8790" in response.json()["detail"]
