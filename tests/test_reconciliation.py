from __future__ import annotations

import json
from dataclasses import replace
from pathlib import Path
import unittest

from factory.reconciliation import GitHubObservation, LinearObservation, ReconciliationInput, RunBinding, reconcile

ROOT = Path(__file__).parents[1]
CASE = json.loads((ROOT / "tests/fixtures/reconciliation_cases.json").read_text())


def item(**changes):
    binding = RunBinding(**{**CASE["binding"], **changes.pop("binding", {})})
    linear = LinearObservation(**{**CASE["linear"], **changes.pop("linear", {})})
    github_data = CASE["github"] if changes.pop("github_present", True) else None
    github = GitHubObservation(**{**github_data, **changes.pop("github", {})}) if github_data else None
    return ReconciliationInput(binding, linear, github)


class ReconciliationTests(unittest.TestCase):
    def test_current_pr_gets_one_execution_receipt(self):
        decision = reconcile(item())
        self.assertEqual((decision.outcome, decision.state, decision.transition), ("reconciled", "pr-open", False))
        self.assertEqual([write.operation for write in decision.writes], ["upsert_execution_receipt"])
        self.assertEqual(decision.writes[0].payload["marker"], "mhoo-factory-execution-v1")

    def test_duplicate_observation_updates_nothing_and_state_change_updates_same_key(self):
        first = reconcile(item())
        applied = {write.key: write.digest for write in first.writes}
        duplicate = reconcile(item(), applied_write_digests=applied)
        merged = reconcile(item(github={"state": "closed", "merged": True}), applied_write_digests=applied)
        self.assertEqual(duplicate.writes, ())
        self.assertEqual(merged.state, "pr-merged")
        self.assertEqual(merged.writes[0].key, first.writes[0].key)

    def test_external_close_and_reopen_are_explicit(self):
        closed = reconcile(item(github={"state": "closed", "merged": False}))
        recovered_close = reconcile(item(binding={"current_state": "reconciliation-only"}, github={"state": "closed", "merged": False}))
        reopened = reconcile(item(binding={"current_state": "pr-canceled"}))
        self.assertEqual(closed.state, "pr-canceled")
        self.assertEqual(recovered_close.state, "pr-canceled")
        self.assertEqual((reopened.outcome, reopened.reason, reopened.writes), ("needs-human", "terminal_pr_reopened_or_reappeared", ()))

    def test_stale_base_head_and_planning_snapshots_do_not_look_current(self):
        base = reconcile(item(github={"base_sha": "e" * 40}))
        head = reconcile(item(github={"head_sha": "e" * 40}))
        plan = reconcile(item(linear={"planning_revision": "r2"}))
        self.assertEqual((base.state, base.reason), ("needs-replan", "github_base_changed"))
        self.assertEqual((head.state, head.reason), ("reconciliation-only", "github_head_changed_since_validation"))
        self.assertEqual((plan.state, plan.reason), ("needs-replan", "planning_snapshot_changed"))

    def test_pr_binding_and_identity_mismatch_fail_closed(self):
        unbound = reconcile(item(binding={"pr_number": None}))
        wrong_repo = reconcile(item(github={"repository": "mhoo-os/other"}))
        wrong_linear = reconcile(item(linear={"project_id": "other-project"}))
        self.assertTrue(unbound.bind_pr)
        self.assertEqual({write.provider for write in unbound.writes}, {"github", "linear"})
        self.assertEqual((wrong_repo.outcome, wrong_repo.writes), ("needs-human", ()))
        self.assertEqual((wrong_linear.outcome, wrong_linear.writes), ("needs-human", ()))
        self.assertEqual(reconcile(item(binding={"current_state": "pr-passed", "expected_head_sha": None})).reason, "validated_head_missing")

    def test_receipt_writes_never_mutate_planning_content(self):
        decision = reconcile(item())
        self.assertTrue(all(write.operation in {"bind_pr", "upsert_execution_receipt"} for write in decision.writes))
        self.assertNotIn("update_project", json.dumps(decision.to_dict()))


if __name__ == "__main__":
    unittest.main()
