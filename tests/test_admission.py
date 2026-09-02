from __future__ import annotations

import copy
import json
from pathlib import Path
import unittest

from factory.admission import admit_linear_issue, contract_block


ROOT = Path(__file__).parents[1]
CASE = json.loads((ROOT / "tests/fixtures/admission_cases.json").read_text())["valid"]
PROJECT_ID = CASE["project_id"]


def valid_issue() -> dict[str, object]:
    issue = copy.deepcopy(CASE["issue"])
    issue["description"] = contract_block(CASE["contract"])
    return issue


class AdmissionTests(unittest.TestCase):
    def test_positive_fixture_materializes_stable_contract_and_digest(self) -> None:
        first = admit_linear_issue(valid_issue(), expected_project_id=PROJECT_ID)
        second = admit_linear_issue(valid_issue(), expected_project_id=PROJECT_ID)
        self.assertEqual(first.outcome, "admitted")
        self.assertEqual(first.dispatch_id, "MHO-900@r1")
        self.assertEqual(first.digest, second.digest)
        self.assertEqual(first.contract.to_dict(), CASE["contract"])

    def test_missing_or_ambiguous_repository_fails_closed(self) -> None:
        missing = copy.deepcopy(CASE["contract"])
        missing["target"].pop("repository")
        issue = copy.deepcopy(CASE["issue"])
        issue["description"] = contract_block(missing)
        self.assertEqual(admit_linear_issue(issue, expected_project_id=PROJECT_ID).outcome, "not-admitted")

        ambiguous = copy.deepcopy(CASE["contract"])
        ambiguous["target"]["repository"] = ["mhoo-os/dark-factory", "mhoo-os/other"]
        issue["description"] = contract_block(ambiguous)
        self.assertIn("target.repository.string", admit_linear_issue(issue, expected_project_id=PROJECT_ID).reasons)

    def test_project_identity_and_replayed_event_are_rejected(self) -> None:
        issue = valid_issue()
        issue["project"] = {"id": "another-project"}
        self.assertIn("issue_not_in_expected_project", admit_linear_issue(issue, expected_project_id=PROJECT_ID).reasons)
        self.assertIn(
            "replayed_event",
            admit_linear_issue(valid_issue(), expected_project_id=PROJECT_ID, event_id="evt-1", seen_event_ids={"evt-1"}).reasons,
        )

    def test_duplicate_and_conflicting_admissions_are_not_silent(self) -> None:
        admitted = admit_linear_issue(valid_issue(), expected_project_id=PROJECT_ID)
        self.assertEqual(
            admit_linear_issue(valid_issue(), expected_project_id=PROJECT_ID, existing_dispatch_ids={admitted.dispatch_id}).outcome,
            "not-admitted",
        )
        conflict = admit_linear_issue(
            valid_issue(),
            expected_project_id=PROJECT_ID,
            existing_issue_dispatches={"issue-900": (("MHO-900@older", "sha256:old"),)},
        )
        self.assertEqual(conflict.outcome, "needs-human")

    def test_changed_planning_revision_needs_replan(self) -> None:
        decision = admit_linear_issue(valid_issue(), expected_project_id=PROJECT_ID, current_planning_revision="r2")
        self.assertEqual(decision.outcome, "needs-replan")
        self.assertNotIn("execution_failed", decision.reasons)

    def test_high_risk_or_cross_system_contract_needs_human(self) -> None:
        contract = copy.deepcopy(CASE["contract"])
        contract["risk"]["authority_class"] = "cross-system"
        issue = copy.deepcopy(CASE["issue"])
        issue["description"] = contract_block(contract)
        self.assertEqual(admit_linear_issue(issue, expected_project_id=PROJECT_ID).outcome, "needs-human")


if __name__ == "__main__":
    unittest.main()
