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
from chaos.domains import load_domain
from chaos.target import TARGET_ENV

INJECTION = next(s for s in load_domain("retail").seeds if s.id == "seed-injection-refund")


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
    monkeypatch.delenv("WANDB_API_KEY", raising=False)  # refused before the key check: unsupported with or without one

    response = TestClient(app).post("/api/attack", json={"scenario_id": INJECTION.id, "version": 0})

    assert response.status_code == 501
    assert "built-in agent" in response.json()["detail"] and "http://localhost:8790" in response.json()["detail"]


# --- the preview follows the running loop's agent ------------------------------------------------------------


def _loop(monkeypatch: pytest.MonkeyPatch, running: bool, target: str | None) -> None:
    from api import loop_ctl

    monkeypatch.setattr(loop_ctl, "state", lambda: {"running": running, "settings": {"target": target} if running else None})


def test_preview_refuses_when_the_running_loop_attacks_an_external_agent(monkeypatch: pytest.MonkeyPatch, no_side_effects: None) -> None:
    """The API's own ANTIBODY_TARGET is the built-in agent, but the loop was started against `example`."""
    from api.main import app

    monkeypatch.delenv(TARGET_ENV, raising=False)
    _loop(monkeypatch, running=True, target="example")
    response = TestClient(app).post("/api/attack", json={"scenario_id": INJECTION.id, "version": 0})
    assert response.status_code == 501
    assert "running loop's agent is http:http://127.0.0.1:8790" in response.json()["detail"]


def test_preview_runs_the_builtin_agent_the_loop_chose_even_when_the_api_default_is_external(monkeypatch: pytest.MonkeyPatch) -> None:
    from api.main import app

    monkeypatch.setenv(TARGET_ENV, "http:localhost:8790")
    _loop(monkeypatch, running=True, target="builtin")
    ran: list[tuple] = []
    monkeypatch.setattr(attack, "run", lambda cfg, scenario, target=None: ran.append((cfg.version, scenario.id, target)) or {"ok": True})
    monkeypatch.setattr(attack, "missing_api_key", lambda: False)
    response = TestClient(app).post("/api/attack", json={"scenario_id": INJECTION.id, "version": 0})
    assert response.status_code == 200, response.text
    assert ran == [(0, INJECTION.id, "builtin")]


def test_preview_keeps_the_api_default_when_no_loop_is_running(monkeypatch: pytest.MonkeyPatch, no_side_effects: None) -> None:
    from api.main import app

    monkeypatch.setenv(TARGET_ENV, "http:localhost:8790")
    _loop(monkeypatch, running=False, target=None)
    response = TestClient(app).post("/api/attack", json={"scenario_id": INJECTION.id, "version": 0})
    assert response.status_code == 501 and "ANTIBODY_TARGET points at" in response.json()["detail"]


def test_preview_falls_back_to_the_default_when_the_loops_agent_row_is_gone(monkeypatch: pytest.MonkeyPatch) -> None:
    from api.main import _preview_target

    _loop(monkeypatch, running=True, target="deleted-agent-id")
    assert _preview_target() is None


def test_run_threads_the_target_into_the_episode(monkeypatch: pytest.MonkeyPatch) -> None:
    """`attack.run(..., target)` hands the name to run_target_agent rather than reading the env again."""
    import chaos.target_agent as target_agent

    seen: list[str | None] = []

    def fake_run_target_agent(cfg, scenario, target_name=None):
        seen.append(target_name)
        raise RuntimeError("stop here")

    monkeypatch.setattr(target_agent, "run_target_agent", fake_run_target_agent)
    monkeypatch.setattr(attack, "_ensure_weave", lambda: None)
    monkeypatch.setenv(TARGET_ENV, "http:localhost:8790")  # the env says external; the explicit name wins
    with pytest.raises(attack.AttackFailed, match="stop here"):
        attack.run(attack.find_config(0), INJECTION, "builtin")
    assert seen == ["builtin"] and not attack.is_running()
