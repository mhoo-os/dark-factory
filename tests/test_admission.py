from __future__ import annotations

import copy
from datetime import datetime, timezone
import json
from pathlib import Path
import unittest

from factory.admission import admit_linear_issue, contract_block


ROOT = Path(__file__).parents[1]
CASE = json.loads((ROOT / "tests/fixtures/admission_cases.json").read_text())["valid"]
PROJECT_ID = CASE["project_id"]
NOW = datetime(2026, 9, 5, 6, 0, tzinfo=timezone.utc)
CHECKOUT_HEAD = "fedcba9876543210fedcba9876543210fedcba98"


def valid_issue() -> dict[str, object]:
    issue = copy.deepcopy(CASE["issue"])
    issue["description"] = contract_block(CASE["contract"])
    return issue


def dry_run_issue() -> dict[str, object]:
    contract = copy.deepcopy(CASE["contract"])
    contract["allowed_scope"] = {"paths": [], "max_files": 0, "max_changed_lines": 0}
    contract["dry_run_authorization"] = {
        "authorization_id": "MHO-900-b5-receipt",
        "mode": "approved-intake",
        "non_executable": True,
        "expires_at": "2026-09-05T06:10:00Z",
        "checkout_head_sha": CHECKOUT_HEAD,
    }
    issue = copy.deepcopy(CASE["issue"])
    issue["description"] = contract_block(contract)
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

    def test_dry_run_authorization_requires_explicit_mode_and_exact_clean_head(self) -> None:
        blocked = admit_linear_issue(dry_run_issue(), expected_project_id=PROJECT_ID, now=NOW)
        self.assertEqual(blocked.reasons, ("dry_run_authorization_requires_dry_run",))

        admitted = admit_linear_issue(
            dry_run_issue(),
            expected_project_id=PROJECT_ID,
            allow_dry_run_authorization=True,
            current_checkout_head=CHECKOUT_HEAD,
            now=NOW,
        )
        self.assertEqual(admitted.outcome, "admitted")
        self.assertEqual(admitted.contract.dry_run_authorization["authorization_id"], "MHO-900-b5-receipt")

        mismatch = admit_linear_issue(
            dry_run_issue(),
            expected_project_id=PROJECT_ID,
            allow_dry_run_authorization=True,
            current_checkout_head="0123456789abcdef0123456789abcdef01234567",
            now=NOW,
        )
        self.assertEqual(mismatch.reasons, ("dry_run_authorization_checkout_head_mismatch",))

    def test_linear_self_link_serialization_canonicalizes_before_identity_and_digest(self) -> None:
        linked = valid_issue()
        linked_contract = json.loads(linked["description"].split("\n")[1])
        linked_contract["linear"]["identifier"] = "[MHO-900](https://linear.app/mhoo/issue/MHO-900/example)"
        linked_contract["dispatch_id"] = "[MHO-900](https://linear.app/mhoo/issue/MHO-900/example)@r1"
        linked["description"] = contract_block(linked_contract)
        direct = admit_linear_issue(valid_issue(), expected_project_id=PROJECT_ID)
        normalized = admit_linear_issue(linked, expected_project_id=PROJECT_ID)
        self.assertEqual(normalized.outcome, "admitted")
        self.assertEqual(normalized.digest, direct.digest)

    def test_linear_self_link_serialization_canonicalizes_dry_run_authorization(self) -> None:
        linked = dry_run_issue()
        linked_contract = json.loads(linked["description"].split("\n")[1])
        link = "[MHO-900](https://linear.app/mhoo/issue/MHO-900/example)"
        linked_contract["linear"]["identifier"] = link
        linked_contract["dispatch_id"] = f"{link}@r1"
        linked_contract["dry_run_authorization"]["authorization_id"] = f"{link}-b5-receipt"
        linked["description"] = contract_block(linked_contract)
        decision = admit_linear_issue(
            linked,
            expected_project_id=PROJECT_ID,
            allow_dry_run_authorization=True,
            current_checkout_head=CHECKOUT_HEAD,
            now=NOW,
        )
        self.assertEqual(decision.outcome, "admitted")
        self.assertEqual(decision.dispatch_id, "MHO-900@r1")
        self.assertEqual(decision.contract.dry_run_authorization["authorization_id"], "MHO-900-b5-receipt")


if __name__ == "__main__":
    unittest.main()
