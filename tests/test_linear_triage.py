from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).parents[1] / "factory" / "linear_triage.py"
SPEC = importlib.util.spec_from_file_location("linear_triage", MODULE_PATH)
assert SPEC and SPEC.loader
triage = importlib.util.module_from_spec(SPEC)
sys.modules["linear_triage"] = triage
SPEC.loader.exec_module(triage)


def issue(**overrides):
    value = {
        "id": "uuid", "identifier": "MHO-1", "title": "Candidate", "description": "Implementation context", "url": "https://linear.app/mhoo/issue/MHO-1", "priority": 3,
        "state": {"id": "in-progress", "name": "In Progress", "type": "started"},
        "labels": {"nodes": []},
    }
    value.update(overrides)
    return value


class CandidateTests(unittest.TestCase):
    def test_extracts_an_active_candidate_to_the_factory_intake(self):
        candidate = triage.candidate_from(issue())
        self.assertEqual(candidate.repository, "mhoo-os/dark-factory")
        self.assertEqual(candidate.candidate_key, "MHO-1")

    def test_rejects_an_inactive_candidate(self):
        bad = issue(state={"id": "todo", "name": "Todo", "type": "unstarted"})
        with self.assertRaises(triage.TriageError):
            triage.candidate_from(bad)

    def test_selects_higher_priority_candidate(self):
        lower = issue(identifier="MHO-2", priority=4)
        higher = issue(identifier="MHO-3", priority=2)
        self.assertEqual(triage.select([lower, higher]).identifier, "MHO-3")

    def test_marker_is_stable(self):
        candidate = triage.candidate_from(issue())
        self.assertEqual(triage.marker(candidate), triage.marker(candidate))

    def test_pending_candidate_skips_an_existing_intake(self):
        first = issue(identifier="MHO-1", priority=1)
        second = issue(identifier="MHO-2", priority=2)
        original = triage.existing_issue
        try:
            triage.existing_issue = lambda candidate: "https://github.com/mhoo-os/dark-factory/issues/1" if candidate.identifier == "MHO-1" else None
            selected = triage.pending_candidate([first, second])
        finally:
            triage.existing_issue = original
        self.assertIsNotNone(selected)
        self.assertEqual(selected[0].identifier, "MHO-2")


if __name__ == "__main__":
    unittest.main()
