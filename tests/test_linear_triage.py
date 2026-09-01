from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path
from factory.admission import contract_block


MODULE_PATH = Path(__file__).parents[1] / "factory" / "linear_triage.py"
SPEC = importlib.util.spec_from_file_location("linear_triage", MODULE_PATH)
assert SPEC and SPEC.loader
triage = importlib.util.module_from_spec(SPEC)
sys.modules["linear_triage"] = triage
SPEC.loader.exec_module(triage)


def issue(**overrides):
    value = {
        "id": "uuid", "identifier": "MHO-1", "title": "Candidate", "url": "https://linear.app/mhoo/issue/MHO-1", "priority": 3,
        "project": {"id": triage.PROJECT_ID},
        "state": {"id": "in-progress", "name": "In Progress", "type": "started"},
        "labels": {"nodes": []},
    }
    value.update(overrides)
    value["description"] = contract_block({
        "contract_version": "v1", "dispatch_id": f"{value['identifier']}@r1",
        "linear": {"project_id": triage.PROJECT_ID, "issue_id": value["id"], "identifier": value["identifier"], "planning_revision": "r1", "planning_fingerprint": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},
        "target": {"repository": "mhoo-os/dark-factory", "work_type": "implementation", "execution_profile": "python-tests-v1", "collision_group": "dark-factory-runtime", "base_sha": "0123456789abcdef0123456789abcdef01234567"},
        "dependencies": [], "risk": {"risk_class": "low", "authority_class": "repository-local"},
        "acceptance_criteria": ["Candidate is explicit"], "validation_profile": "python-tests-v1",
        "allowed_scope": {"paths": ["factory/**"], "max_files": 2, "max_changed_lines": 20},
        "merge_policy": "human", "stale_conditions": ["planning_revision_changed", "planning_fingerprint_changed", "base_sha_changed"],
    })
    return value


class CandidateTests(unittest.TestCase):
    def test_extracts_an_active_candidate_to_the_factory_intake(self):
        candidate = triage.candidate_from(issue())
        self.assertEqual(candidate.repository, "mhoo-os/dark-factory")
        self.assertEqual(candidate.candidate_key, "MHO-1@r1")

    def test_rejects_an_inactive_candidate(self):
        bad = issue(state={"id": "done", "name": "Done", "type": "completed"})
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
