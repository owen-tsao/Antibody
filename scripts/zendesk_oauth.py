"""Get a Zendesk OAuth access token with the client_credentials grant (no browser, no redirect).

Reads ZENDESK_SUBDOMAIN, ZENDESK_CLIENT_ID (the OAuth client's Identifier), ZENDESK_CLIENT_SECRET from .env;
writes ZENDESK_OAUTH_TOKEN. Never prints any credential.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

import httpx

from chaos.config import ROOT, load_env

load_env()

SUB = os.environ.get("ZENDESK_SUBDOMAIN")
CLIENT_ID = os.environ.get("ZENDESK_CLIENT_ID")
SECRET = os.environ.get("ZENDESK_CLIENT_SECRET")
if not all([SUB, CLIENT_ID, SECRET]):
    sys.exit("set ZENDESK_SUBDOMAIN, ZENDESK_CLIENT_ID, ZENDESK_CLIENT_SECRET in .env")

SCOPE = "tickets:read tickets:write users:read"

resp = httpx.post(
    f"https://{SUB}.zendesk.com/oauth/tokens",
    data={
        "grant_type": "client_credentials",
        "client_id": CLIENT_ID,
        "client_secret": SECRET,
        "scope": SCOPE,
        "expires_in": 172800,  # 2 days: covers the whole hackathon
    },
    timeout=20,
)
if resp.status_code != 200:
    print(f"FAILED {resp.status_code}: {resp.text[:300]}")
    sys.exit("client_credentials grant failed")

token = resp.json()["access_token"]
env_path: Path = ROOT / ".env"
lines = [l for l in env_path.read_text().splitlines() if not l.startswith("ZENDESK_OAUTH_TOKEN=")]
lines.append(f"ZENDESK_OAUTH_TOKEN={token}")
env_path.write_text("\n".join(lines) + "\n")
print(f"OK: access token written to .env (scope: {SCOPE}, expires in {resp.json().get('expires_in')}s).")
print("Now run: uv run python -m scripts.spike_zendesk")
