from __future__ import annotations

import importlib.util
import io
import sys
import unittest
from contextlib import redirect_stdout
from datetime import datetime, timedelta, timezone
from pathlib import Path
from factory.admission import contract_block


MODULE_PATH = Path(__file__).parents[1] / "factory" / "linear_triage.py"
SPEC = importlib.util.spec_from_file_location("linear_triage", MODULE_PATH)
assert SPEC and SPEC.loader
triage = importlib.util.module_from_spec(SPEC)
sys.modules["linear_triage"] = triage
SPEC.loader.exec_module(triage)


CHECKOUT_HEAD = "fedcba9876543210fedcba9876543210fedcba98"


def issue(dry_run_authorization=None, **overrides):
    value = {
        "id": "uuid", "identifier": "MHO-1", "title": "Candidate", "url": "https://linear.app/mhoo/issue/MHO-1", "priority": 3,
        "project": {"id": triage.PROJECT_ID},
        "state": {"id": "in-progress", "name": "In Progress", "type": "started"},
        "labels": {"nodes": []},
    }
    value.update(overrides)
    contract = {
        "contract_version": "v1", "dispatch_id": f"{value['identifier']}@r1",
        "linear": {"project_id": triage.PROJECT_ID, "issue_id": value["id"], "identifier": value["identifier"], "planning_revision": "r1", "planning_fingerprint": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},
        "target": {"repository": "mhoo-os/dark-factory", "work_type": "implementation", "execution_profile": "python-tests-v1", "collision_group": "dark-factory-runtime", "base_sha": "0123456789abcdef0123456789abcdef01234567"},
        "dependencies": [], "risk": {"risk_class": "low", "authority_class": "repository-local"},
        "acceptance_criteria": ["Candidate is explicit"], "validation_profile": "python-tests-v1",
        "allowed_scope": {"paths": ["factory/**"], "max_files": 2, "max_changed_lines": 20},
        "merge_policy": "human", "stale_conditions": ["planning_revision_changed", "planning_fingerprint_changed", "base_sha_changed"],
    }
    if dry_run_authorization is not None:
        contract["allowed_scope"] = {"paths": [], "max_files": 0, "max_changed_lines": 0}
        contract["dry_run_authorization"] = dry_run_authorization
    value["description"] = contract_block(contract)
    return value


class CandidateTests(unittest.TestCase):
    def test_extracts_an_active_candidate_to_the_factory_intake(self):
        candidate = triage.candidate_from(issue())
        self.assertEqual(candidate.repository, "mhoo-os/dark-factory")
        self.assertEqual(candidate.candidate_key, "MHO-1@r1")

    def test_rejects_an_inactive_candidate(self):
        bad = issue(state={"id": "done", "name": "Done", "type": "completed"})
        with self.assertRaises(triage.TriageError):
            triage.candidate_from(bad)

    def test_selects_higher_priority_candidate(self):
        lower = issue(identifier="MHO-2", priority=4)
        higher = issue(identifier="MHO-3", priority=2)
        self.assertEqual(triage.select([lower, higher]).identifier, "MHO-3")

    def test_marker_is_stable(self):
        candidate = triage.candidate_from(issue())
        self.assertEqual(triage.marker(candidate), triage.marker(candidate))

    def test_pending_candidate_skips_an_existing_intake(self):
        first = issue(identifier="MHO-1", priority=1)
        second = issue(identifier="MHO-2", priority=2)
        original = triage.existing_issue
        try:
            triage.existing_issue = lambda candidate: "https://github.com/mhoo-os/dark-factory/issues/1" if candidate.identifier == "MHO-1" else None
            selected = triage.pending_candidate([first, second])
        finally:
            triage.existing_issue = original
        self.assertIsNotNone(selected)
        self.assertEqual(selected[0].identifier, "MHO-2")

    def test_dry_run_authorization_replays_without_any_provider_write_path(self):
        authorization = {
            "authorization_id": "MHO-1-b5-receipt",
            "mode": "approved-intake",
            "non_executable": True,
            "expires_at": (datetime.now(timezone.utc) + timedelta(minutes=10)).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "checkout_head_sha": CHECKOUT_HEAD,
        }
        candidate = triage.candidate_from(issue(dry_run_authorization=authorization), dry_run=True, checkout_head=CHECKOUT_HEAD)
        original_existing = triage.existing_issue
        try:
            triage.existing_issue = lambda _candidate: self.fail("dry-run authorization must not inspect or create a GitHub intake")
            first = triage.plan_candidate(candidate, dry_run=True)
            replay = triage.plan_candidate(candidate, dry_run=True)
        finally:
            triage.existing_issue = original_existing
        self.assertEqual(first, replay)
        self.assertEqual(first["action"], "approved-intake-dry-run")
        self.assertFalse(first["normal_dispatch"])
        self.assertFalse(first["provider_mutations"])
        with self.assertRaises(triage.TriageError):
            triage.plan_candidate(candidate, dry_run=False)

    def test_main_dry_run_receipt_cannot_reach_any_provider_write(self):
        authorization = {
            "authorization_id": "MHO-1-b5-main",
            "mode": "approved-intake",
            "non_executable": True,
            "expires_at": (datetime.now(timezone.utc) + timedelta(minutes=10)).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "checkout_head_sha": CHECKOUT_HEAD,
        }
        original = {
            "clean_checkout_head": triage.clean_checkout_head,
            "eligible_issues": triage.eligible_issues,
            "remote_stop_requested": triage.remote_stop_requested,
            "existing_issue": triage.existing_issue,
            "create_issue": triage.create_issue,
            "update_linear": triage.update_linear,
            "argv": sys.argv,
        }
        try:
            triage.clean_checkout_head = lambda: CHECKOUT_HEAD
            triage.eligible_issues = lambda: [issue(dry_run_authorization=authorization)]
            triage.remote_stop_requested = lambda repositories: self.assertEqual(repositories, {"mhoo-os/dark-factory"})
            triage.existing_issue = lambda _candidate: self.fail("dry-run authorization must not inspect a GitHub intake")
            triage.create_issue = lambda _candidate: self.fail("dry-run authorization must not create a GitHub issue")
            triage.update_linear = lambda _candidate, _url: self.fail("dry-run authorization must not update Linear")
            sys.argv = ["linear_triage.py", "--dry-run"]
            output = io.StringIO()
            with redirect_stdout(output):
                self.assertEqual(triage.main(), 0)
        finally:
            triage.clean_checkout_head = original["clean_checkout_head"]
            triage.eligible_issues = original["eligible_issues"]
            triage.remote_stop_requested = original["remote_stop_requested"]
            triage.existing_issue = original["existing_issue"]
            triage.create_issue = original["create_issue"]
            triage.update_linear = original["update_linear"]
            sys.argv = original["argv"]
        self.assertIn('"action": "approved-intake-dry-run"', output.getvalue())
        self.assertIn('"provider_mutations": false', output.getvalue())


if __name__ == "__main__":
    unittest.main()
