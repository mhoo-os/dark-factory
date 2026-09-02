"""Replay one captured, redacted webhook fixture through the durable handoff."""
from __future__ import annotations

from typing import Any, Mapping

from factory.ingress import WebhookResult, accept_webhook
from factory.ledger import Ledger


def replay_fixture(
    fixture: Mapping[str, Any],
    *,
    secret: bytes,
    ledger: Ledger,
    queue: Any,
    now: float,
) -> WebhookResult:
    """Use only fixture fields; raw payload is never persisted or sent to the queue."""
    body = fixture.get("raw_body")
    headers = fixture.get("headers")
    provider = fixture.get("provider")
    if not isinstance(body, str) or not isinstance(headers, dict) or not isinstance(provider, str):
        return WebhookResult(400, "rejected", "replay_fixture_invalid")
    return accept_webhook(provider, headers, body.encode("utf-8"), secret, ledger=ledger, queue=queue, now=now)
