from __future__ import annotations

import hashlib
import hmac
import json
import unittest

from factory.ingress import MAX_PAYLOAD_BYTES, accept_webhook
from factory.ledger import Ledger
import sqlite3


SECRET = b"test-only-webhook-secret"
NOW = 1_757_376_000.0


class MemoryQueue:
    def __init__(self):
        self.messages: list[dict[str, object]] = []

    def enqueue(self, message):
        if message["event_id"] not in {item["event_id"] for item in self.messages}:
            self.messages.append(dict(message))


class FailingQueue:
    def enqueue(self, message):
        raise OSError("queue unavailable")


def linear_request(event_id="linear-evt-1", *, timestamp=None):
    body = json.dumps({"action": "update", "data": {"id": "issue-1"}}, separators=(",", ":")).encode()
    signature = hmac.new(SECRET, body, hashlib.sha256).hexdigest()
    headers = {
        "Linear-Delivery": event_id, "Linear-Event": "Issue", "Linear-Signature": signature,
        "Linear-Timestamp": str(int((NOW if timestamp is None else timestamp) * 1000)),
    }
    return headers, body


def github_request(event_id="github-evt-1"):
    body = json.dumps({"action": "opened", "repository": {"full_name": "mhoo-os/dark-factory"}}, separators=(",", ":")).encode()
    signature = hmac.new(SECRET, body, hashlib.sha256).hexdigest()
    headers = {
        "X-GitHub-Delivery": event_id, "X-GitHub-Event": "pull_request",
        "X-Hub-Signature-256": f"sha256={signature}",
    }
    return headers, body


class IngressTests(unittest.TestCase):
    def setUp(self):
        self.connection = sqlite3.connect(":memory:")
        self.ledger = Ledger(self.connection)
        self.queue = MemoryQueue()

    def tearDown(self):
        self.connection.close()

    def test_valid_linear_delivery_is_durable_before_ack_and_duplicate_is_logical_noop(self):
        headers, body = linear_request()
        first = accept_webhook("linear", headers, body, SECRET, ledger=self.ledger, queue=self.queue, now=NOW)
        second = accept_webhook("linear", headers, body, SECRET, ledger=self.ledger, queue=self.queue, now=NOW)
        self.assertEqual((first.status, first.outcome), (202, "accepted"))
        self.assertEqual((second.status, second.outcome), (200, "duplicate"))
        self.assertEqual(len(self.queue.messages), 1)
        self.assertEqual(self.ledger.ingress("linear-evt-1")["handoff_state"], "enqueued")

    def test_invalid_signature_never_reaches_queue(self):
        headers, body = linear_request()
        headers["Linear-Signature"] = "0" * 64
        result = accept_webhook("linear", headers, body, SECRET, ledger=self.ledger, queue=self.queue, now=NOW)
        self.assertEqual(result.status, 401)
        self.assertEqual(self.queue.messages, [])
        self.assertEqual(self.ledger.pending_ingress(), [])

    def test_linear_timestamp_and_event_shape_are_bounded(self):
        headers, body = linear_request(timestamp=NOW - 61)
        expired = accept_webhook("linear", headers, body, SECRET, ledger=self.ledger, queue=self.queue, now=NOW)
        malformed = accept_webhook("linear", headers, b"not-json", SECRET, ledger=self.ledger, queue=self.queue, now=NOW)
        self.assertEqual(expired.reason, "linear_timestamp_expired")
        self.assertEqual(malformed.status, 400)
        self.assertEqual(self.queue.messages, [])

    def test_github_uses_prefixed_signature_and_normalizes_only_supported_event(self):
        headers, body = github_request()
        result = accept_webhook("github", headers, body, SECRET, ledger=self.ledger, queue=self.queue, now=NOW)
        self.assertEqual(result.status, 202)
        self.assertEqual(self.queue.messages[0]["selectors"], {"repository": "mhoo-os/dark-factory"})

        unsupported = dict(headers, **{"X-GitHub-Event": "push", "X-GitHub-Delivery": "github-evt-2"})
        result = accept_webhook("github", unsupported, body, SECRET, ledger=self.ledger, queue=self.queue, now=NOW)
        self.assertEqual(result.reason, "unsupported_github_event")
        self.assertEqual(len(self.queue.messages), 1)

    def test_payload_limit_and_queue_failure_leave_a_retryable_outbox(self):
        headers, body = linear_request(event_id="linear-evt-large")
        oversized = body + (b" " * (MAX_PAYLOAD_BYTES - len(body) + 1))
        too_large = accept_webhook("linear", headers, oversized, SECRET, ledger=self.ledger, queue=self.queue, now=NOW)
        self.assertEqual(too_large.reason, "payload_too_large")

        headers, body = linear_request(event_id="linear-evt-pending")
        failed = accept_webhook("linear", headers, body, SECRET, ledger=self.ledger, queue=FailingQueue(), now=NOW)
        self.assertEqual((failed.status, failed.outcome), (503, "retry"))
        self.assertEqual(self.ledger.ingress("linear-evt-pending")["handoff_state"], "pending")
        self.assertEqual(len(self.ledger.pending_ingress()), 1)


if __name__ == "__main__":
    unittest.main()
