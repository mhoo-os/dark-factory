from __future__ import annotations

import json
from pathlib import Path
import unittest


ROOT = Path(__file__).parents[1]
REQUIRED_CASES = {
    "prompt-injection-in-issue-body",
    "secret-shaped-sandbox-output",
    "cross-repository-access-denial",
    "forged-webhook-denial",
    "replayed-webhook-denial",
    "stale-lease-write-denial",
}


class ThreatModelFixtureTests(unittest.TestCase):
    def load_cases(self) -> list[dict[str, object]]:
        path = ROOT / "tests/fixtures/threat_model_cases.json"
        return json.loads(path.read_text())

    def test_required_security_cases_are_explicit_and_fail_closed(self) -> None:
        cases = self.load_cases()
        self.assertEqual({case["id"] for case in cases}, REQUIRED_CASES)
        for case in cases:
            with self.subTest(case=case["id"]):
                self.assertEqual(case["expected"], "fail-closed")
                self.assertTrue(case["control"])
                self.assertTrue(case["threat"])

    def test_fixtures_contain_no_real_credential_material(self) -> None:
        raw = (ROOT / "tests/fixtures/threat_model_cases.json").read_text()
        self.assertNotIn("sk-", raw)
        self.assertNotIn("Bearer ", raw)
        self.assertIn("SAFE_TEST_SECRET_SENTINEL", raw)

    def test_threat_model_names_default_deny_and_contract_only_effects(self) -> None:
        document = (ROOT / "docs/FACTORY_THREAT_MODEL.md").read_text().lower()
        self.assertIn("default-deny", document)
        self.assertIn("high-risk effects are contract-only", document)
        self.assertIn("evaluators are not authorities", document)


if __name__ == "__main__":
    unittest.main()
