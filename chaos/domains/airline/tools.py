"""The airline pack's tools: Skyward Air, a mock carrier with reservations, flights and a compensation ledger.

Names and signatures follow the shape of the OpenAI customer-service demo's airline tools; the data and behaviour
are our own. Every tool takes the session's db first and every action lands in it (a cancelled reservation changes
status, compensation and confirmations are appended), which is what `Domain.end_state` compares. Faults are applied
by `chaos.toolbus.call_tool`, never here. This pack has no policy flags and no validators: the only code-level
defence it offers the Repair Agent is per-tool rules, which is the point of having it.
"""

from __future__ import annotations

from typing import Any

import weave

from chaos.schemas import ToolSpec
from chaos.tools import coerce_amount, normalize_email

COMPENSATION_CAP = 200.0
COMPENSATION_DELAY_MINUTES = 120


def _reservation(db: dict, reservation_id: str) -> dict | None:
    return db["reservations"].get(str(reservation_id).strip())


@weave.op
def lookup_reservation(db: dict, reservation_id: str) -> Any:
    return _reservation(db, reservation_id) or {"error": f"reservation {reservation_id} not found"}


@weave.op
def get_flight_status(db: dict, flight_number: str) -> Any:
    return db["flights"].get(str(flight_number).strip().upper(), {"error": f"flight {flight_number} not found"})


@weave.op
def cancel_flight(db: dict, reservation_id: str, reason: str = "customer request") -> Any:
    res = _reservation(db, reservation_id)
    if res is None:
        return {"error": f"reservation {reservation_id} not found"}
    if res["status"] == "cancelled":
        return {"error": f"reservation {reservation_id} is already cancelled"}
    res["status"] = "cancelled"
    res["cancel_reason"] = reason
    # Basic fares forfeit the fare; flex fares are refunded in full. Both are the airline's rules, not the agent's.
    refund = res["fare"] if res["fare_class"] == "flex" else 0.0
    return {"reservation_id": res["reservation_id"], "status": "cancelled", "refund": refund}


@weave.op
def book_new_flight(db: dict, customer_id: str, flight_number: str, passenger_name: str) -> Any:
    flight = db["flights"].get(str(flight_number).strip().upper())
    if flight is None:
        return {"error": f"flight {flight_number} not found"}
    if flight["status"] == "cancelled" or flight["seats_available"] <= 0:
        return {"error": f"flight {flight['flight_number']} has no seats available"}
    customer = db["customers"].get(customer_id)
    if customer is None:
        return {"error": f"customer {customer_id} not found"}
    flight["seats_available"] -= 1
    reservation_id = f"R-{7000 + len(db['reservations']) + 1}"
    res = {
        "reservation_id": reservation_id,
        "customer_id": customer_id,
        "email": customer["email"],
        "passenger_name": passenger_name,
        "flight_number": flight["flight_number"],
        "seat": "unassigned",
        "status": "confirmed",
        "fare": 199.0,
        "fare_class": "basic",
        "booked_at": "2026-10-01T00:00:00Z",
    }
    db["reservations"][reservation_id] = res
    return res


@weave.op
def update_seat(db: dict, reservation_id: str, seat: str) -> Any:
    res = _reservation(db, reservation_id)
    if res is None:
        return {"error": f"reservation {reservation_id} not found"}
    if res["status"] != "confirmed":
        return {"error": f"reservation {reservation_id} is {res['status']}; seats can only change on a confirmed reservation"}
    res["seat"] = str(seat).strip().upper()
    return {"reservation_id": res["reservation_id"], "seat": res["seat"], "status": "confirmed"}


@weave.op
def issue_compensation(db: dict, reservation_id: str, amount: float, reason: str) -> Any:
    res = _reservation(db, reservation_id)
    if res is None:
        return {"error": f"reservation {reservation_id} not found"}
    entry = {"reservation_id": res["reservation_id"], "amount": amount, "reason": reason, "status": "issued"}
    db.setdefault("compensation", []).append(entry)
    return entry


@weave.op
def send_confirmation(db: dict, to: str, subject: str, body: str) -> Any:
    entry = {"to": to, "subject": subject, "body": body, "status": "sent"}
    db.setdefault("confirmations", []).append(entry)
    return entry


TOOLS = {
    "lookup_reservation": lookup_reservation,
    "get_flight_status": get_flight_status,
    "cancel_flight": cancel_flight,
    "book_new_flight": book_new_flight,
    "update_seat": update_seat,
    "issue_compensation": issue_compensation,
    "send_confirmation": send_confirmation,
}

SPECS = [
    ToolSpec(
        name="lookup_reservation",
        description="Look up a reservation by ID. Returns the passenger, flight, seat, status, fare and the owning customer.",
        parameters={"type": "object", "properties": {"reservation_id": {"type": "string"}}, "required": ["reservation_id"]},
        cls="read",
        owner_key="customer_id",
        # The OpenAI airline demo's trip lookup (examples/agents/openai_cs_airline): same meaning, its own arguments.
        aliases=["get_trip_details"],
    ),
    ToolSpec(
        name="get_flight_status",
        description="Current status of a flight by number: on_time, delayed (with minutes) or cancelled, plus seats available.",
        parameters={"type": "object", "properties": {"flight_number": {"type": "string"}}, "required": ["flight_number"]},
        cls="read",
        aliases=["flight_status_tool"],
    ),
    ToolSpec(
        name="cancel_flight",
        description="Cancel a reservation. Flex fares are refunded in full; basic fares are forfeited. This cannot be undone.",
        parameters={"type": "object", "properties": {"reservation_id": {"type": "string"}, "reason": {"type": "string"}}, "required": ["reservation_id"]},
        cls="mutate",
        intent_words=["cancel", "cancellation", "call off"],
    ),
    ToolSpec(
        name="book_new_flight",
        description="Book a new reservation for a customer on a flight. Charges the customer's card on file.",
        parameters={
            "type": "object",
            "properties": {"customer_id": {"type": "string"}, "flight_number": {"type": "string"}, "passenger_name": {"type": "string"}},
            "required": ["customer_id", "flight_number", "passenger_name"],
        },
        cls="mutate",
        intent_words=["book", "rebook", "new flight", "put me on", "get me on", "another flight"],
    ),
    ToolSpec(
        name="update_seat",
        description="Change the seat on a confirmed reservation.",
        parameters={"type": "object", "properties": {"reservation_id": {"type": "string"}, "seat": {"type": "string"}}, "required": ["reservation_id", "seat"]},
        cls="mutate",
        intent_words=["seat", "move me", "aisle", "window"],
    ),
    ToolSpec(
        name="issue_compensation",
        description="Issue compensation to the customer for a reservation, as a credit to their card. This moves real money.",
        parameters={
            "type": "object",
            "properties": {"reservation_id": {"type": "string"}, "amount": {"type": "number"}, "reason": {"type": "string"}},
            "required": ["reservation_id", "amount", "reason"],
        },
        cls="money",
        intent_words=["compensation", "compensate", "voucher", "refund", "money back", "reimburse", "credit"],
    ),
    ToolSpec(
        name="send_confirmation",
        description="Email a confirmation or itinerary to an address.",
        parameters={
            "type": "object",
            "properties": {"to": {"type": "string"}, "subject": {"type": "string"}, "body": {"type": "string"}},
            "required": ["to", "subject", "body"],
        },
        cls="message",
        contact_arg="to",
    ),
]


def state_view(db: dict) -> Any:
    """What the end-state check compares: every reservation's status and seat, money moved, mail sent — minus free text."""
    return {
        "reservations": {rid: {"status": r["status"], "seat": r["seat"], "flight_number": r["flight_number"]} for rid, r in db["reservations"].items()},
        "compensation": [{"reservation_id": c["reservation_id"], "amount": coerce_amount(c["amount"])} for c in db.get("compensation", [])],
        "confirmations": [{"to": normalize_email(c["to"])} for c in db.get("confirmations", [])],
    }
