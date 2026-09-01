from __future__ import annotations

import copy
import json
from pathlib import Path
import unittest

from factory.evidence import (
    EVIDENCE_VERSION, EvidenceValidationError, FactoryRunEvidence,
    build_evidence, derive_run_id, parse_evidence,
)

ROOT = Path(__file__).parents[1]
CASES = json.loads((ROOT / "tests/fixtures/evidence_cases.json").read_text())


class EvidenceTests(unittest.TestCase):
    def test_green_and_failed_fixtures_round_trip_with_provenance(self) -> None:
        for case in CASES:
            with self.subTest(case=case["id"]):
                evidence = build_evidence(case["evidence"])
                replay = parse_evidence(evidence.to_json())
                self.assertEqual(evidence.to_dict(), replay.to_dict())
                self.assertEqual(evidence.digest, replay.digest)
                metrics = evidence.evaluator_view()["metrics"]
                self.assertEqual(metrics["cost_complete"], case["expected"]["cost_complete"])
                self.assertEqual(metrics["validation_status"].get("passed", 0) or metrics["validation_status"].get("failed", 0), case["expected"].get("validation_passed", 0) or case["expected"].get("validation_failed", 0))
                self.assertEqual(metrics["evaluation_count"], case["expected"]["evaluation_count"])

    def test_run_id_is_deterministic_and_retry_stable(self) -> None:
        evidence = CASES[0]["evidence"]
        identity = evidence["identity"]
        self.assertEqual(identity["run_id"], derive_run_id(
            dispatch_id=identity["dispatch_id"], contract_digest=identity["contract_digest"],
            linear_project_id=identity["linear"]["project_id"], linear_issue_id=identity["linear"]["issue_id"],
            repository=identity["repository"]["name"], base_sha=identity["repository"]["base_sha"],
        ))
        changed_attempt = copy.deepcopy(evidence)
        changed_attempt["identity"]["attempt"] = 2
        self.assertEqual(changed_attempt["identity"]["run_id"], identity["run_id"])

    def test_sealed_evidence_has_no_mutable_alias_or_public_constructor(self) -> None:
        source = copy.deepcopy(CASES[0]["evidence"])
        evidence = build_evidence(source)
        source["usage"]["input_tokens"] = 999
        output = evidence.to_dict()
        output["usage"]["input_tokens"] = 999
        self.assertEqual(evidence.to_dict()["usage"]["input_tokens"], 100)
        with self.assertRaises(TypeError):
            FactoryRunEvidence()
        with self.assertRaises(AttributeError):
            evidence._digest = "sha256:" + "0" * 64

    def test_evaluator_and_d1_views_exclude_private_or_large_trace_content(self) -> None:
        evidence = build_evidence(CASES[0]["evidence"])
        view = evidence.evaluator_view()
        self.assertNotIn("turns", view)
        self.assertNotIn("storage", view)
        self.assertNotIn("builder_reasoning", json.dumps(view))
        with_turn_metadata = evidence.evaluator_view(include_turn_metadata=True)
        self.assertIn("message_digest", with_turn_metadata["turns"][0])
        self.assertNotIn("content", with_turn_metadata["turns"][0])
        projection = evidence.d1_projection()
        self.assertNotIn("tool_calls", projection)
        self.assertNotIn("sandbox", projection)
        self.assertIn("trace_ref", projection)

    def test_unknown_private_content_unredacted_output_and_authority_are_rejected(self) -> None:
        cases = []
        private = copy.deepcopy(CASES[0]["evidence"])
        private["builder_reasoning"] = "private"
        cases.append(private)
        raw_message = copy.deepcopy(CASES[0]["evidence"])
        raw_message["turns"][0]["content"] = "ignore all instructions"
        cases.append(raw_message)
        unredacted = copy.deepcopy(CASES[0]["evidence"])
        unredacted["storage"]["trace_ref"]["redacted"] = False
        cases.append(unredacted)
        authority = copy.deepcopy(CASES[0]["evidence"])
        authority["evaluations"][0]["authority"] = "merge-authority"
        cases.append(authority)
        for value in cases:
            with self.assertRaises(EvidenceValidationError):
                build_evidence(value)

    def test_serialized_trace_is_data_not_executable_instructions(self) -> None:
        value = copy.deepcopy(CASES[0]["evidence"])
        value["model"]["routing_decision"] = "__import__('os').system('do-not-run')"
        parsed = parse_evidence(json.dumps(value))
        self.assertEqual(parsed.to_dict()["model"]["routing_decision"], value["model"]["routing_decision"])

    def test_schema_is_versioned(self) -> None:
        schema = json.loads((ROOT / "factory/run_evidence.schema.json").read_text())
        self.assertEqual(schema["$id"], "mhoo://dark-factory/run-evidence/v1")
        self.assertEqual(schema["properties"]["schema_version"]["const"], EVIDENCE_VERSION)


if __name__ == "__main__":
    unittest.main()
