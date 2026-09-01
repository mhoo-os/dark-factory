from __future__ import annotations

import json
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).parents[1]))
from factory.dispatch_contract import canonical_json, validate_dispatch_contract


FIXTURES = json.loads((Path(__file__).parent / "fixtures/dispatch_contract_cases.json").read_text())


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


if __name__ == "__main__":
    unittest.main()
