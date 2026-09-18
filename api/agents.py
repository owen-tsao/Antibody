"""Agents as stored objects: the support agents a user has connected, by name and URL (plan 00, Block 1).

Until now "which agent" was an environment variable the API showed read-only. This module makes it a thing
the UI can list, connect, ping and pick when starting a run, without breaking `ANTIBODY_TARGET` for CLI
users: an agent row resolves to exactly the canonical target string the loop already understands
(`chaos.target.resolve_target(...).name`), and `api.loop_ctl.start` puts that string in the child's env.

The store is `history/agents.json`, a list of `{id, name, transport, url, created_at, last_ping, tools}`,
written whole via mkstemp + `os.replace` like `chaos.state.save_regression` (the API reads it on a poll).
Two rows are synthetic and never stored: `builtin` (the in-process demo agent, like `golden` in the runs
list) and `example` (the OpenAI Agents SDK agent on 8790 that `api.example_agent` can spawn). Neither can
be deleted. `api.store` stays read-only by design; this module owns the one file the API writes under
history/.

Ping never goes through `HttpTarget.run_episode`: that path starts the tool server in the calling process
(`chaos/target.py`), and a tool server bound inside uvicorn would take the port every later loop child
needs. Ping is a bare `POST <url>/episode` with a hello, a fresh session id and a `tools_url` where nothing
listens (verified against the example agent: it replies in ~2 s whether or not the message tempts a tool
call). Then `GET <url>/tools` (optional on the agent's side) for the tool mapping. Nothing is recorded as an
episode; only `last_ping` and `tools` land on the stored row.

Ping does POST a fixed body to whatever URL the user typed. That is accepted for a tool that binds
127.0.0.1 and is driven by the person who owns the machine; it is not a surface to expose on a network.
"""

from __future__ import annotations

import contextlib
import json
import os
import secrets
import tempfile
import threading
import time
import urllib.error
import urllib.parse
from datetime import datetime, timezone

from api import example_agent, store
from chaos.target import BuiltinTarget, get_json, is_timeout, post_json, resolve_target


def storefront_tools() -> list[str]:
    """The sandbox storefront's tool names (`chaos.tools.TOOL_FUNCS`), imported on first use.

    `chaos.tools` does `import weave`, a slow library import the API keeps off its startup path
    (see `api.manifest`); the list is only needed once someone pings or reads the built-in row.
    """
    from chaos.tools import TOOL_FUNCS

    return list(TOOL_FUNCS)


def _customer_email(customer_id: str) -> str:
    from chaos.tools import customer_email_for

    return customer_email_for(customer_id)


BUILTIN_ID = "builtin"
EXAMPLE_ID = "example"
RESERVED_IDS = frozenset({BUILTIN_ID, EXAMPLE_ID})
MAX_URL_BYTES = 2048
MAX_NAME_CHARS = 80
PING_TIMEOUT_S = 10.0
TOOLS_TIMEOUT_S = 2.0
REPLY_PREVIEW_CHARS = 160
# Something the agent can answer without wanting a tool: the point is reachability, not a scenario.
HELLO_MESSAGE = "Hello! Quick check that you are reachable. Please just say hi and tell me what you can help with."
# The demo customer every seed scenario uses; a support agent's prompt usually wants one.
PING_CUSTOMER_ID = "cust_owen"
# The loop's usual tool-server address. Nothing listens during a ping; an agent that calls a tool anyway
# gets a connection error as tool output and still replies (that is what the hour-one check confirmed).
PING_TOOLS_URL = "http://127.0.0.1:8765"


class Duplicate(Exception):
    """An agent with the same canonical target already exists (HTTP 409)."""


# Routes run on a threadpool; a connect and a ping landing together must not lose each other's write.
_store_lock = threading.Lock()


def _path():
    # `store.HISTORY_DIR` at call time: the same name the runs list reads, so a test that relocates one
    # relocates both and can never reach the developer's real history/.
    return store.HISTORY_DIR / "agents.json"


def _read() -> list[dict]:
    """The stored rows that are usable. A hand-edited row with a URL `resolve_target` rejects is skipped,
    never raised, so one bad line cannot take `GET /api/runs` down."""
    try:
        doc = json.loads(_path().read_text())
    except (OSError, ValueError):
        return []
    if not isinstance(doc, list):
        return []
    rows = []
    for row in doc:
        if not (isinstance(row, dict) and isinstance(row.get("id"), str) and isinstance(row.get("url"), str)):
            continue
        try:
            canonical(row["url"])
        except ValueError:
            continue
        rows.append(row)
    return rows


def _write(rows: list[dict]) -> None:
    path = _path()
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=".agents-", suffix=".tmp")
    try:
        with os.fdopen(fd, "w") as f:
            f.write(json.dumps(rows, indent=2))
        os.replace(tmp, path)
    except BaseException:
        with contextlib.suppress(OSError):
            os.unlink(tmp)
        raise


def canonical(url_or_name: str) -> str:
    """`resolve_target(x).name`: `builtin`, or `http:<url>` for a bare or already-prefixed URL."""
    return resolve_target(url_or_name).name


def _builtin_row() -> dict:
    return {
        "id": BUILTIN_ID,
        "name": "Demo agent (built in)",
        "transport": BuiltinTarget.transport,
        "url": None,
        "created_at": None,
        "last_ping": None,
        "tools": [{"name": n, "description": ""} for n in storefront_tools()],
        "synthetic": True,
    }


def _example_row(*, probe: bool = True) -> dict:
    row = {
        "id": EXAMPLE_ID,
        "name": "Example agent (OpenAI Agents SDK)",
        "transport": "http",
        "url": example_agent.URL,
        "created_at": None,
        "last_ping": None,
        "tools": None,
        "synthetic": True,
    }
    if probe:
        row.update({k: v for k, v in example_agent.state().items() if k in ("running", "starting", "pid")})
    return row


def list_agents(*, probe: bool = True) -> list[dict]:
    """`builtin`, `example`, then the stored rows oldest first. Stored rows carry `synthetic: false`.

    `probe=False` skips the example agent's port check (`running`/`starting`/`pid` are then absent):
    for joins and id lookups that only need names and URLs, one HTTP probe per call would be waste.
    """
    return [_builtin_row(), _example_row(probe=probe), *({**row, "synthetic": False} for row in _read())]


def get_agent(agent_id: str) -> dict | None:
    return next((a for a in list_agents(probe=False) if a["id"] == agent_id), None)


def _validate_url(url: str) -> str:
    url = url.strip()
    if len(url.encode()) > MAX_URL_BYTES:
        raise ValueError(f"url is longer than {MAX_URL_BYTES} bytes")
    if any(c.isspace() for c in url):
        raise ValueError("url must not contain whitespace")
    parts = urllib.parse.urlsplit(url)
    if parts.scheme not in ("http", "https") or not parts.netloc:
        raise ValueError("url must look like http://host[:port][/path]")
    # `/episode` and `/tools` are appended to it, so anything after the path cannot mean what the user hoped.
    if parts.query or parts.fragment:
        raise ValueError("url must not have a query string or fragment")
    return url.rstrip("/")


def add_agent(name: str, url: str) -> dict:
    """Store a new agent. ValueError for a bad name/URL (400); Duplicate when the URL is already connected (409)."""
    name = " ".join(name.split())
    if not name:
        raise ValueError("name must not be empty")
    if len(name) > MAX_NAME_CHARS:
        raise ValueError(f"name is longer than {MAX_NAME_CHARS} characters")
    url = _validate_url(url)
    target = canonical(url)
    row = {
        "id": secrets.token_urlsafe(8),
        "name": name,
        "transport": "http",
        "url": url,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "last_ping": None,
        "tools": None,
    }
    with _store_lock:
        rows = _read()
        # Dedupe among stored rows only: the example agent's URL may be connected under a name of your own.
        for existing in rows:
            if canonical(existing["url"]) == target:
                raise Duplicate(f"{url} is already connected as {existing['name']!r} (id {existing['id']})")
        _write([*rows, row])
    return {**row, "synthetic": False}


def delete_agent(agent_id: str) -> None:
    """Remove a stored row. LookupError for a synthetic or unknown id (404)."""
    if agent_id in RESERVED_IDS:
        raise LookupError(f"agent {agent_id!r} is built in and cannot be deleted")
    with _store_lock:
        rows = _read()
        kept = [r for r in rows if r["id"] != agent_id]
        if len(kept) == len(rows):
            raise LookupError(f"no agent {agent_id!r}")
        _write(kept)


def resolve_agent(agent_id: str | None) -> str:
    """The canonical target string for an agent id; `None` means the API process's own default.

    Raises ValueError for an unknown id, so a request naming a deleted agent is a client error, not a run.
    """
    if agent_id is None:
        return resolve_target().name
    agent = get_agent(agent_id)
    if agent is None:
        raise ValueError(f"unknown agent {agent_id!r}")
    return canonical(agent["url"]) if agent["url"] else BuiltinTarget.name


def agent_for_target(raw: str | None) -> dict | None:
    """`{id, name}` of the agent whose canonical target matches `raw` (a `run.json.target`, stored verbatim), or None.

    Both sides are normalised, so the README's bare `http://127.0.0.1:8790` and the loop's `http:http://…`
    join to the same row. A row the user named wins over the synthetic `example` row for the same URL. A
    malformed target string joins nothing rather than raising.
    """
    if not raw:
        raw = BuiltinTarget.name
    try:
        wanted = canonical(raw)
    except ValueError:
        return None
    rows = list_agents(probe=False)
    # A row the user named wins over the synthetic ones for the same URL.
    for agent in sorted(rows, key=lambda a: a["synthetic"]):
        mine = canonical(agent["url"]) if agent["url"] else BuiltinTarget.name
        if mine == wanted:
            return {"id": agent["id"], "name": agent["name"]}
    return None


# --- ping -----------------------------------------------------------------------------------------


def tool_mapping(tools: list[dict] | None) -> dict | None:
    """`{known, unknown}`: which of the agent's tool names the sandbox storefront serves. None when the agent listed none."""
    if tools is None:
        return None
    known_names = set(storefront_tools())
    names = [t["name"] for t in tools]
    return {"known": [n for n in names if n in known_names], "unknown": [n for n in names if n not in known_names]}


def _fetch_tools(url: str) -> list[dict] | None:
    """`GET <url>/tools` as `[{name, description}]`; None on any failure (the route is optional)."""
    try:
        doc = get_json(f"{url}/tools", TOOLS_TIMEOUT_S)
    except Exception:  # noqa: BLE001 - absent route, refused, timed out, not JSON: all mean "does not list tools"
        return None
    if not isinstance(doc, list):
        return None
    out = []
    for item in doc:
        if isinstance(item, dict) and isinstance(item.get("name"), str):
            out.append({"name": item["name"], "description": item.get("description") if isinstance(item.get("description"), str) else ""})
        elif isinstance(item, str):
            out.append({"name": item, "description": ""})
    return out


def _describe_error(e: Exception) -> str:
    if is_timeout(e):
        return f"timed out after {PING_TIMEOUT_S:.0f}s"
    if isinstance(e, RuntimeError) and str(e) == "redirect":
        return "agent answered with a redirect; Antibody does not follow redirects"
    # HTTPError is a URLError with a `.reason` too, so the status check has to come first.
    if isinstance(e, urllib.error.HTTPError):
        return f"agent answered HTTP {e.code}"
    if isinstance(e, urllib.error.URLError):
        return f"connection failed: {e.reason}"
    if isinstance(e, ValueError):
        return "agent did not answer with JSON"
    return f"{type(e).__name__}: {e}"


def ping(agent: dict) -> dict:
    """`{ok, latency_ms, reply_preview | error, tools, mapping}` for one agent row; persists `last_ping`/`tools` on stored rows.

    The built-in agent has no URL; it is always reachable (it runs in the loop process) and lists the
    storefront's own tools.
    """
    if agent["url"] is None:
        tools = [{"name": n, "description": ""} for n in storefront_tools()]
        return {"ok": True, "latency_ms": 0, "reply_preview": None, "tools": tools, "mapping": tool_mapping(tools)}
    url = agent["url"].rstrip("/")
    body = {
        "session_id": secrets.token_urlsafe(16),
        "message": HELLO_MESSAGE,
        "customer_id": PING_CUSTOMER_ID,
        "customer_email": _customer_email(PING_CUSTOMER_ID),
        "tools_url": PING_TOOLS_URL,
    }
    t0 = time.monotonic()
    try:
        response = post_json(f"{url}/episode", body, PING_TIMEOUT_S)
    except Exception as e:  # noqa: BLE001 - every transport failure is a ping result, never a 500
        result: dict = {"ok": False, "latency_ms": int((time.monotonic() - t0) * 1000), "error": _describe_error(e)}
    else:
        latency = int((time.monotonic() - t0) * 1000)
        reply = response.get("reply") if isinstance(response, dict) else None
        if isinstance(reply, str):
            result = {"ok": True, "latency_ms": latency, "reply_preview": " ".join(reply.split())[:REPLY_PREVIEW_CHARS]}
        else:
            result = {"ok": False, "latency_ms": latency, "error": 'agent returned no reply: expected {"reply": "..."}'}
    # No tool listing when the hello already failed: a black-hole host would cost another 2 s for nothing.
    tools = _fetch_tools(url) if result["ok"] else None
    result["tools"] = tools
    result["mapping"] = tool_mapping(tools)
    _record_ping(agent["id"], result)
    return result


def _record_ping(agent_id: str, result: dict) -> None:
    """`last_ping: {at, ok, latency_ms}` and `tools` on the stored row; synthetic rows have nowhere to keep it."""
    if agent_id in RESERVED_IDS:
        return
    with _store_lock:
        rows = _read()
        for row in rows:
            if row["id"] == agent_id:
                row["last_ping"] = {"at": datetime.now(timezone.utc).isoformat(), "ok": result["ok"], "latency_ms": result["latency_ms"]}
                row["tools"] = result["tools"]
                _write(rows)
                return
