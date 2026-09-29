"""Imported incidents (docs/plans/09-roadmap-v1.md §3): a real support conversation as a regression scenario.

Seed and legit scenarios live in the domain packs (`chaos/domains/<name>/attacks.json`, `tasks.json`) and are
reached through `chaos.domains.load_domain(name).seeds` / `.legit`.
"""

from __future__ import annotations

from chaos.domains import active_domain, forbidden_calls_for
from chaos.schemas import Scenario, ScenarioKind

CUSTOMER_PREFIXES = ("customer:", "user:", "> ")
AGENT_PREFIXES = ("agent:", "assistant:", "bot:")
IMPORT_MAX_CHARS = 20_000


def from_transcript(text: str, *, kind: ScenarioKind, title: str = "", customer_id: str | None = None) -> Scenario:
    """A real support conversation as a regression scenario: the customer's turns become `user_message`.

    Lines starting `Customer:` / `User:` / `> ` are the customer; `Agent:` / `Assistant:` / `Bot:` are the agent
    and are dropped (the target under test writes its own replies). A line with neither prefix continues the
    previous speaker. Pass/fail comes from the chosen attack family of the active pack, never from the transcript;
    the customer defaults to the pack's first legit task's. The id is a hash of the customer text, so re-importing
    the same incident is one row. ValueError when there is no customer turn or the paste is over `IMPORT_MAX_CHARS`.
    """
    import hashlib

    if len(text) > IMPORT_MAX_CHARS:
        raise ValueError(f"transcript is over {IMPORT_MAX_CHARS:,} characters")
    turns: list[str] = []
    speaker: str | None = None
    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            continue
        low = line.lower()
        if any(low.startswith(p) for p in CUSTOMER_PREFIXES):
            body = (line[2:] if line.startswith("> ") else line.split(":", 1)[1]).strip()
            # Consecutive customer lines are one message: `>`-quoted pastes put a prefix on every line.
            if speaker == "customer" and turns:
                turns[-1] = f"{turns[-1]}\n{body}"
            else:
                turns.append(body)
            speaker = "customer"
        elif any(low.startswith(p) for p in AGENT_PREFIXES):
            speaker = "agent"
        elif speaker == "customer" and turns:
            turns[-1] = f"{turns[-1]}\n{line}"
    turns = [t for t in turns if t]
    if not turns:
        raise ValueError("no customer turn found: prefix the customer's lines with `Customer:` (or `>`)")
    domain = active_domain()
    try:
        family = domain.family(kind)
    except KeyError:
        raise ValueError(f"the {domain.name} pack has no {kind!r} family; one of {[f.name for f in domain.families]}") from None
    message = "\n\n".join(turns)
    digest = hashlib.sha1(message.encode()).hexdigest()[:10]
    return Scenario(
        id=f"imported-{digest}",
        kind=kind,
        title=(title.strip() or turns[0].splitlines()[0])[:80],
        user_message=message,
        customer_id=customer_id or (domain.legit[0].customer_id if domain.legit else "cust_owen"),
        expected_behavior=family.expected_behavior,
        forbidden_calls=forbidden_calls_for(domain, kind),
        attacker_goal="imported from a real conversation",
        origin="imported",
    )
