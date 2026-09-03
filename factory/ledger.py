"""SQLite/D1-compatible durable run ledger with idempotent state writes."""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
import sqlite3
from pathlib import Path
from typing import Any, Mapping

from factory.dispatch_contract import DispatchContract
from factory.state_contract import TERMINAL_STATES, decide_transition


SCHEMA_VERSION = 4
SCHEMA = Path(__file__).with_name("ledger_schema.sql").read_text()


class LedgerConflict(RuntimeError):
    pass


class LedgerNotFound(KeyError):
    pass


@dataclass(frozen=True)
class AdmissionReceipt:
    dispatch_id: str
    run_id: str
    digest: str
    created: bool


@dataclass(frozen=True)
class TransitionReceipt:
    outcome: str
    reason: str
    state: str
    sequence: int


@dataclass(frozen=True)
class IngressReceipt:
    event_id: str
    handoff_state: str
    duplicate: bool


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


class Ledger:
    def __init__(self, connection: sqlite3.Connection):
        self.connection = connection
        self.connection.row_factory = sqlite3.Row
        self.connection.execute("PRAGMA foreign_keys = ON")
        self.connection.executescript(SCHEMA)

    def _run(self, dispatch_id: str) -> sqlite3.Row:
        row = self.connection.execute(
            "SELECT * FROM factory_runs WHERE dispatch_id = ?", (dispatch_id,)
        ).fetchone()
        if row is None:
            raise LedgerNotFound(dispatch_id)
        return row

    def admit(self, contract: DispatchContract, run_id: str, *, now: str | None = None) -> AdmissionReceipt:
        if not run_id:
            raise LedgerConflict("run_id_missing")
        document = contract.to_dict()
        linear = document["linear"]
        target = document["target"]
        registry = document.get("registry")
        if not isinstance(registry, Mapping):
            raise LedgerConflict("registry_identity_missing")
        timestamp = now or utc_now()
        terminals = tuple(sorted(TERMINAL_STATES))
        placeholders = ",".join("?" for _ in terminals)
        self.connection.execute("BEGIN IMMEDIATE")
        try:
            existing = self.connection.execute(
                "SELECT run_id, contract_digest FROM factory_runs WHERE dispatch_id = ?",
                (contract.dispatch_id,),
            ).fetchone()
            if existing is not None:
                if existing["contract_digest"] != contract.digest:
                    raise LedgerConflict("dispatch_digest_conflict")
                self.connection.commit()
                return AdmissionReceipt(contract.dispatch_id, existing["run_id"], contract.digest, False)
            active = self.connection.execute(
                f"SELECT dispatch_id FROM factory_runs WHERE linear_issue_id = ? AND current_state NOT IN ({placeholders})",
                (linear["issue_id"], *terminals),
            ).fetchone()
            if active is not None:
                raise LedgerConflict("active_execution_for_issue")
            self.connection.execute(
                """INSERT INTO factory_runs(
                  dispatch_id, run_id, contract_version, contract_digest,
                  factory_id, registry_version, registry_digest, registry_entry_version,
                  linear_project_id, linear_issue_id, linear_identifier,
                  planning_revision, planning_fingerprint, repository,
                  execution_profile, validation_profile, collision_group,
                  current_state, base_sha, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'admitted', ?, ?, ?)""",
                (
                    contract.dispatch_id, run_id, document["contract_version"], contract.digest,
                    registry["factory_id"], registry["registry_version"], registry["registry_digest"], registry["entry_version"],
                    linear["project_id"], linear["issue_id"], linear["identifier"],
                    linear["planning_revision"], linear["planning_fingerprint"], target["repository"],
                    target["execution_profile"], document["validation_profile"], target["collision_group"],
                    target["base_sha"], timestamp, timestamp,
                ),
            )
            admission_event_id = f"admission:{contract.dispatch_id}"
            self.connection.execute(
                "INSERT INTO factory_events(event_id, dispatch_id, event_sequence, event_type, factory_id, registry_version, registry_digest, registry_entry_version, payload_digest, accepted, reason, received_at) VALUES (?, ?, 1, 'state:admitted', ?, ?, ?, ?, ?, 1, 'accepted', ?)",
                (admission_event_id, contract.dispatch_id, registry["factory_id"], registry["registry_version"], registry["registry_digest"], registry["entry_version"], contract.digest, timestamp),
            )
            self.connection.execute(
                "INSERT INTO factory_transitions(dispatch_id, event_sequence, event_id, from_state, to_state, actor, factory_id, registry_version, registry_digest, registry_entry_version, created_at) VALUES (?, 1, ?, 'proposed', 'admitted', 'admission', ?, ?, ?, ?, ?)",
                (contract.dispatch_id, admission_event_id, registry["factory_id"], registry["registry_version"], registry["registry_digest"], registry["entry_version"], timestamp),
            )
            self.connection.commit()
            return AdmissionReceipt(contract.dispatch_id, run_id, contract.digest, True)
        except Exception:
            self.connection.rollback()
            raise

    def transition(
        self,
        dispatch_id: str,
        to_state: str,
        *,
        actor: str,
        event_id: str,
        event_sequence: int,
        payload_digest: str | None = None,
        now: str | None = None,
    ) -> TransitionReceipt:
        timestamp = now or utc_now()
        self.connection.execute("BEGIN IMMEDIATE")
        try:
            row = self._run(dispatch_id)
            current_sequence = self.connection.execute(
                "SELECT COALESCE(MAX(event_sequence), 0) FROM factory_transitions WHERE dispatch_id = ?",
                (dispatch_id,),
            ).fetchone()[0]
            seen = {
                item[0] for item in self.connection.execute(
                    "SELECT event_id FROM factory_events WHERE dispatch_id = ?", (dispatch_id,)
                ).fetchall()
            }
            decision = decide_transition(
                row["current_state"], to_state, actor=actor, event_id=event_id,
                event_sequence=event_sequence, current_sequence=current_sequence, seen_event_ids=seen,
            )
            if decision.reason == "replayed_event":
                self.connection.rollback()
                return TransitionReceipt("rejected", decision.reason, row["current_state"], current_sequence)
            self.connection.execute(
                "INSERT INTO factory_events(event_id, dispatch_id, event_sequence, event_type, factory_id, registry_version, registry_digest, registry_entry_version, payload_digest, accepted, reason, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (event_id, dispatch_id, event_sequence, f"state:{to_state}", row["factory_id"], row["registry_version"], row["registry_digest"], row["registry_entry_version"], payload_digest, decision.outcome == "accepted", decision.reason, timestamp),
            )
            if decision.outcome != "accepted":
                self.connection.commit()
                return TransitionReceipt("rejected", decision.reason, row["current_state"], current_sequence)
            self.connection.execute(
                "INSERT INTO factory_transitions(dispatch_id, event_sequence, event_id, from_state, to_state, actor, factory_id, registry_version, registry_digest, registry_entry_version, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (dispatch_id, event_sequence, event_id, row["current_state"], to_state, actor, row["factory_id"], row["registry_version"], row["registry_digest"], row["registry_entry_version"], timestamp),
            )
            self.connection.execute(
                "UPDATE factory_runs SET current_state = ?, updated_at = ? WHERE dispatch_id = ?",
                (to_state, timestamp, dispatch_id),
            )
            self.connection.commit()
            return TransitionReceipt("accepted", decision.reason, to_state, event_sequence)
        except Exception:
            self.connection.rollback()
            raise

    def record_evidence(
        self,
        *,
        evidence_id: str,
        dispatch_id: str,
        run_id: str,
        attempt: int,
        kind: str,
        digest: str,
        artifact_ref: str,
        redacted: bool,
        now: str | None = None,
    ) -> None:
        if not redacted:
            raise LedgerConflict("unredacted_evidence_refused")
        run = self._run(dispatch_id)
        self.connection.execute(
            "INSERT INTO factory_evidence(evidence_id, dispatch_id, run_id, attempt, kind, factory_id, registry_version, registry_digest, registry_entry_version, digest, artifact_ref, redacted, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)",
            (evidence_id, dispatch_id, run_id, attempt, kind, run["factory_id"], run["registry_version"], run["registry_digest"], run["registry_entry_version"], digest, artifact_ref, now or utc_now()),
        )
        self.connection.commit()

    def run(self, dispatch_id: str) -> Mapping[str, Any]:
        return dict(self._run(dispatch_id))

    def record_pr_receipt(self, *, receipt_id: str, dispatch_id: str, pr_number: int, pr_url: str, head_sha: str, now: str | None = None) -> None:
        run = self._run(dispatch_id)
        self.connection.execute(
            "INSERT INTO factory_pr_receipts(receipt_id, dispatch_id, run_id, pr_number, pr_url, head_sha, factory_id, registry_version, registry_digest, registry_entry_version, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (receipt_id, dispatch_id, run["run_id"], pr_number, pr_url, head_sha, run["factory_id"], run["registry_version"], run["registry_digest"], run["registry_entry_version"], now or utc_now()),
        )
        self.connection.commit()

    def record_linear_reconciliation(self, *, reconciliation_id: str, dispatch_id: str, state: str, reason: str, now: str | None = None) -> None:
        run = self._run(dispatch_id)
        self.connection.execute(
            "INSERT INTO factory_linear_reconciliations(reconciliation_id, dispatch_id, run_id, state, reason, factory_id, registry_version, registry_digest, registry_entry_version, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (reconciliation_id, dispatch_id, run["run_id"], state, reason, run["factory_id"], run["registry_version"], run["registry_digest"], run["registry_entry_version"], now or utc_now()),
        )
        self.connection.commit()

    def events(self, dispatch_id: str) -> list[Mapping[str, Any]]:
        self._run(dispatch_id)
        return [dict(row) for row in self.connection.execute(
            "SELECT * FROM factory_events WHERE dispatch_id = ? ORDER BY rowid", (dispatch_id,)
        )]

    def reserve_ingress(self, event_id: str, provider: str, event_type: str, payload_digest: str, *, now: str | None = None) -> IngressReceipt:
        if not event_id or not provider or not event_type or not payload_digest:
            raise LedgerConflict("ingress_identity_missing")
        timestamp = now or utc_now()
        self.connection.execute("BEGIN IMMEDIATE")
        try:
            existing = self.connection.execute(
                "SELECT provider, event_type, payload_digest, handoff_state FROM factory_ingress_events WHERE event_id = ?", (event_id,)
            ).fetchone()
            if existing is not None:
                if (existing["provider"], existing["event_type"], existing["payload_digest"]) != (provider, event_type, payload_digest):
                    raise LedgerConflict("ingress_identity_conflict")
                self.connection.commit()
                return IngressReceipt(event_id, existing["handoff_state"], True)
            self.connection.execute(
                "INSERT INTO factory_ingress_events(event_id, provider, event_type, payload_digest, handoff_state, received_at) VALUES (?, ?, ?, ?, 'pending', ?)",
                (event_id, provider, event_type, payload_digest, timestamp),
            )
            self.connection.commit()
            return IngressReceipt(event_id, "pending", False)
        except Exception:
            self.connection.rollback()
            raise

    def mark_ingress_enqueued(self, event_id: str, *, now: str | None = None) -> None:
        updated = self.connection.execute(
            "UPDATE factory_ingress_events SET handoff_state = 'enqueued', enqueued_at = ? WHERE event_id = ? AND handoff_state = 'pending'",
            (now or utc_now(), event_id),
        ).rowcount
        self.connection.commit()
        if updated != 1:
            raise LedgerConflict("ingress_handoff_not_pending")

    def bind_ingress(self, event_id: str, contract: DispatchContract) -> None:
        registry = contract.to_dict().get("registry")
        if not isinstance(registry, Mapping):
            raise LedgerConflict("registry_identity_missing")
        updated = self.connection.execute(
            "UPDATE factory_ingress_events SET factory_id=?, registry_version=?, registry_digest=?, registry_entry_version=? WHERE event_id=? AND handoff_state='pending'",
            (registry["factory_id"], registry["registry_version"], registry["registry_digest"], registry["entry_version"], event_id),
        ).rowcount
        self.connection.commit()
        if updated != 1:
            raise LedgerConflict("ingress_handoff_not_pending")

    def ingress(self, event_id: str) -> Mapping[str, Any]:
        row = self.connection.execute(
            "SELECT * FROM factory_ingress_events WHERE event_id = ?", (event_id,)
        ).fetchone()
        if row is None:
            raise LedgerNotFound(event_id)
        return dict(row)

    def pending_ingress(self) -> list[Mapping[str, Any]]:
        return [dict(row) for row in self.connection.execute(
            "SELECT * FROM factory_ingress_events WHERE handoff_state = 'pending' ORDER BY received_at, event_id"
        )]
