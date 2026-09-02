from __future__ import annotations
import copy
import json
from pathlib import Path
import unittest
from factory.metrics import (CohortComparison, MetricsPolicy, MetricsReport, MetricsValidationError, build_metrics_report, compare_cohorts, make_metrics_policy, make_run_observation)
ROOT = Path(__file__).parents[1]
CASES = json.loads((ROOT / "tests/fixtures/metrics_cases.json").read_text())
class MetricsTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.policy = make_metrics_policy(CASES["policy"])
    def observation(self, **changes: object):
        value = copy.deepcopy(CASES["observation"])
        value.update(changes)
        return make_run_observation(value)
    def test_report_aggregates_structured_quality_cost_and_evaluator_metrics(self) -> None:
        report = build_metrics_report([self.observation(), self.observation(run_id="run-v1-" + "1" * 32, evidence_digest="sha256:" + "1" * 64, routing_digest="sha256:" + "2" * 64, pr_trajectory_findings=["gated_tool_order"], conversation_trajectory_findings=["claim_without_tool_call"], fix_attempts=1, fix_success=True, retry_count=1)], self.policy)
        cohort = report.cohorts[0]
        self.assertIsInstance(report, MetricsReport)
        self.assertEqual((report.observation_count, cohort.sample_size, cohort.first_pass_validation_rate, cohort.successful_pr_rate), (2, 2, 0.5, 1.0))
        self.assertEqual((cohort.fix_success_rate, cohort.pr_trajectory_finding_types, cohort.conversation_trajectory_finding_types), (1.0, (("gated_tool_order", 1),), (("claim_without_tool_call", 1),)))
        self.assertEqual((report.authority, len(report.evidence_digests), len(report.routing_digests)), ("report-only", 2, 2))
    def test_small_or_incomplete_cohorts_never_become_routing_truth(self) -> None:
        one = build_metrics_report([self.observation()], self.policy)
        comparison = compare_cohorts(one.cohorts[0], one.cohorts[0], self.policy, one.report_digest)
        self.assertEqual((comparison.recommendation, comparison.reason, comparison.authority), ("insufficient-evidence", "minimum_cohort_size_not_met", "report-only"))
        incomplete = self.observation(run_id="run-v1-" + "1" * 32, evidence_digest="sha256:" + "1" * 64, cost_usd=None, cost_complete=False)
        report = build_metrics_report([self.observation(), incomplete], self.policy)
        self.assertEqual(compare_cohorts(report.cohorts[0], report.cohorts[0], self.policy, report.report_digest).recommendation, "insufficient-evidence")
        noisy = self.observation(run_id="run-v1-" + "2" * 32, evidence_digest="sha256:" + "2" * 64, evaluator_digests=[])
        noisy_report = build_metrics_report([self.observation(), noisy], self.policy)
        self.assertEqual(compare_cohorts(noisy_report.cohorts[0], noisy_report.cohorts[0], self.policy, noisy_report.report_digest).reason, "evaluator_evidence_incomplete")
        with self.assertRaises(MetricsValidationError):
            build_metrics_report([self.observation(), self.observation(run_id="run-v1-936093f52fe78fc2f0dce8de7a4eaf94")], self.policy)
    def test_two_same_scope_cohorts_produce_report_only_recommendations(self) -> None:
        baseline = [self.observation(run_id="run-v1-" + format(index, "032x"), evidence_digest="sha256:" + format(index, "064x")) for index in range(2)]
        candidate = [self.observation(run_id="run-v1-" + format(index + 10, "032x"), evidence_digest="sha256:" + format(index + 10, "064x"), model="openai/gpt-5.5", model_version="2026-08", routing_digest="sha256:" + format(index + 20, "064x"), validation_status="passed") for index in range(2)]
        report = build_metrics_report(baseline + candidate, self.policy)
        comparison = compare_cohorts(report.cohorts[0], report.cohorts[1], self.policy, report.report_digest)
        self.assertIn(comparison.recommendation, {"no-material-difference", "escalate-to-candidate", "retain-baseline"})
        self.assertEqual(comparison.authority, "report-only")
        self.assertNotIn("route_factory", json.dumps(comparison.to_dict()))
    def test_invalid_raw_input_and_policy_are_rejected_and_values_are_sealed(self) -> None:
        raw = copy.deepcopy(CASES["observation"])
        raw["logs"] = "do not parse logs"
        with self.assertRaises(MetricsValidationError):
            make_run_observation(raw)
        with self.assertRaises(MetricsValidationError):
            make_metrics_policy({**CASES["policy"], "material_first_pass_delta": 2})
        with self.assertRaises(TypeError):
            MetricsPolicy()  # type: ignore[call-arg]
        with self.assertRaises(TypeError):
            MetricsReport()  # type: ignore[call-arg]
        with self.assertRaises(TypeError):
            CohortComparison()  # type: ignore[call-arg]
if __name__ == "__main__":
    unittest.main()
