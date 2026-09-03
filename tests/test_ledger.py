from __future__ import annotations

import copy
import json
from pathlib import Path
import sqlite3
import unittest

from factory.dispatch_contract import bind_registry_identity, validate_dispatch_contract
from factory.factory_registry import REGISTRY, RegistryError, resolve_factory, validate_current_binding
from factory.ledger import Ledger, LedgerConflict, SCHEMA_VERSION


ROOT = Path(__file__).parents[1]
CASE = json.loads((ROOT / "tests/fixtures/admission_cases.json").read_text())["valid"]
CONTRACT_VALUE = CASE["contract"]


def contract(value=None):
    result = validate_dispatch_contract(value or CONTRACT_VALUE)
    assert result.contract is not None
    binding = resolve_factory(CASE["issue"], result.contract.to_dict())
    return bind_registry_identity(result.contract, binding)


class LedgerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.connection = sqlite3.connect(":memory:")
        self.ledger = Ledger(self.connection)
        self.dispatch = contract()

    def tearDown(self) -> None:
        self.connection.close()

    def test_admission_is_idempotent_and_conflicts_are_rejected(self) -> None:
        first = self.ledger.admit(self.dispatch, "run-1", now="2026-09-02T00:00:00+00:00")
        second = self.ledger.admit(self.dispatch, "run-2", now="2026-09-02T00:01:00+00:00")
        self.assertTrue(first.created)
        self.assertFalse(second.created)
        self.assertEqual(second.run_id, "run-1")

        changed = copy.deepcopy(CONTRACT_VALUE)
        changed["acceptance_criteria"] = ["Different admitted contents"]
        with self.assertRaises(LedgerConflict):
            self.ledger.admit(contract(changed), "run-3")
        self.assertEqual(self.ledger.run(self.dispatch.dispatch_id)["run_id"], "run-1")

    def test_one_active_execution_per_linear_issue(self) -> None:
        self.ledger.admit(self.dispatch, "run-1")
        changed = copy.deepcopy(CONTRACT_VALUE)
        changed["dispatch_id"] = "MHO-900@r2"
        changed["linear"]["planning_revision"] = "r2"
        with self.assertRaises(LedgerConflict):
            self.ledger.admit(contract(changed), "run-2")

    def test_transition_history_is_append_only_and_replay_safe(self) -> None:
        self.ledger.admit(self.dispatch, "run-1")
        accepted = self.ledger.transition("MHO-900@r1", "queued", actor="admission", event_id="evt-1", event_sequence=2)
        replay = self.ledger.transition("MHO-900@r1", "queued", actor="admission", event_id="evt-1", event_sequence=2)
        stale = self.ledger.transition("MHO-900@r1", "admitted", actor="admission", event_id="evt-2", event_sequence=1)
        self.assertEqual(accepted.outcome, "accepted")
        self.assertEqual(replay.reason, "replayed_event")
        self.assertEqual(stale.reason, "stale_event")
        self.assertEqual(self.ledger.run("MHO-900@r1")["current_state"], "queued")
        self.assertEqual(len(self.ledger.events("MHO-900@r1")), 3)

    def test_illegal_transition_does_not_change_run_state(self) -> None:
        self.ledger.admit(self.dispatch, "run-1")
        result = self.ledger.transition("MHO-900@r1", "pr-merged", actor="workflow", event_id="evt-illegal", event_sequence=2)
        self.assertEqual(result.reason, "illegal_or_unauthorized_transition")
        self.assertEqual(self.ledger.run("MHO-900@r1")["current_state"], "admitted")

    def test_evidence_must_be_redacted_and_schema_has_no_secret_columns(self) -> None:
        self.ledger.admit(self.dispatch, "run-1")
        with self.assertRaises(LedgerConflict):
            self.ledger.record_evidence(
                evidence_id="evidence-1", dispatch_id="MHO-900@r1", run_id="run-1", attempt=0,
                kind="test-log", digest="sha256:abc", artifact_ref="r2://evidence-1", redacted=False,
            )
        self.ledger.record_evidence(
            evidence_id="evidence-2", dispatch_id="MHO-900@r1", run_id="run-1", attempt=0,
            kind="test-log", digest="sha256:abc", artifact_ref="r2://evidence-2", redacted=True,
        )
        self.ledger.record_pr_receipt(
            receipt_id="pr-1", dispatch_id="MHO-900@r1", pr_number=1,
            pr_url="https://github.com/mhoo-os/dark-factory/pull/1", head_sha="f" * 40,
        )
        self.ledger.record_linear_reconciliation(
            reconciliation_id="linear-1", dispatch_id="MHO-900@r1", state="pr-open", reason="pr_published",
        )
        columns = {row[1] for row in self.connection.execute("PRAGMA table_info(factory_runs)")}
        self.assertFalse(any(name.lower() in {"secret", "credential", "access_token", "token_value"} for name in columns))
        self.assertEqual(self.connection.execute("SELECT schema_version FROM factory_schema_meta").fetchone()[0], SCHEMA_VERSION)
        run = self.ledger.run("MHO-900@r1")
        event = self.ledger.events("MHO-900@r1")[0]
        evidence = self.connection.execute("SELECT * FROM factory_evidence WHERE evidence_id='evidence-2'").fetchone()
        pr = self.connection.execute("SELECT * FROM factory_pr_receipts WHERE receipt_id='pr-1'").fetchone()
        reconciliation = self.connection.execute("SELECT * FROM factory_linear_reconciliations WHERE reconciliation_id='linear-1'").fetchone()
        self.assertEqual({run["factory_id"], event["factory_id"], evidence["factory_id"], pr["factory_id"], reconciliation["factory_id"]}, {"foundation-pilot"})

    def test_ingress_binding_precedes_enqueue_and_retains_registry_identity(self) -> None:
        self.ledger.reserve_ingress("linear-1", "linear", "Issue", "sha256:payload")
        self.ledger.bind_ingress("linear-1", self.dispatch)
        self.ledger.mark_ingress_enqueued("linear-1")
        receipt = self.ledger.ingress("linear-1")
        self.assertEqual(receipt["handoff_state"], "enqueued")
        self.assertEqual(receipt["factory_id"], "foundation-pilot")
        self.assertEqual(receipt["registry_digest"], self.dispatch.to_dict()["registry"]["registry_digest"])

    def test_registry_rollback_stops_new_execution_without_deleting_evidence(self) -> None:
        self.ledger.admit(self.dispatch, "run-1")
        self.ledger.record_evidence(
            evidence_id="evidence-before-disable", dispatch_id="MHO-900@r1", run_id="run-1", attempt=0,
            kind="test-log", digest="sha256:abc", artifact_ref="r2://evidence-before-disable", redacted=True,
        )
        disabled = copy.deepcopy(REGISTRY)
        disabled["factories"][0]["state"] = "disabled"
        with self.assertRaisesRegex(RegistryError, "registry_factory_disabled"):
            validate_current_binding(self.dispatch.to_dict()["registry"], registry=disabled)
        retained = self.connection.execute(
            "SELECT factory_id, registry_digest FROM factory_evidence WHERE evidence_id=?",
            ("evidence-before-disable",),
        ).fetchone()
        self.assertEqual(tuple(retained), (
            "foundation-pilot", self.dispatch.to_dict()["registry"]["registry_digest"],
        ))


if __name__ == "__main__":
    unittest.main()
