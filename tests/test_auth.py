"""`ANTIBODY_API_TOKEN`: unset means the API is open as before; set, every /api route but /api/health wants the bearer."""

from __future__ import annotations

import pytest

from api import auth


@pytest.fixture
def token(monkeypatch) -> str:
    monkeypatch.setenv(auth.TOKEN_ENV, "s3cret-token")
    return "s3cret-token"


def test_open_when_no_token_is_configured(client, monkeypatch):
    monkeypatch.delenv(auth.TOKEN_ENV, raising=False)
    assert client.get("/api/health").json()["auth_required"] is False
    assert client.get("/api/agents").status_code == 200


def test_refuses_without_or_with_wrong_bearer(client, token):
    r = client.get("/api/agents")
    assert r.status_code == 401
    assert r.json() == {"detail": auth.REFUSED}
    assert r.headers["www-authenticate"] == "Bearer"
    assert client.get("/api/agents", headers={"Authorization": "Bearer nope"}).status_code == 401
    assert client.get("/api/agents", headers={"Authorization": "Basic " + token}).status_code == 401
    assert client.post("/api/runs/archive").status_code == 401


def test_accepts_the_right_bearer(client, token):
    assert client.get("/api/agents", headers={"Authorization": "Bearer " + token}).status_code == 200
    assert client.get("/api/agents", headers={"Authorization": "bearer " + token}).status_code == 200


def test_health_stays_open_and_says_a_token_is_needed(client, token):
    r = client.get("/api/health")
    assert r.status_code == 200
    assert r.json()["auth_required"] is True


def test_blank_token_means_open(client, monkeypatch):
    monkeypatch.setenv(auth.TOKEN_ENV, "   ")
    assert client.get("/api/agents").status_code == 200
