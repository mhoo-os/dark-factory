"""Deterministic Linear/GitHub reconciliation intents for one factory run."""
from __future__ import annotations

from dataclasses import dataclass
import hashlib
import json
import re
from typing import Any, Iterable, Mapping

from factory.state_contract import STATES, TRANSITIONS

SHA = re.compile(r"^[0-9a-f]{40}$", re.IGNORECASE)
RECEIPT_MARKER = "mhoo-factory-execution-v1"


@dataclass(frozen=True)
class RunBinding:
    dispatch_id: str
    run_id: str
    contract_digest: str
    linear_project_id: str
    linear_issue_id: str
    planning_revision: str
    planning_fingerprint: str
    repository: str
    base_sha: str
    branch: str
    current_state: str
    expected_head_sha: str | None = None
    pr_number: int | None = None


@dataclass(frozen=True)
class LinearObservation:
    project_id: str
    issue_id: str
    planning_revision: str
    planning_fingerprint: str


@dataclass(frozen=True)
class GitHubObservation:
    repository: str
    pr_number: int
    branch: str
    state: str
    merged: bool
    base_sha: str
    head_sha: str
    pr_url: str


@dataclass(frozen=True)
class ReconciliationInput:
    binding: RunBinding
    linear: LinearObservation
    github: GitHubObservation | None


@dataclass(frozen=True)
class WriteIntent:
    key: str
    provider: str
    operation: str
    target: str
    payload: Mapping[str, Any]
    digest: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "key": self.key, "provider": self.provider, "operation": self.operation,
            "target": self.target, "payload": dict(self.payload), "digest": self.digest,
        }


@dataclass(frozen=True)
class ReconciliationDecision:
    outcome: str
    state: str
    reason: str
    transition: bool
    bind_pr: bool
    writes: tuple[WriteIntent, ...]

    def to_dict(self) -> dict[str, Any]:
        return {
            "outcome": self.outcome, "state": self.state, "reason": self.reason,
            "transition": self.transition, "bind_pr": self.bind_pr,
            "writes": [item.to_dict() for item in self.writes],
        }


def _digest(value: Any) -> str:
    raw = json.dumps(value, sort_keys=True, separators=(",", ":")).encode()
    return "sha256:" + hashlib.sha256(raw).hexdigest()


def _write(key: str, provider: str, operation: str, target: str, payload: Mapping[str, Any]) -> WriteIntent:
    return WriteIntent(key, provider, operation, target, payload, _digest(payload))


def _legal(binding: RunBinding, state: str, actor: str = "reconciler") -> bool:
    return state == binding.current_state or (binding.current_state, state) in TRANSITIONS and actor in TRANSITIONS[(binding.current_state, state)]


def _writes(intents: Iterable[WriteIntent], applied: Mapping[str, str] | None) -> tuple[WriteIntent, ...]:
    applied = applied or {}
    return tuple(item for item in intents if applied.get(item.key) != item.digest)


def _decision(
    item: ReconciliationInput,
    *,
    outcome: str,
    state: str,
    reason: str,
    bind_pr: bool = False,
    applied_write_digests: Mapping[str, str] | None = None,
) -> ReconciliationDecision:
    binding, github = item.binding, item.github
    payload = {
        "marker": RECEIPT_MARKER, "run_id": binding.run_id, "dispatch_id": binding.dispatch_id,
        "state": state, "reason": reason, "repository": binding.repository,
        "base_sha": binding.base_sha, "head_sha": github.head_sha if github else binding.expected_head_sha,
        "pr_number": github.pr_number if github else binding.pr_number,
    }
    intents: list[WriteIntent] = []
    if bind_pr and github is not None:
        intents.append(_write(
            f"github:pr-binding:{binding.run_id}", "github", "bind_pr", binding.run_id,
            {"repository": github.repository, "pr_number": github.pr_number, "pr_url": github.pr_url, "branch": github.branch, "base_sha": github.base_sha, "head_sha": github.head_sha},
        ))
    intents.append(_write(
        f"linear:execution-receipt:{binding.run_id}", "linear", "upsert_execution_receipt",
        binding.linear_issue_id, payload,
    ))
    return ReconciliationDecision(outcome, state, reason, state != binding.current_state, bind_pr, _writes(intents, applied_write_digests))


def reconcile(item: ReconciliationInput, *, applied_write_digests: Mapping[str, str] | None = None) -> ReconciliationDecision:
    """Reconcile external observations without mutating Linear planning content."""
    binding, linear, github = item.binding, item.linear, item.github
    if binding.current_state not in STATES:
        return ReconciliationDecision("needs-human", "needs-human", "unknown_factory_state", False, False, ())
    if (linear.project_id, linear.issue_id) != (binding.linear_project_id, binding.linear_issue_id):
        return ReconciliationDecision("needs-human", "needs-human", "linear_identity_mismatch", False, False, ())
    if (binding.repository, binding.base_sha) == ("", "") or not SHA.fullmatch(binding.base_sha) or (binding.expected_head_sha is not None and not SHA.fullmatch(binding.expected_head_sha)):
        return ReconciliationDecision("needs-human", "needs-human", "binding_identity_invalid", False, False, ())
    if binding.current_state == "pr-passed" and binding.expected_head_sha is None:
        return ReconciliationDecision("needs-human", "needs-human", "validated_head_missing", False, False, ())
    if (linear.planning_revision, linear.planning_fingerprint) != (binding.planning_revision, binding.planning_fingerprint):
        state = "needs-replan" if _legal(binding, "needs-replan") else "needs-human"
        return _decision(item, outcome=state, state=state, reason="planning_snapshot_changed", applied_write_digests=applied_write_digests)
    if github is None:
        state = "reconciliation-only" if _legal(binding, "reconciliation-only") else "needs-human"
        return _decision(item, outcome=state, state=state, reason="github_pr_missing", applied_write_digests=applied_write_digests)
    if github.repository != binding.repository or github.branch != binding.branch:
        return ReconciliationDecision("needs-human", "needs-human", "github_identity_mismatch", False, False, ())
    if binding.pr_number is not None and github.pr_number != binding.pr_number:
        return ReconciliationDecision("needs-human", "needs-human", "github_pr_number_mismatch", False, False, ())
    if github.pr_number < 1 or github.state not in {"open", "closed"} or not SHA.fullmatch(github.base_sha) or not SHA.fullmatch(github.head_sha):
        return ReconciliationDecision("needs-human", "needs-human", "github_observation_invalid", False, False, ())
    if github.merged and github.state != "closed":
        return ReconciliationDecision("needs-human", "needs-human", "github_merge_state_invalid", False, False, ())
    if github.base_sha != binding.base_sha:
        state = "needs-replan" if _legal(binding, "needs-replan") else "needs-human"
        return _decision(item, outcome=state, state=state, reason="github_base_changed", applied_write_digests=applied_write_digests)
    bind_pr = binding.pr_number is None
    if github.merged:
        state = "pr-merged" if _legal(binding, "pr-merged", "external-github") else "needs-human"
        return _decision(item, outcome=state, state=state, reason="github_pr_merged", bind_pr=bind_pr, applied_write_digests=applied_write_digests)
    if github.state == "closed":
        state = "pr-canceled" if _legal(binding, "pr-canceled", "external-github") else "needs-human"
        return _decision(item, outcome=state, state=state, reason="github_pr_closed", bind_pr=bind_pr, applied_write_digests=applied_write_digests)
    if binding.current_state in {"pr-canceled", "pr-merged"}:
        return ReconciliationDecision("needs-human", "needs-human", "terminal_pr_reopened_or_reappeared", False, bind_pr, ())
    if binding.expected_head_sha and github.head_sha != binding.expected_head_sha:
        state = "reconciliation-only" if _legal(binding, "reconciliation-only", "external-github") else "needs-human"
        return _decision(item, outcome=state, state=state, reason="github_head_changed_since_validation", bind_pr=bind_pr, applied_write_digests=applied_write_digests)
    state = binding.current_state
    if state == "reconciliation-only":
        state = "pr-open"
    if not _legal(binding, state, "external-github"):
        return ReconciliationDecision("needs-human", "needs-human", "illegal_external_transition", False, bind_pr, ())
    return _decision(item, outcome="reconciled", state=state, reason="external_state_current", bind_pr=bind_pr, applied_write_digests=applied_write_digests)
