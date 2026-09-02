from __future__ import annotations

import json
from pathlib import Path
import unittest

from factory.recovery import DeadLetter, RunSnapshot, StopStateUnreadable, read_stop_state, reconcile, replay_dead_letter


ROOT = Path(__file__).parents[1]
CASES = json.loads((ROOT / "tests/fixtures/recovery_cases.json").read_text())


def snapshot(name: str) -> RunSnapshot:
    return RunSnapshot(**CASES[name])


class RecoveryTests(unittest.TestCase):
    def test_healthy_reconciliation_is_a_noop(self):
        self.assertEqual(reconcile([snapshot("healthy")], now=100), ())

    def test_killed_workflow_and_stale_lease_are_requeued(self):
        action = reconcile([snapshot("killed_workflow")], now=100)[0]
        self.assertEqual((action.action, action.target_state, action.retry), ("requeue", "queued", True))

    def test_missed_webhook_and_unblocked_dependency_are_reconciled(self):
        actions = reconcile([snapshot("missed_webhook"), snapshot("unblocked")], now=100)
        self.assertEqual([(item.dispatch_id, item.action) for item in actions], [("run-missed", "reconcile-event"), ("run-unblocked", "queue")])

    def test_stop_fails_closed_and_parks_queued_work(self):
        self.assertTrue(read_stop_state(local_present=False, remote_readable=True, remote_present=True))
        action = reconcile([snapshot("stopped")], now=100)[0]
        self.assertEqual((action.action, action.target_state, action.notify), ("stop", "stopped", False))
        with self.assertRaises(StopStateUnreadable):
            read_stop_state(local_present=False, remote_readable=False, remote_present=False)

    def test_retry_cap_creates_actionable_dead_letter(self):
        action = reconcile([snapshot("dead_letter")], now=100)[0]
        self.assertEqual((action.action, action.target_state, action.notify), ("dead-letter", "failed", True))

    def test_dead_letter_replay_preserves_identity_and_deduplicates(self):
        item = DeadLetter("run-dlq", "evt-original", "sha256:payload", "retry_cap_reached", 2)
        self.assertEqual(replay_dead_letter(item, seen_event_ids=set()).outcome, "replay")
        replay = replay_dead_letter(item, seen_event_ids={"evt-original"})
        self.assertEqual((replay.outcome, replay.event_id), ("duplicate", "evt-original"))


if __name__ == "__main__":
    unittest.main()
