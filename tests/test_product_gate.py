from __future__ import annotations

import copy
import json
from pathlib import Path
import unittest

from factory.product_gate import (
    CheckObservation, FreshContext, GateValidationError, ProductGateRequest,
    ValidationProfile, declare_profile, run_product_gate,
)

ROOT = Path(__file__).parents[1]
PROFILE_VALUE = json.loads((ROOT / "factory/factory_registry.json").read_text())["validation_profiles"][0]
CASES = json.loads((ROOT / "tests/fixtures/product_gate_cases.json").read_text())
PROFILE = declare_profile(PROFILE_VALUE)


def request(**changes: object) -> ProductGateRequest:
    value = {"run_id": "run-v1-936093f52fe78fc2f0dce8de7a4eaf94", "contract_digest": "sha256:" + "a" * 64, "repository": "mhoo-os/dark-factory", "base_sha": "0" * 40, "head_sha": "f" * 40, "profile_id": PROFILE.profile_id, "profile_digest": PROFILE.digest, "acceptance_criteria_digest": "sha256:" + "b" * 64, "governance_digest": "sha256:" + "c" * 64}
    value.update(changes)
    return ProductGateRequest(**value)


class Runner:
    def __init__(self, case: dict, *, context_base: str | None = None, observation_head: str | None = None):
        self.case, self.context_base, self.observation_head = case, context_base, observation_head
        self.keys: list[str] = []

    def open_fresh_context(self, request: ProductGateRequest, idempotency_key: str) -> FreshContext:
        self.keys.append(idempotency_key)
        return FreshContext("context-1", request.repository, self.context_base or request.base_sha, request.head_sha, request.profile_digest, request.contract_digest, True, True)

    def run_check(self, request: ProductGateRequest, context: FreshContext, check: str, idempotency_key: str) -> CheckObservation:
        self.keys.append(idempotency_key)
        value = self.case["checks"][check]
        return CheckObservation(check, request.repository, request.base_sha, self.observation_head or request.head_sha, request.profile_digest, request.contract_digest, value["status"], tuple(value["markers"]), value.get("evidence_digest"), "r2://runs/" + check.replace(" ", "-") + ".json" if value.get("evidence_digest") else None, 1, value["classification"])


class ProductGateTests(unittest.TestCase):
    def test_green_profile_runs_in_order_and_passes_only_with_markers(self) -> None:
        runner = Runner(CASES[0])
        verdict = run_product_gate(request(), PROFILE, runner)
        self.assertEqual((verdict.outcome, verdict.reason, verdict.gate_kind), ("pass", "all_profile_checks_and_markers_passed", "product"))
        self.assertEqual([item.name for item in verdict.checks], list(PROFILE.checks))
        self.assertEqual(set(verdict.required_markers), {"APP_STARTED", "E2E_PASSED", "PROTECTED_OK", "GATE_OK"})
        self.assertEqual(len(runner.keys), len(PROFILE.checks) + 1)

    def test_broken_e2e_is_fixable_and_never_looks_like_a_pass(self) -> None:
        verdict = run_product_gate(request(), PROFILE, Runner(CASES[1]))
        self.assertEqual((verdict.outcome, verdict.reason), ("fixable", "check_failed:python3 -m unittest discover -s tests -v"))

    def test_missing_positive_marker_is_rejected_even_when_checks_claim_passed(self) -> None:
        verdict = run_product_gate(request(), PROFILE, Runner(CASES[2]))
        self.assertEqual((verdict.outcome, verdict.reason), ("auto-reject", "required_marker_missing"))

    def test_passed_check_without_evidence_is_not_accepted(self) -> None:
        case = copy.deepcopy(CASES[0])
        case["checks"][PROFILE.checks[0]]["evidence_digest"] = None
        verdict = run_product_gate(request(), PROFILE, Runner(case))
        self.assertEqual((verdict.outcome, verdict.reason), ("needs-human", "check_evidence_missing:python3 -m py_compile factory/*.py"))

    def test_malformed_evidence_reference_or_marker_is_not_accepted(self) -> None:
        for field, value in (("evidence_digest", "raw-output"), ("markers", ["E2E_PASSED\n"])):
            case = copy.deepcopy(CASES[0])
            case["checks"][PROFILE.checks[0]][field] = value
            verdict = run_product_gate(request(), PROFILE, Runner(case))
            self.assertEqual(verdict.outcome, "needs-human")

    def test_stale_context_or_observation_cannot_reuse_a_green_result(self) -> None:
        stale_context = run_product_gate(request(), PROFILE, Runner(CASES[0], context_base="1" * 40))
        stale_observation = run_product_gate(request(), PROFILE, Runner(CASES[0], observation_head="1" * 40))
        self.assertEqual(stale_context.reason, "fresh_context_identity_invalid")
        self.assertEqual(stale_observation.reason, "check_identity_invalid:python3 -m py_compile factory/*.py")

    def test_profile_is_sealed_and_builder_cannot_change_thresholds(self) -> None:
        source = copy.deepcopy(PROFILE_VALUE)
        profile = declare_profile(source)
        source["required_markers"].clear()
        self.assertEqual(profile.required_markers, PROFILE.required_markers)
        with self.assertRaises(TypeError):
            ValidationProfile()
        with self.assertRaises(AttributeError):
            profile._digest = "sha256:" + "0" * 64

    def test_profile_digest_mismatch_and_fresh_reasoning_visibility_fail_closed(self) -> None:
        mismatch = run_product_gate(request(profile_digest="sha256:" + "d" * 64), PROFILE, Runner(CASES[0]))
        hidden = Runner(CASES[0])
        hidden.open_fresh_context = lambda req, key: FreshContext("context-1", req.repository, req.base_sha, req.head_sha, req.profile_digest, req.contract_digest, True, False)
        withheld = run_product_gate(request(), PROFILE, hidden)
        self.assertEqual(mismatch.reason, "request.profile_digest.mismatch")
        self.assertEqual(withheld.reason, "fresh_context_identity_invalid")

    def test_verdict_carries_bounded_product_evidence_not_builder_reasoning(self) -> None:
        verdict = run_product_gate(request(), PROFILE, Runner(CASES[0]))
        document = verdict.to_dict()
        self.assertEqual(document["gate_kind"], "product")
        self.assertEqual(document["checks"][0]["evidence_digest"], "sha256:" + "1" * 64)
        self.assertNotIn("builder_reasoning", json.dumps(document))
        self.assertNotIn("pr-trajectory", json.dumps(document))


if __name__ == "__main__":
    unittest.main()
