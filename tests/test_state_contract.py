from __future__ import annotations

import unittest

from factory.state_contract import (
    HUMAN_RESERVED_STATES,
    TERMINAL_STATES,
    autonomy_default,
    decide_transition,
)


class StateContractTests(unittest.TestCase):
    def decision(self, **overrides):
        value = {
            "from_state": "queued", "to_state": "leased", "actor": "scheduler",
            "event_id": "event-1", "event_sequence": 2, "current_sequence": 1,
        }
        value.update(overrides)
        return decide_transition(**value)

    def test_legal_transition_is_accepted(self):
        self.assertEqual(self.decision().outcome, "accepted")

    def test_illegal_and_wrong_actor_transitions_fail_closed(self):
        self.assertEqual(self.decision(to_state="pr-merged").reason, "illegal_or_unauthorized_transition")
        self.assertEqual(self.decision(actor="workflow").reason, "illegal_or_unauthorized_transition")

    def test_replayed_and_stale_events_are_rejected(self):
        self.assertEqual(self.decision(seen_event_ids={"event-1"}).reason, "replayed_event")
        self.assertEqual(self.decision(event_sequence=1).reason, "stale_event")

    def test_human_reserved_states_are_not_agent_exitable(self):
        self.assertEqual(self.decision(from_state="needs-human", to_state="proposed", actor="workflow").outcome, "rejected")
        self.assertEqual(self.decision(from_state="needs-human", to_state="proposed", actor="human-override").outcome, "accepted")
        self.assertEqual(self.decision(from_state="stopped", to_state="queued", actor="workflow").outcome, "rejected")

    def test_external_pr_changes_use_reconciliation_path(self):
        result = self.decision(from_state="pr-open", to_state="reconciliation-only", actor="external-github")
        self.assertEqual(result.outcome, "accepted")
        self.assertIn("needs-human", HUMAN_RESERVED_STATES)
        self.assertIn("pr-merged", TERMINAL_STATES)

    def test_autonomy_is_separate_and_starts_at_zero(self):
        self.assertEqual(autonomy_default(), 0)


if __name__ == "__main__":
    unittest.main()
