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
        "id": "uuid", "identifier": "MHO-1", "title": "Candidate", "description": "* Candidate key: `provider:surface`\n* Repository target: `mhoo-os/mhoo-twenty`", "url": "https://linear.app/mhoo/issue/MHO-1", "priority": 3,
        "state": {"id": "todo", "name": "Todo", "type": "unstarted"},
        "labels": {"nodes": [{"name": "Candidate"}, {"name": "Queued"}]},
    }
    value.update(overrides)
    return value


class CandidateTests(unittest.TestCase):
    def test_extracts_a_scoped_candidate(self):
        candidate = triage.candidate_from(issue())
        self.assertEqual(candidate.repository, "mhoo-os/mhoo-twenty")
        self.assertEqual(candidate.candidate_key, "provider:surface")

    def test_rejects_an_unscoped_repository(self):
        bad = issue(description="* Candidate key: `provider:surface`\n* Repository target: `another-org/repo`")
        with self.assertRaises(triage.TriageError):
            triage.candidate_from(bad)

    def test_selects_higher_priority_candidate(self):
        lower = issue(identifier="MHO-2", priority=4)
        higher = issue(identifier="MHO-3", priority=2)
        self.assertEqual(triage.select([lower, higher]).identifier, "MHO-3")

    def test_marker_is_stable(self):
        candidate = triage.candidate_from(issue())
        self.assertEqual(triage.marker(candidate), triage.marker(candidate))


if __name__ == "__main__":
    unittest.main()
