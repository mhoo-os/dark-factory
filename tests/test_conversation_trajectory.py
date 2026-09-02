from __future__ import annotations
import copy
import json
from pathlib import Path
import unittest
from factory.conversation_trajectory import (ConversationAuditValidationError, ConversationAuditPolicy, ConversationTrace, audit_conversation, make_audit_policy, make_tier2_result, normalize_trace, tier2_is_required)
ROOT = Path(__file__).parents[1]
CASES = json.loads((ROOT / "tests/fixtures/conversation_trajectory_cases.json").read_text())
class ConversationTrajectoryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.policy = make_audit_policy(CASES["policy"])
    def trace(self, name: str) -> ConversationTrace:
        return normalize_trace(copy.deepcopy(CASES[name]))
    def test_clean_trace_runs_tier1_without_model_and_is_not_sampled(self) -> None:
        trace = self.trace("clean")
        decision = audit_conversation(trace, self.policy)
        self.assertEqual((decision.outcome, decision.reason), ("PASS", "tier1_pass_not_sampled"))
        self.assertEqual((decision.tier1.status, decision.tier1.finding_codes), ("PASS", ()))
        self.assertEqual((decision.tier2_required, decision.tier2_reason), (False, "clean_not_sampled"))
        self.assertIsNone(decision.normalized_evaluation["model_digest"])
    def test_claim_without_evidence_is_deterministically_flagged(self) -> None:
        decision = audit_conversation(self.trace("claim_without_evidence"), self.policy)
        self.assertEqual(decision.tier1.status, "FAIL")
        self.assertIn("claim_without_tool_call", decision.tier1.finding_codes)
        self.assertEqual((decision.outcome, decision.reason), ("NON_FINAL", "tier2_required_missing"))
    def test_disallowed_and_secret_shaped_side_effects_are_flagged(self) -> None:
        decision = audit_conversation(self.trace("disallowed"), self.policy)
        self.assertEqual(set(decision.tier1.finding_codes), {"disallowed_tool", "secret_shaped_output", "unsupported_external_side_effect"})
        self.assertEqual(decision.normalized_evaluation["authority"], "observer-only")
    def test_gated_order_and_post_fence_writes_are_structural_checks(self) -> None:
        case = copy.deepcopy(CASES["clean"])
        case["trace_id"] = "trace-gated-1"
        case["turns"][0]["tool_calls"] = [{"id": "tool-0", "name": "issue_refund", "status": "succeeded", "mutating": True, "side_effect": "linear_comment", "secret_shaped": False}]
        case["events"] = [{"kind": "fenced", "turn_index": 0}]
        decision = audit_conversation(normalize_trace(case), self.policy)
        self.assertIn("gated_tool_order", decision.tier1.finding_codes)
        self.assertIn("continued_after_fence_loss", decision.tier1.finding_codes)
    def test_sample_percent_and_tier2_metadata_are_exactly_bound(self) -> None:
        sampled_policy = make_audit_policy({**CASES["policy"], "sample_percent": 100})
        trace = self.trace("clean")
        self.assertEqual(tier2_is_required(trace, sampled_policy)[0], True)
        missing = audit_conversation(trace, sampled_policy)
        self.assertEqual((missing.outcome, missing.reason), ("NON_FINAL", "tier2_required_missing"))
        digests = CASES["policy"]
        tier2 = make_tier2_result({"outcome": "PASS", "model_digest": "sha256:" + "1" * 64, "rubric_digest": digests["rubric_digest"], "execution_profile_digest": digests["execution_profile_digest"], "tool_policy_digest": digests["tool_policy_digest"], "security_contract_digest": digests["security_contract_digest"], "evidence_digest": "sha256:" + "2" * 64, "finding_digests": [], "evidence_ref": "r2://runs/trace-clean-1-tier2.json"})
        observed = audit_conversation(trace, sampled_policy, tier2)
        self.assertEqual((observed.outcome, observed.normalized_evaluation["model_digest"], observed.normalized_evaluation["rubric_digest"]), ("PASS", "sha256:" + "1" * 64, digests["rubric_digest"]))
        wrong = make_tier2_result({**tier2.to_dict(), "rubric_digest": "sha256:" + "f" * 64})
        self.assertEqual(audit_conversation(trace, sampled_policy, wrong).reason, "tier2_rubric_digest_mismatch")
    def test_raw_content_is_rejected_and_proof_values_are_sealed(self) -> None:
        raw = copy.deepcopy(CASES["clean"])
        raw["turns"][0]["content"] = "do not retain this"
        with self.assertRaises(ConversationAuditValidationError) as error:
            normalize_trace(raw)
        self.assertTrue(any("content" in item for item in error.exception.errors))
        with self.assertRaises(TypeError):
            ConversationAuditPolicy()  # type: ignore[call-arg]
        with self.assertRaises(TypeError):
            ConversationTrace()  # type: ignore[call-arg]
    def test_observer_result_contains_no_authority_write_intent(self) -> None:
        encoded = json.dumps(audit_conversation(self.trace("claim_without_evidence"), self.policy).to_dict())
        for forbidden in ("route_factory", "merge", "approve", "state_transition"):
            self.assertNotIn(forbidden, encoded)
if __name__ == "__main__":
    unittest.main()
