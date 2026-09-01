"""Signed, bounded webhook ingress with durable outbox handoff."""
from __future__ import annotations

from dataclasses import dataclass
import hashlib
import hmac
import json
from typing import Any, Mapping, Protocol

from factory.ledger import Ledger, LedgerConflict


MAX_PAYLOAD_BYTES = 256 * 1024
LINEAR_MAX_AGE_SECONDS = 60
LINEAR_EVENT_TYPES = frozenset({"Issue"})
GITHUB_EVENT_TYPES = frozenset({"issues", "pull_request", "workflow_run"})


class IngressError(ValueError):
    pass


class QueueSink(Protocol):
    def enqueue(self, message: Mapping[str, Any]) -> None: ...


@dataclass(frozen=True)
class EventEnvelope:
    version: str
    provider: str
    event_id: str
    event_type: str
    action: str
    payload_digest: str
    selectors: Mapping[str, str]

    def message(self) -> dict[str, Any]:
        return {
            "version": self.version, "provider": self.provider, "event_id": self.event_id,
            "event_type": self.event_type, "action": self.action,
            "payload_digest": self.payload_digest, "selectors": dict(self.selectors),
        }


@dataclass(frozen=True)
class WebhookResult:
    status: int
    outcome: str
    reason: str
    event_id: str | None = None


def _header(headers: Mapping[str, str], name: str) -> str | None:
    wanted = name.lower()
    for key, value in headers.items():
        if key.lower() == wanted:
            return value
    return None


def _signature(raw_body: bytes, secret: bytes, supplied: str, *, prefix: str) -> bool:
    if not isinstance(supplied, str) or not isinstance(secret, bytes) or not secret:
        return False
    if not supplied.startswith(prefix):
        return False
    received = supplied[len(prefix):]
    expected = hmac.new(secret, raw_body, hashlib.sha256).hexdigest()
    return len(received) == len(expected) and hmac.compare_digest(received.lower(), expected)


def _json_payload(raw_body: bytes) -> dict[str, Any]:
    if len(raw_body) > MAX_PAYLOAD_BYTES:
        raise IngressError("payload_too_large")
    try:
        value = json.loads(raw_body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise IngressError("payload_invalid_json") from error
    if not isinstance(value, dict):
        raise IngressError("payload_not_object")
    return value


def normalize_event(provider: str, headers: Mapping[str, str], raw_body: bytes, secret: bytes, *, now: float) -> EventEnvelope:
    payload = _json_payload(raw_body)
    provider = provider.lower()
    if provider == "linear":
        event_id = _header(headers, "Linear-Delivery")
        event_type = _header(headers, "Linear-Event")
        signature = _header(headers, "Linear-Signature")
        timestamp = _header(headers, "Linear-Timestamp")
        if not event_id or not event_type or not signature or not timestamp:
            raise IngressError("linear_headers_missing")
        if not _signature(raw_body, secret, signature, prefix=""):
            raise IngressError("invalid_linear_signature")
        try:
            age = abs(now - int(timestamp) / 1000)
        except ValueError as error:
            raise IngressError("linear_timestamp_invalid") from error
        if age > LINEAR_MAX_AGE_SECONDS:
            raise IngressError("linear_timestamp_expired")
        if event_type not in LINEAR_EVENT_TYPES:
            raise IngressError("unsupported_linear_event")
        data = payload.get("data")
        if not isinstance(data, dict) or not isinstance(data.get("id"), str):
            raise IngressError("linear_resource_missing")
        selectors = {"resource_id": data["id"]}
    elif provider == "github":
        event_id = _header(headers, "X-GitHub-Delivery")
        event_type = _header(headers, "X-GitHub-Event")
        signature = _header(headers, "X-Hub-Signature-256")
        if not event_id or not event_type or not signature:
            raise IngressError("github_headers_missing")
        if not _signature(raw_body, secret, signature, prefix="sha256="):
            raise IngressError("invalid_github_signature")
        if event_type not in GITHUB_EVENT_TYPES:
            raise IngressError("unsupported_github_event")
        repository = payload.get("repository")
        full_name = repository.get("full_name") if isinstance(repository, dict) else None
        if not isinstance(full_name, str) or not full_name.startswith("mhoo-os/"):
            raise IngressError("github_repository_missing_or_unsupported")
        selectors = {"repository": full_name}
    else:
        raise IngressError("unsupported_provider")
    action = payload.get("action")
    if not isinstance(action, str) or not action:
        raise IngressError("event_action_missing")
    return EventEnvelope(
        version="v1", provider=provider, event_id=event_id, event_type=event_type,
        action=action, payload_digest="sha256:" + hashlib.sha256(raw_body).hexdigest(), selectors=selectors,
    )


def accept_webhook(
    provider: str,
    headers: Mapping[str, str],
    raw_body: bytes,
    secret: bytes,
    *,
    ledger: Ledger,
    queue: QueueSink,
    now: float,
) -> WebhookResult:
    try:
        envelope = normalize_event(provider, headers, raw_body, secret, now=now)
        receipt = ledger.reserve_ingress(
            envelope.event_id, envelope.provider, envelope.event_type, envelope.payload_digest,
        )
        if receipt.duplicate and receipt.handoff_state == "enqueued":
            return WebhookResult(200, "duplicate", "event_already_handed_off", envelope.event_id)
        queue.enqueue(envelope.message())
        ledger.mark_ingress_enqueued(envelope.event_id)
        return WebhookResult(202, "accepted", "durable_handoff_complete", envelope.event_id)
    except IngressError as error:
        return WebhookResult(401 if "signature" in str(error) or "expired" in str(error) else 400, "rejected", str(error))
    except LedgerConflict as error:
        if str(error) == "ingress_identity_conflict":
            return WebhookResult(409, "rejected", str(error))
        return WebhookResult(503, "retry", "durable_handoff_unavailable")
    except OSError:
        return WebhookResult(503, "retry", "durable_handoff_unavailable")
