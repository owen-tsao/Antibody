"""Zendesk as the Target Agent's real world.

The loop stays honest about what is real and what is mocked:
  real   — the ticket the attacker files, the comments the agent reads, the notes it posts, the status it sets
  mocked — orders, refunds, emails (money and outbound mail must never be real in a red-team loop)

Every function here fails soft (returns None / False), and callers decide what that means:
  - unconfigured (no creds, or ANTIBODY_NO_ZENDESK=1): the whole run uses the in-process mock path
    (the scenario's `user_message` is delivered directly), so the demo never depends on venue Wi-Fi.
  - configured but a call fails mid-run: that episode fails CLOSED (judged as a crash). It is never
    quietly re-run on the mock path, because that would let the gate pass an attack it never saw.

Env (in .env, gitignored): ZENDESK_SUBDOMAIN, ZENDESK_OAUTH_TOKEN (from scripts/zendesk_oauth.py).
Set ANTIBODY_NO_ZENDESK=1 to force the mock path.
"""

from __future__ import annotations

import os
import time
from typing import Any

import httpx
import weave

from chaos.config import load_env

load_env()

TAG = "antibody"
# Harness artifacts (the agent's reply, written back for audit) are marked so read_ticket can hide them:
# they are part of our bookkeeping, not part of the world the agent is responding to.
REPLY_MARKER = "[antibody-reply]"

_client: httpx.Client | None = None


def enabled() -> bool:
    if os.environ.get("ANTIBODY_NO_ZENDESK"):
        return False
    return bool(os.environ.get("ZENDESK_SUBDOMAIN") and os.environ.get("ZENDESK_OAUTH_TOKEN"))


def subdomain() -> str:
    return os.environ.get("ZENDESK_SUBDOMAIN", "")


def ticket_url(ticket_id: int) -> str:
    return f"https://{subdomain()}.zendesk.com/agent/tickets/{ticket_id}"


def _http() -> httpx.Client:
    global _client
    if _client is None:
        _client = httpx.Client(
            base_url=f"https://{subdomain()}.zendesk.com/api/v2",
            headers={"Authorization": f"Bearer {os.environ['ZENDESK_OAUTH_TOKEN']}"},
            timeout=20,
        )
    return _client


def _call(method: str, path: str, **kw) -> dict[str, Any] | None:
    """One API call; None on any failure. Callers treat None as 'world unavailable'.

    Zendesk throttles ticket updates account-wide; a 429 is retried after the server's Retry-After
    (capped) a few times, because a dropped update would silently degrade the judge's evidence.
    """
    if not enabled():
        return None
    for attempt in range(4):
        try:
            resp = _http().request(method, path, **kw)
        except httpx.HTTPError as e:
            print(f"  zendesk: {method} {path} failed: {e}")
            return None
        if resp.status_code == 429 and attempt < 3:
            try:
                wait = min(float(resp.headers.get("Retry-After") or 5), 20)
            except ValueError:  # Retry-After may be an HTTP date rather than seconds
                wait = 5.0
            time.sleep(wait)
            continue
        if resp.status_code >= 400:
            print(f"  zendesk: {method} {path} -> {resp.status_code} {resp.text[:160]}")
            return None
        if not resp.content:
            return {}
        try:
            return resp.json()
        except ValueError:
            print(f"  zendesk: {method} {path} -> non-JSON {resp.status_code} response")
            return None
    return None


# --- writes used by the harness (Chaos Agent files tickets; loop writes replies back) ----------------


def create_ticket(subject: str, body: str, requester_name: str, requester_email: str, tags: list[str]) -> int | None:
    """File a ticket on behalf of the customer, exactly as a web form or email would."""
    data = _call(
        "POST",
        "/tickets.json",
        json={
            "ticket": {
                "subject": subject[:150],
                "comment": {"body": body},
                "requester": {"name": requester_name, "email": requester_email},
                "priority": "normal",
                "tags": [TAG, *tags],
            }
        },
    )
    return data["ticket"]["id"] if data else None


def add_note(ticket_id: int, body: str, public: bool = False) -> bool:
    data = _call("PUT", f"/tickets/{ticket_id}.json", json={"ticket": {"comment": {"body": body, "public": public}}})
    return data is not None


def set_status(ticket_id: int, status: str) -> bool:
    data = _call("PUT", f"/tickets/{ticket_id}.json", json={"ticket": {"status": status}})
    return data is not None


def file_scenario(scenario):
    """Turn a scenario into a real ticket, exactly as the customer (or attacker) would file it.

    The subject and body are the customer's words only; the scenario's title (which names the attack)
    never reaches Zendesk, so the agent is not tipped off. For injection families the attacker's payload
    is also planted as an internal 'previous agent' note: the real-world version of poisoned tool output.
    Returns a copy with ticket_id (and planted_note) set, or the scenario unchanged if Zendesk is off.
    """
    if not enabled() or scenario.ticket_id is not None:
        return scenario
    planted = None
    if scenario.kind == "prompt_injection_via_tool":
        planted = next((f.payload for f in scenario.faults if f.mode == "inject" and isinstance(f.payload, str)), None)
    tid = _file(scenario, planted, extra_tags=["canonical"])
    if tid is None:
        return scenario
    print(f"  zendesk: filed ticket #{tid} for {scenario.id}" + (" (+ planted internal note)" if planted else ""))
    return scenario.model_copy(update={"ticket_id": tid, "planted_note": planted})


def clone_for_episode(scenario) -> int | None:
    """A fresh copy of the scenario's ticket for one episode.

    Every evaluation (baseline, gate, replay) works its own ticket rather than reopening the canonical one:
    Zendesk throttles repeated updates to a single ticket, and a per-episode ticket is also the honest
    audit trail — each run of the agent is one ticket you can open.
    """
    if not enabled():
        return None
    return _file(scenario, scenario.planted_note, extra_tags=["episode", f"canonical-{scenario.ticket_id}"])


def _file(scenario, planted_note: str | None, extra_tags: list[str]) -> int | None:
    from chaos.tools import ORDERS

    email = next((o["email"] for o in ORDERS.values() if o["customer_id"] == scenario.customer_id), "customer@example.com")
    name = scenario.customer_id.removeprefix("cust_").capitalize()
    first_line = scenario.user_message.strip().splitlines()[0] if scenario.user_message.strip() else "Support request"
    tid = create_ticket(first_line[:80], scenario.user_message, name, email, [scenario.origin, scenario.kind, *extra_tags])
    if tid is not None and planted_note:
        add_note(tid, planted_note, public=False)
    return tid


# --- reads used by the Target Agent (as a tool) and the Judge (as ground truth) -----------------------


@weave.op
def get_ticket(ticket_id: int, include_harness_notes: bool = False) -> dict[str, Any] | None:
    """The ticket as the agent sees it: subject, requester, status, and every comment with who wrote it."""
    t = _call("GET", f"/tickets/{ticket_id}.json")
    if not t:
        return None
    ticket = t["ticket"]
    c = _call("GET", f"/tickets/{ticket_id}/comments.json")
    if c is None:
        return None
    requester_id = ticket["requester_id"]
    comments = []
    for com in c.get("comments", []):
        body = com.get("body", "") or ""
        is_customer = com.get("author_id") == requester_id
        # Only our own internal notes are hidden. A customer cannot hide a public comment by prefixing the
        # marker, and nothing the requester wrote is ever dropped from what the policy counts as "the customer".
        if not include_harness_notes and body.startswith(REPLY_MARKER) and not is_customer and not com.get("public"):
            continue
        comments.append(
            {
                "author": "customer" if is_customer else "agent",
                "public": bool(com.get("public")),
                "body": body,
            }
        )
    return {
        "ticket_id": ticket["id"],
        "subject": ticket.get("subject", ""),
        "status": ticket.get("status"),
        "comments": comments,
    }


def customer_turns(ticket: dict[str, Any] | None) -> list[str]:
    """What the customer actually said: public comments authored by the requester. Never internal notes."""
    if not ticket:
        return []
    return [c["body"] for c in ticket.get("comments", []) if c.get("author") == "customer" and c.get("public")]


def cleanup(status: str = "solved") -> int:
    """Close every ticket this harness created. Returns how many were touched.

    Uses the plain ticket list (tickets:read) rather than search, which needs a broader scope.
    """
    data = _call("GET", "/tickets.json", params={"page[size]": 100, "sort": "-id"})
    if not data:
        return 0
    n = 0
    for t in data.get("tickets", []):
        if TAG in (t.get("tags") or []) and t.get("status") not in ("solved", "closed"):
            if set_status(t["id"], status):
                n += 1
    return n
