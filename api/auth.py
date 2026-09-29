"""One shared bearer token in front of every /api route, when the operator asks for one.

`ANTIBODY_API_TOKEN` unset (the default, and every install so far) means no auth: the API binds loopback and is
driven by the person who owns the machine. Set, every request under `/api/` must carry
`Authorization: Bearer <token>`; `/api/health` stays open so the dashboard can learn that a token is needed
before its first 401, and so the Makefile's health wait keeps working. The built dashboard (`/`, `/app/*`) is
static and stays open too — it holds nothing.

Read from the environment on every request, not at import: a test can set it per case, and an operator who
restarts with a new token gets the new one without a code path that caches the old.

The gateway (`chaos.gateway`) runs the same check with its own variable, `ANTIBODY_GATEWAY_TOKEN`, through
`bearer_ok` and `refusal`: one definition of "the bearer matches", two front doors.
"""

from __future__ import annotations

import os
import secrets

from fastapi import Request
from fastapi.responses import JSONResponse

TOKEN_ENV = "ANTIBODY_API_TOKEN"
OPEN_PATHS = frozenset({"/api/health"})
REFUSED = "missing or wrong API token"


def configured(env: str = TOKEN_ENV) -> str:
    return os.environ.get(env, "").strip()


def required() -> bool:
    return bool(configured())


def bearer_ok(header: str | None, token: str) -> bool:
    """True when an `Authorization` header value is `Bearer <token>` (scheme case-insensitive, constant-time compare)."""
    scheme, _, presented = (header or "").partition(" ")
    return scheme.lower() == "bearer" and secrets.compare_digest(presented.strip(), token)


def authorized(request: Request) -> bool:
    """True when no token is configured, the path is open, or the bearer matches (constant-time)."""
    token = configured()
    if not token or request.url.path in OPEN_PATHS or not request.url.path.startswith("/api/"):
        return True
    return bearer_ok(request.headers.get("authorization"), token)


def refusal(detail: str = REFUSED) -> JSONResponse:
    """A 401 in the API's usual `{detail}` shape, so the dashboard's error line reads it like any other."""
    return JSONResponse(status_code=401, content={"detail": detail}, headers={"WWW-Authenticate": "Bearer"})
