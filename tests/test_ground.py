from __future__ import annotations

import copy
import json
from pathlib import Path
import unittest

from factory.dispatch_contract import validate_dispatch_contract
from factory.ground import RepositorySnapshot, ground_contract


ROOT = Path(__file__).parents[1]
CASE = json.loads((ROOT / "tests/fixtures/ground_cases.json").read_text())


def contract(value=None):
    result = validate_dispatch_contract(value or CASE["contract"])
    assert result.contract is not None
    return result.contract


def snapshot(value=None):
    return RepositorySnapshot(**(value or CASE["snapshot"]))


class GroundingTests(unittest.TestCase):
    def test_benign_file_movement_is_lowered_and_digest_bound(self):
        first = ground_contract(contract(), snapshot())
        second = ground_contract(contract(), snapshot())
        self.assertEqual(first.outcome, "grounded")
        self.assertEqual(first.path_map, {"factory/old.py": "factory/admission.py"})
        self.assertIn("acceptance:1:Ground the approved contract", first.steps)
        self.assertEqual(first.digest, second.digest)
        self.assertTrue(first.profile_digest.startswith("sha256:"))

    def test_material_contradiction_returns_needs_replan_without_alternative_steps(self):
        observed = copy.deepcopy(CASE["snapshot"])
        observed["contradictions"] = ["planned_touchpoint_missing"]
        result = ground_contract(contract(), snapshot(observed))
        self.assertEqual(result.outcome, "needs-replan")
        self.assertEqual(result.reasons, ("planned_touchpoint_missing",))
        self.assertEqual(result.steps, ())

    def test_base_drift_is_needs_replan(self):
        observed = copy.deepcopy(CASE["snapshot"])
        observed["base_sha"] = "fedcba9876543210fedcba9876543210fedcba98"
        result = ground_contract(contract(), snapshot(observed))
        self.assertEqual(result.reasons, ("base_sha_changed",))

    def test_out_of_scope_file_movement_is_not_silently_lowered(self):
        observed = copy.deepcopy(CASE["snapshot"])
        observed["renames"] = {"factory/old.py": "secrets.txt"}
        result = ground_contract(contract(), snapshot(observed))
        self.assertEqual(result.outcome, "needs-replan")
        self.assertEqual(result.reasons, ("file_movement_outside_declared_scope",))


if __name__ == "__main__":
    unittest.main()
