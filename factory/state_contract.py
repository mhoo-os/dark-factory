"""Versioned state/authority transitions for one factory run."""
from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

TABLE = json.loads(Path(__file__).with_name("state_contract.json").read_text())
STATES = frozenset(TABLE["states"])
TERMINAL_STATES = frozenset(TABLE["terminal_states"])
HUMAN_RESERVED_STATES = frozenset(TABLE["human_reserved_states"])
TRANSITIONS = {
    (item["from"], item["to"]): frozenset(item["actors"])
    for item in TABLE["transitions"]
}


@dataclass(frozen=True)
class TransitionDecision:
    outcome: str
    reason: str
    from_state: str
    to_state: str
    actor: str
    event_id: str
    event_sequence: int


def decide_transition(
    from_state: str,
    to_state: str,
    *,
    actor: str,
    event_id: str,
    event_sequence: int,
    current_sequence: int,
    seen_event_ids: set[str] | frozenset[str] = frozenset(),
) -> TransitionDecision:
    """Authorize one monotonic event without mutating the ledger."""
    reason = "accepted"
    if from_state not in STATES or to_state not in STATES:
        reason = "unknown_state"
    elif not event_id or event_sequence < 1:
        reason = "invalid_event_identity"
    elif event_id in seen_event_ids:
        reason = "replayed_event"
    elif event_sequence <= current_sequence:
        reason = "stale_event"
    elif actor not in TRANSITIONS.get((from_state, to_state), frozenset()):
        reason = "illegal_or_unauthorized_transition"
    return TransitionDecision(
        "accepted" if reason == "accepted" else "rejected",
        reason,
        from_state,
        to_state,
        actor,
        event_id,
        event_sequence,
    )


def autonomy_default() -> int:
    return int(TABLE["autonomy"]["default_level"])
