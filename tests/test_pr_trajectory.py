from __future__ import annotations

import copy
import json
from pathlib import Path
import unittest

from factory.pr_trajectory import (
    Tier1Evidence, Tier2Evidence, TrajectoryRequest, make_trajectory_key,
    reconcile_trajectory,
)

ROOT = Path(__file__).parents[1]
CASES = json.loads((ROOT / "tests/fixtures/pr_trajectory_cases.json").read_text())
REPO = "mhoo-os/dark-factory"
HEAD = "f" * 40
BASE = "0" * 40
RUBRIC = "sha256:" + "a" * 64


def request(case: dict | None = None, **changes: object) -> TrajectoryRequest:
    case = case or CASES[0]
    value = {
        "run_id": "run-v1-936093f52fe78fc2f0dce8de7a4eaf94", "dispatch_id": "MHO-216@r1",
        "contract_digest": "sha256:" + "b" * 64,
        "key": make_trajectory_key(REPO, 17, HEAD, BASE, RUBRIC),
        "base_manifest_status": "valid", "base_manifest_digest": "sha256:" + "c" * 64,
        "governing_source_digests": (("CLAUDE.md", "sha256:" + "d" * 64),),
        "tier1": Tier1Evidence(case["tier1"]["status"], case["tier1"]["evidence_digest"], tuple(case["tier1"]["finding_codes"]), case["tier1"]["evidence_ref"]),
        "tier2": Tier2Evidence(case["tier2"]["outcome"], case["tier2"]["model_digest"], case["tier2"]["evidence_digest"], tuple(case["tier2"]["finding_digests"]), case["tier2"]["evidence_ref"]),
    }
    value.update(changes)
    return TrajectoryRequest(**value)


class PRTrajectoryTests(unittest.TestCase):
    def test_pass_binds_exact_key_and_produces_one_marker_comment_intent(self) -> None:
        decision = reconcile_trajectory(request())
        self.assertEqual((decision.outcome, decision.reason), ("PASS", "tier1_and_tier2_observed"))
        self.assertEqual(decision.normalized_evaluation["kind"], "pr-trajectory")
        self.assertEqual(decision.normalized_evaluation["rubric_digest"], RUBRIC)
        self.assertEqual(decision.normalized_evaluation["authority"], "observer-only")
        self.assertEqual(decision.comment.marker, "<!-- trajectory-reviewer:v1 -->")
        self.assertEqual(decision.comment.key, "github:trajectory-reviewer:comment:mhoo-os/dark-factory:17")

    def test_duplicate_observation_is_idempotent(self) -> None:
        first = reconcile_trajectory(request())
        applied = {first.key.value: first.observation_digest, first.comment.key: first.observation_digest}
        duplicate = reconcile_trajectory(request(), applied_observation_digests=applied)
        self.assertTrue(duplicate.duplicate)
        self.assertIsNone(duplicate.comment)
        self.assertEqual(duplicate.observation_digest, first.observation_digest)

    def test_new_head_creates_current_observation_and_supersedes_history(self) -> None:
        first = reconcile_trajectory(request())
        changed_key = make_trajectory_key(REPO, 17, "e" * 40, BASE, RUBRIC)
        changed = reconcile_trajectory(request(key=changed_key), applied_observation_digests={first.key.value: first.observation_digest})
        self.assertFalse(changed.duplicate)
        self.assertEqual(changed.supersedes, (first.key.value,))
        self.assertEqual(changed.comment.key, first.comment.key)
        self.assertNotEqual(changed.observation_digest, first.observation_digest)

    def test_missing_or_invalid_base_manifest_is_not_configured_and_skips_judgment(self) -> None:
        key = make_trajectory_key(REPO, 17, HEAD, BASE, None)
        for status in ("missing", "invalid"):
            result = reconcile_trajectory(request(base_manifest_status=status, base_manifest_digest=None, governing_source_digests=(), key=key))
            self.assertEqual((result.outcome, result.reason, result.normalized_evaluation, result.comment), ("NOT_CONFIGURED", "base_manifest_" + status, None, None))

    def test_missing_rubric_digest_under_valid_manifest_is_not_configured(self) -> None:
        key = make_trajectory_key(REPO, 17, HEAD, BASE, None)
        result = reconcile_trajectory(request(key=key))
        self.assertEqual((result.outcome, result.reason), ("NOT_CONFIGURED", "request.key.rubric_digest.required"))

    def test_fail_and_non_final_tier_two_results_are_visible_but_not_authority(self) -> None:
        failed = reconcile_trajectory(request(CASES[1]))
        pending = reconcile_trajectory(request(CASES[2]))
        self.assertEqual((failed.outcome, failed.normalized_evaluation["status"]), ("FAIL", "fail"))
        self.assertEqual((pending.outcome, pending.normalized_evaluation["status"]), ("NON_FINAL", "needs-human"))
        for decision in (failed, pending):
            encoded = json.dumps(decision.to_dict())
            self.assertNotIn("merge", encoded)
            self.assertNotIn("approve", encoded)
            self.assertNotIn("route_factory", encoded)

    def test_invalid_tier_observation_is_non_final_not_a_generic_pass(self) -> None:
        invalid = copy.deepcopy(CASES[0])
        invalid["tier2"]["evidence_digest"] = "not-a-digest"
        result = reconcile_trajectory(request(invalid))
        self.assertEqual((result.outcome, result.reason), ("NON_FINAL", "tier2_observation_invalid"))
        self.assertEqual(result.normalized_evaluation["status"], "needs-human")

    def test_all_writes_are_single_marker_comment_and_observation_is_digest_bound(self) -> None:
        result = reconcile_trajectory(request())
        write = result.comment.to_dict()
        self.assertEqual((write["provider"], write["operation"], write["marker"]), ("github", "upsert_marker_comment", "<!-- trajectory-reviewer:v1 -->"))
        self.assertEqual(write["observation_digest"], result.observation_digest)
        self.assertEqual(write["observation_key"], result.key.value)


if __name__ == "__main__":
    unittest.main()
