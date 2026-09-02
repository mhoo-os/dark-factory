"""Provider-neutral durable workflow contract for one admitted factory run."""
from __future__ import annotations

from dataclasses import asdict, dataclass, is_dataclass
import hashlib
import json
import re
from typing import Any, Protocol

from factory.dispatch_contract import DispatchContract
from factory.ground import RepositorySnapshot, ground_contract

SHA = re.compile(r"^[0-9a-f]{40}$", re.IGNORECASE)
SAFE_FAILURES = frozenset({
    "lease_unavailable", "grounding_failed", "implementation_failed", "validation_failed",
    "review_failed", "publish_failed", "lease_release_failed", "workflow_restarted",
})


class WorkflowFailure(RuntimeError):
    """A named durable failure that must become a state, not an implicit retry loop."""


class WorkflowCrash(RuntimeError):
    """The durable store failed; retry with the same step identities."""


@dataclass(frozen=True)
class WorkflowRequest:
    contract: DispatchContract
    run_id: str
    snapshot: RepositorySnapshot
    max_fix_attempts: int = 2
    max_cost_usd: float = 8.0
    stop_requested: bool = False
    stop_readable: bool = True


@dataclass(frozen=True)
class StepRecord:
    run_id: str
    key: str
    status: str
    result: Any = None


class WorkflowStore(Protocol):
    """D1/R2-backed store required by the real Worker implementation."""

    def get_step(self, run_id: str, key: str) -> StepRecord | None: ...
    def begin_step(self, run_id: str, key: str) -> StepRecord: ...
    def complete_step(self, run_id: str, key: str, result: Any) -> StepRecord: ...
    def record_event(self, run_id: str, key: str, event_type: str, details: dict[str, Any]) -> None: ...
    def list_steps(self, run_id: str) -> tuple[StepRecord, ...]: ...


@dataclass(frozen=True)
class LeaseReceipt:
    owner: str
    fence: int


@dataclass(frozen=True)
class ImplementationResult:
    status: str
    base_sha: str
    head_sha: str | None
    diff_digest: str | None
    changed_files: tuple[str, ...] = ()
    reason: str = ""
    output_digests: tuple[str, ...] = ()
    cost_usd: float = 0.0


@dataclass(frozen=True)
class ValidationInput:
    contract_digest: str
    base_sha: str
    head_sha: str
    diff_digest: str
    changed_files: tuple[str, ...]
    output_digests: tuple[str, ...]


@dataclass(frozen=True)
class ValidationResult:
    outcome: str
    findings: tuple[str, ...] = ()
    protected_violation: bool = False
    judgement_value: bool = False


@dataclass(frozen=True)
class ReviewResult:
    outcome: str
    protected_violation: bool = False
    judgement_value: bool = False
    reason: str = ""


@dataclass(frozen=True)
class PRReceipt:
    number: int
    url: str
    head_sha: str
    idempotency_key: str


class WorkflowBackend(Protocol):
    """Side effects receive a stable key and must reconcile it idempotently."""

    def acquire_lease(self, request: WorkflowRequest, idempotency_key: str) -> LeaseReceipt: ...
    def implement(self, request: WorkflowRequest, grounding: Any, findings: tuple[str, ...], attempt: int, idempotency_key: str) -> ImplementationResult: ...
    def validate(self, request: WorkflowRequest, input: ValidationInput, attempt: int, idempotency_key: str) -> ValidationResult: ...
    def review(self, request: WorkflowRequest, implementation: ImplementationResult, validation: ValidationResult, idempotency_key: str) -> ReviewResult: ...
    def publish_pr(self, request: WorkflowRequest, implementation: ImplementationResult, idempotency_key: str) -> PRReceipt: ...
    def release_lease(self, request: WorkflowRequest, lease: LeaseReceipt, idempotency_key: str) -> None: ...


@dataclass(frozen=True)
class WorkflowReceipt:
    status: str
    state: str
    reason: str
    dispatch_id: str
    run_id: str
    attempt: int
    pr: PRReceipt | None
    step_keys: tuple[str, ...]
    digest: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "status": self.status, "state": self.state, "reason": self.reason,
            "dispatch_id": self.dispatch_id, "run_id": self.run_id, "attempt": self.attempt,
            "pr": self.pr.__dict__ if self.pr else None, "step_keys": list(self.step_keys), "digest": self.digest,
        }


def _digest(value: Any) -> str:
    raw = json.dumps(value, sort_keys=True, separators=(",", ":")).encode()
    return "sha256:" + hashlib.sha256(raw).hexdigest()


def _safe_result(value: Any) -> Any:
    if hasattr(value, "to_dict"):
        return value.to_dict()
    if is_dataclass(value):
        return asdict(value)
    return value


def _safe_failure(error: WorkflowFailure) -> str:
    value = str(error)
    return value if value in SAFE_FAILURES else "workflow_failure"


class DurableWorkflow:
    """Execute the fixed ground -> implement -> validate -> review -> PR path."""

    def __init__(self, store: WorkflowStore, backend: WorkflowBackend):
        self.store, self.backend = store, backend

    def _step(self, request: WorkflowRequest, key: str, action: Any) -> Any:
        existing = self.store.get_step(request.run_id, key)
        if existing and existing.status == "completed":
            return existing.result
        self.store.begin_step(request.run_id, key)
        self.store.record_event(request.run_id, key, "started", {})
        try:
            result = action(f"{request.run_id}:{key}")
        except WorkflowFailure as error:
            self.store.record_event(request.run_id, key, "failed", {"reason": _safe_failure(error)})
            raise
        self.store.complete_step(request.run_id, key, result)
        self.store.record_event(request.run_id, key, "completed", {"result_digest": _digest(_safe_result(result))})
        return result

    def _receipt(self, request: WorkflowRequest, state: str, reason: str, attempt: int, pr: PRReceipt | None) -> WorkflowReceipt:
        keys = tuple(item.key for item in self.store.list_steps(request.run_id))
        payload = {"state": state, "reason": reason, "dispatch_id": request.contract.dispatch_id, "run_id": request.run_id, "attempt": attempt, "pr": pr.__dict__ if pr else None, "step_keys": keys}
        return WorkflowReceipt("completed", state, reason, request.contract.dispatch_id, request.run_id, attempt, pr, keys, _digest(payload))

    def _finish(self, request: WorkflowRequest, lease: LeaseReceipt | None, state: str, reason: str, attempt: int, pr: PRReceipt | None) -> WorkflowReceipt:
        release_failed = False
        if lease is not None:
            try:
                self._step(request, "lease:release", lambda key: self.backend.release_lease(request, lease, key))
            except WorkflowFailure:
                state, reason = "needs-human", "lease_release_failed"
                release_failed = True
        receipt = self._receipt(request, state, reason, attempt, pr)
        if release_failed:
            self.store.record_event(request.run_id, "workflow:final", "blocked", {"reason": reason})
            return receipt
        return self._step(request, "workflow:final", lambda _: receipt)

    def run(self, request: WorkflowRequest) -> WorkflowReceipt:
        final = self.store.get_step(request.run_id, "workflow:final")
        release = self.store.get_step(request.run_id, "lease:release")
        if final and final.status == "completed" and (release is None or release.status == "completed"):
            return final.result
        if not request.stop_readable:
            return self._finish(request, None, "stopped", "stop_state_unreadable", 0, None)
        if request.stop_requested:
            return self._finish(request, None, "stopped", "stop_requested", 0, None)
        if request.max_fix_attempts < 0 or request.max_fix_attempts > 2:
            return self._finish(request, None, "needs-human", "fix_cap_invalid", 0, None)
        if not isinstance(request.max_cost_usd, (int, float)) or isinstance(request.max_cost_usd, bool) or request.max_cost_usd < 0:
            return self._finish(request, None, "needs-human", "cost_cap_invalid", 0, None)

        lease: LeaseReceipt | None = None
        try:
            lease = self._step(request, "lease:acquire", lambda key: self.backend.acquire_lease(request, key))
            grounding = self._step(request, "ground", lambda _: ground_contract(request.contract, request.snapshot))
            if grounding.outcome != "grounded":
                return self._finish(request, lease, "needs-replan", "grounding_" + grounding.outcome, 0, None)

            validation: ValidationResult | None = None
            implementation: ImplementationResult | None = None
            attempt = 0
            for attempt in range(request.max_fix_attempts + 1):
                findings = validation.findings if validation else ()
                key = "implement:0" if attempt == 0 else f"fix:{attempt}"
                implementation = self._step(
                    request, key,
                    lambda step_key, attempt=attempt, findings=findings: self.backend.implement(request, grounding, findings, attempt, step_key),
                )
                if implementation.status != "passed":
                    state = "reconciliation-only" if implementation.status == "sandbox-lost" else "needs-human"
                    return self._finish(request, lease, state, implementation.reason or "implementation_failed", attempt, None)
                if implementation.base_sha != request.snapshot.base_sha or not implementation.head_sha or not SHA.fullmatch(implementation.head_sha) or not implementation.diff_digest:
                    return self._finish(request, lease, "needs-human", "implementation_identity_invalid", attempt, None)
                if not isinstance(implementation.cost_usd, (int, float)) or isinstance(implementation.cost_usd, bool) or implementation.cost_usd < 0 or implementation.cost_usd > request.max_cost_usd:
                    return self._finish(request, lease, "needs-human", "cost_cap_exceeded", attempt, None)
                input = ValidationInput(request.contract.digest, implementation.base_sha, implementation.head_sha, implementation.diff_digest, implementation.changed_files, implementation.output_digests)
                validation = self._step(
                    request, f"validate:{attempt}",
                    lambda step_key, attempt=attempt, input=input: self.backend.validate(request, input, attempt, step_key),
                )
                if validation.protected_violation or validation.judgement_value:
                    return self._finish(request, lease, "needs-human", "validation_requires_human", attempt, None)
                if validation.outcome == "pass":
                    break
                if validation.outcome != "fixable" or attempt >= request.max_fix_attempts:
                    return self._finish(request, lease, "failed", "validation_not_repaired", attempt, None)

            review = self._step(request, f"review:{attempt}", lambda key: self.backend.review(request, implementation, validation, key))
            if review.outcome != "ready" or review.protected_violation or review.judgement_value:
                return self._finish(request, lease, "needs-human", review.reason or "review_requires_human", attempt, None)
            pr = self._step(request, f"publish-pr:{attempt}", lambda key: self.backend.publish_pr(request, implementation, key))
            if pr.head_sha != implementation.head_sha:
                return self._finish(request, lease, "needs-human", "pr_head_identity_invalid", attempt, None)
            return self._finish(request, lease, "pr-open", "pr_published", attempt, pr)
        except WorkflowFailure as error:
            return self._finish(request, lease, "needs-human", _safe_failure(error), 0, None)
