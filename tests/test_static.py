"""The one server serves the dashboard too: a hard refresh on an /app path must get index.html, not a 404.

`StaticFiles(html=True)` only serves index.html for directory URLs, so the API registers explicit /app
routes ahead of the mount (api/main.py, "Built dashboard"). These tests need a built dashboard; without
`web/dist` the routes are not registered and there is nothing to check, so they skip rather than fail.
"""

from __future__ import annotations

import re

import pytest
from fastapi.testclient import TestClient

from api.main import WEB_DIST

pytestmark = pytest.mark.skipif(not WEB_DIST.is_dir(), reason="web/dist not built (npm --prefix web run build)")


@pytest.mark.parametrize("path", ["/app", "/app/runs", "/app/agents/new", "/app/runs/live/cycles/3"])
def test_app_paths_serve_index_html(client: TestClient, path: str) -> None:
    r = client.get(path)
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("text/html")
    assert r.text == (WEB_DIST / "index.html").read_text()


def test_api_routes_still_win_over_the_fallback(client: TestClient) -> None:
    r = client.get("/api/health")
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("application/json")


def test_assets_are_served_as_files(client: TestClient) -> None:
    index = client.get("/").text
    script = re.search(r'src="(/assets/[^"]+\.js)"', index)
    assert script is not None, "index.html should reference a built script"
    r = client.get(script.group(1))
    assert r.status_code == 200
    assert "javascript" in r.headers["content-type"]


def test_paths_outside_the_app_still_404(client: TestClient) -> None:
    # The fallback is scoped to /app on purpose: a missing asset or a typo must not come back as HTML.
    assert client.get("/nope").status_code == 404
    assert client.get("/assets/nope.js").status_code == 404
