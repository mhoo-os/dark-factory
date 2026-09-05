from __future__ import annotations

import copy
from datetime import datetime, timezone
import json
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).parents[1]))
from factory.dispatch_contract import canonical_json, validate_dispatch_contract


FIXTURES = json.loads((Path(__file__).parent / "fixtures/dispatch_contract_cases.json").read_text())
NOW = datetime(2026, 9, 5, 6, 0, tzinfo=timezone.utc)


def dry_run_contract() -> dict[str, object]:
    contract = copy.deepcopy(FIXTURES["valid"])
    contract["allowed_scope"] = {"paths": [], "max_files": 0, "max_changed_lines": 0}
    contract["dry_run_authorization"] = {
        "authorization_id": "MHO-199-b5-receipt",
        "mode": "approved-intake",
        "non_executable": True,
        "expires_at": "2026-09-05T06:10:00Z",
        "repository": "mhoo-os/dark-factory",
        "pr_number": 29,
        "linear_issue": "MHO-199",
        "review_id": "MHOO-RX5-MHO-199-PR29-FINAL",
        "checkout_head_sha": "fedcba9876543210fedcba9876543210fedcba98",
    }
    return contract


class DispatchContractTests(unittest.TestCase):
    def test_positive_fixture_is_admitted_and_digest_is_order_independent(self) -> None:
        result = validate_dispatch_contract(FIXTURES["valid"], supported_profiles={"python-tests-v1"})
        self.assertEqual(result.outcome, "admitted")
        self.assertEqual(result.reasons, ())
        self.assertIsNotNone(result.contract)
        reordered = json.loads(json.dumps(FIXTURES["valid"], sort_keys=True))
        other = validate_dispatch_contract(reordered, supported_profiles={"python-tests-v1"})
        self.assertEqual(result.contract.digest, other.contract.digest)
        self.assertTrue(result.contract.digest.startswith("sha256:"))

    def test_negative_fixtures_fail_closed(self) -> None:
        for name in ("missing_repository", "ambiguous_repository", "duplicate_dependency"):
            with self.subTest(name=name):
                result = validate_dispatch_contract(FIXTURES[name])
                self.assertEqual(result.outcome, "not-admitted")
                self.assertTrue(result.reasons)

    def test_duplicate_and_unsupported_profile_are_not_admitted(self) -> None:
        duplicate = validate_dispatch_contract(FIXTURES["valid"], existing_dispatch_ids={"MHO-199@r1"})
        unsupported = validate_dispatch_contract(FIXTURES["valid"], supported_profiles={"other-v1"})
        self.assertEqual(duplicate.reasons, ("duplicate_dispatch_id",))
        self.assertEqual(unsupported.reasons, ("unsupported_execution_profile",))

    def test_stale_contract_needs_replan_not_execution_failure(self) -> None:
        result = validate_dispatch_contract(FIXTURES["valid"], current_planning_revision="r2")
        self.assertEqual(result.outcome, "needs-replan")
        self.assertIn("stale_planning_revision", result.reasons)
        self.assertNotIn("execution_failed", result.reasons)

    def test_canonical_json_is_compact_and_sorted(self) -> None:
        encoded = canonical_json({"b": 1, "a": "x"})
        self.assertEqual(encoded, '{"a":"x","b":1}')

    def test_short_lived_non_executable_authorization_is_admitted_and_replay_safe(self) -> None:
        contract = dry_run_contract()
        first = validate_dispatch_contract(contract, now=NOW)
        replay = validate_dispatch_contract(copy.deepcopy(contract), now=NOW)
        self.assertEqual(first.outcome, "admitted")
        self.assertEqual(replay.outcome, "admitted")
        self.assertEqual(first.contract.digest, replay.contract.digest)
        self.assertEqual(first.contract.dry_run_authorization["authorization_id"], "MHO-199-b5-receipt")

    def test_dry_run_authorization_fails_closed_for_expiry_mode_and_scope(self) -> None:
        expired = dry_run_contract()
        expired["dry_run_authorization"]["expires_at"] = "2026-09-05T05:59:59Z"
        self.assertEqual(validate_dispatch_contract(expired, now=NOW).reasons, ("dry_run_authorization_expired",))

        wrong_mode = dry_run_contract()
        wrong_mode["dry_run_authorization"]["mode"] = "dispatch"
        self.assertIn("dry_run_authorization.mode.unsupported", validate_dispatch_contract(wrong_mode, now=NOW).reasons)

        executable_scope = dry_run_contract()
        executable_scope["allowed_scope"]["max_files"] = 1
        self.assertIn("dry_run_authorization.allowed_scope.max_files.must_be_zero", validate_dispatch_contract(executable_scope, now=NOW).reasons)

    def test_dry_run_authorization_is_bound_to_contract_identity(self) -> None:
        wrong_repository = dry_run_contract()
        wrong_repository["dry_run_authorization"]["repository"] = "mhoo-os/other"
        self.assertEqual(validate_dispatch_contract(wrong_repository, now=NOW).reasons, ("dry_run_authorization_repository_mismatch",))

        wrong_issue = dry_run_contract()
        wrong_issue["dry_run_authorization"]["linear_issue"] = "MHO-200"
        self.assertEqual(validate_dispatch_contract(wrong_issue, now=NOW).reasons, ("dry_run_authorization_linear_issue_mismatch",))


if __name__ == "__main__":
    unittest.main()
