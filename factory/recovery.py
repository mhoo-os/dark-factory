"""Bounded reconciliation, retry, dead-letter, and stop decisions."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable


RETRYABLE_FAILURES = frozenset({"queue_timeout", "workflow_missing", "lease_expired", "provider_5xx"})
TERMINAL_FAILURES = frozenset({"invalid_contract", "signature_invalid", "scope_violation", "secret_detected"})


class StopStateUnreadable(RuntimeError):
    pass


@dataclass(frozen=True)
class RunSnapshot:
    dispatch_id: str
    state: str
    workflow_expected: bool = False
    workflow_live: bool = False
    lease_owner: str | None = None
    lease_expires_at: int | None = None
    owner_live: bool = False
    dependency_ready: bool = True
    stop_requested: bool = False
    missed_webhook: bool = False
    external_state_changed: bool = False
    failure_class: str | None = None
    attempts: int = 0
    max_attempts: int = 2


@dataclass(frozen=True)
class RecoveryAction:
    dispatch_id: str
    action: str
    reason: str
    target_state: str | None = None
    retry: bool = False
    notify: bool = False


@dataclass(frozen=True)
class DeadLetter:
    dispatch_id: str
    original_event_id: str
    payload_digest: str
    reason: str
    attempts: int


@dataclass(frozen=True)
class ReplayDecision:
    outcome: str
    event_id: str
    dispatch_id: str
    reason: str


def read_stop_state(*, local_present: bool, remote_readable: bool, remote_present: bool) -> bool:
    if not remote_readable:
        raise StopStateUnreadable("remote_stop_state_unreadable")
    return local_present or remote_present


def classify_failure(failure_class: str, *, attempts: int, max_attempts: int) -> RecoveryAction:
    if failure_class in RETRYABLE_FAILURES and attempts < max_attempts:
        return RecoveryAction("", "retry", failure_class, "queued", retry=True)
    if failure_class in RETRYABLE_FAILURES:
        return RecoveryAction("", "dead-letter", "retry_cap_reached", "failed", notify=True)
    if failure_class in TERMINAL_FAILURES:
        return RecoveryAction("", "escalate", failure_class, "needs-human", notify=True)
    return RecoveryAction("", "escalate", "unknown_failure_class", "needs-human", notify=True)


def reconcile(runs: Iterable[RunSnapshot], *, now: int, stop_readable: bool = True) -> tuple[RecoveryAction, ...]:
    """Return stable recovery actions; healthy input produces no actions."""
    if not stop_readable:
        raise StopStateUnreadable("stop_state_unreadable")
    actions: list[RecoveryAction] = []
    for run in sorted(runs, key=lambda item: item.dispatch_id):
        if run.stop_requested and run.state in {"queued", "leased", "running"}:
            actions.append(RecoveryAction(run.dispatch_id, "stop", "stop_requested", "stopped"))
            continue
        if run.failure_class:
            decision = classify_failure(run.failure_class, attempts=run.attempts, max_attempts=run.max_attempts)
            actions.append(RecoveryAction(run.dispatch_id, decision.action, decision.reason, decision.target_state, decision.retry, decision.notify))
            continue
        if run.state == "blocked-by-dependency" and run.dependency_ready:
            actions.append(RecoveryAction(run.dispatch_id, "queue", "dependency_completed", "queued"))
            continue
        if run.state == "queued" and run.workflow_expected and not run.workflow_live:
            actions.append(RecoveryAction(run.dispatch_id, "restart-workflow", "workflow_missing", retry=True))
            continue
        lease_stale = run.lease_expires_at is not None and run.lease_expires_at <= now
        lease_missing = not run.lease_owner or not run.owner_live
        if run.state == "leased" and (lease_stale or lease_missing or not run.workflow_live):
            actions.append(RecoveryAction(run.dispatch_id, "requeue", "stale_or_missing_lease", "queued", retry=True))
            continue
        if run.state == "running" and (lease_stale or lease_missing or not run.workflow_live):
            actions.append(RecoveryAction(run.dispatch_id, "escalate", "running_workflow_lost", "needs-human", notify=True))
            continue
        if run.missed_webhook:
            actions.append(RecoveryAction(run.dispatch_id, "reconcile-event", "missed_webhook"))
            continue
        if run.external_state_changed and run.state in {"pr-open", "pr-passed"}:
            actions.append(RecoveryAction(run.dispatch_id, "reconcile-external-state", "external_state_changed", "reconciliation-only"))
    return tuple(actions)


def replay_dead_letter(item: DeadLetter, *, seen_event_ids: set[str]) -> ReplayDecision:
    if item.original_event_id in seen_event_ids:
        return ReplayDecision("duplicate", item.original_event_id, item.dispatch_id, "original_event_already_seen")
    return ReplayDecision("replay", item.original_event_id, item.dispatch_id, "original_identity_preserved")
