from __future__ import annotations as _annotations

from pydantic import BaseModel


class AirlineAgentContext(BaseModel):
    """Context for airline customer service agents: one per Antibody session, read and written by the tools."""

    passenger_name: str | None = None
    confirmation_number: str | None = None
    seat_number: str | None = None
    flight_number: str | None = None
    account_number: str | None = None
    itinerary: list[dict[str, str]] | None = None
    baggage_claim_id: str | None = None
    compensation_case_id: str | None = None
    scenario: str | None = None
    vouchers: list[str] | None = None
    special_service_note: str | None = None
    origin: str | None = None
    destination: str | None = None


def create_initial_context() -> AirlineAgentContext:
    """Starts empty; values are populated during the conversation."""
    return AirlineAgentContext()
