"""Independent, profile-bound product validation gate."""
from __future__ import annotations
import hashlib
import json
import re
from dataclasses import dataclass
from typing import Any, Protocol

SHA = re.compile(r"^[0-9a-f]{40}$", re.I)
DIGEST = re.compile(r"^sha256:[0-9a-f]{64}$")
NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}$")
CHECK = re.compile(r"^[A-Za-z0-9][A-Za-z0-9 ._:/@*+-]{0,191}$")
CHECK_STATES = frozenset({"passed", "failed", "skipped", "error"})
CLASSIFICATIONS = frozenset({"none", "fixable", "auto-reject", "needs-human"})
VERDICTS = frozenset({"pass", "fixable", "auto-reject", "needs-human"})


class GateValidationError(ValueError):
    def __init__(self, errors: list[str] | tuple[str, ...]):
        self.errors = tuple(errors)
        super().__init__(";".join(self.errors) or "product_gate_invalid")


def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


def _digest(value: Any) -> str:
    return "sha256:" + hashlib.sha256(_json(value).encode()).hexdigest()


def _text(value: Any, path: str, errors: list[str], pattern: re.Pattern[str] = NAME, nullable: bool = False) -> None:
    if nullable and value is None:
        return
    if not isinstance(value, str) or not value or len(value) > 256 or "\n" in value or "\r" in value or pattern.fullmatch(value) is None:
        errors.append(f"{path}.invalid")


def _dig(value: Any, path: str, errors: list[str], nullable: bool = False) -> None:
    _text(value, path, errors, DIGEST, nullable)


def _keys(value: Any, expected: set[str], path: str, errors: list[str]) -> dict[str, Any] | None:
    if not isinstance(value, dict):
        errors.append(f"{path}.type")
        return None
    errors.extend(f"{path}.missing:{key}" for key in sorted(expected - value.keys()))
    errors.extend(f"{path}.unexpected:{key}" for key in sorted(value.keys() - expected))
    return value


def _profile_digest(value: dict[str, Any]) -> str:
    return _digest(value)


class ValidationProfile:
    """Sealed copy of the profile selected by admission, not by the builder."""
    __slots__ = ("_canonical", "_digest")

    def __init__(self, *_args: Any, **_kwargs: Any):
        raise TypeError("use declare_profile")

    def __setattr__(self, _name: str, _value: Any) -> None:
        raise AttributeError("ValidationProfile is immutable")

    @property
    def digest(self) -> str:
        return self._digest

    def to_dict(self) -> dict[str, Any]:
        return json.loads(self._canonical)

    @property
    def profile_id(self) -> str:
        return self.to_dict()["id"]

    @property
    def checks(self) -> tuple[str, ...]:
        value = self.to_dict()
        ordered = value["quick_checks"] + value["full_checks"] + value["governance_checks"] + value["holdout_hooks"]
        return tuple(dict.fromkeys(ordered))

    @property
    def required_markers(self) -> tuple[str, ...]:
        return tuple(self.to_dict()["required_markers"])


def declare_profile(value: dict[str, Any]) -> ValidationProfile:
    """Validate and seal the base-pinned validation profile."""
    errors: list[str] = []
    item = _keys(value, {"id", "quick_checks", "full_checks", "required_markers", "governance_checks", "holdout_hooks", "merge_eligibility"}, "profile", errors)
    if item is None:
        raise GateValidationError(errors)
    _text(item.get("id"), "profile.id", errors)
    for field in ("quick_checks", "full_checks", "required_markers", "governance_checks", "holdout_hooks"):
        values = item.get(field)
        if not isinstance(values, list) or not values or len(values) > 64 or len(set(values)) != len(values):
            errors.append(f"profile.{field}.list")
        else:
            for index, value_item in enumerate(values):
                _text(value_item, f"profile.{field}[{index}]", errors, CHECK if field in {"quick_checks", "full_checks"} else NAME)
    _text(item.get("merge_eligibility"), "profile.merge_eligibility", errors)
    if errors:
        raise GateValidationError(errors)
    canonical = _json(value)
    profile = object.__new__(ValidationProfile)
    object.__setattr__(profile, "_canonical", canonical)
    object.__setattr__(profile, "_digest", _profile_digest(value))
    return profile


@dataclass(frozen=True)
class ProductGateRequest:
    run_id: str
    contract_digest: str
    repository: str
    base_sha: str
    head_sha: str
    profile_id: str
    profile_digest: str
    acceptance_criteria_digest: str
    governance_digest: str


@dataclass(frozen=True)
class FreshContext:
    context_id: str
    repository: str
    base_sha: str
    head_sha: str
    profile_digest: str
    contract_digest: str
    fresh: bool
    builder_reasoning_withheld: bool


@dataclass(frozen=True)
class CheckObservation:
    name: str
    repository: str
    base_sha: str
    head_sha: str
    profile_digest: str
    contract_digest: str
    status: str
    markers: tuple[str, ...] = ()
    evidence_digest: str | None = None
    evidence_ref: str | None = None
    duration_ms: int = 0
    classification: str = "none"

    def to_dict(self) -> dict[str, Any]:
        return {"name": self.name, "repository": self.repository, "base_sha": self.base_sha, "head_sha": self.head_sha, "profile_digest": self.profile_digest, "contract_digest": self.contract_digest, "status": self.status, "markers": list(self.markers), "evidence_digest": self.evidence_digest, "evidence_ref": self.evidence_ref, "duration_ms": self.duration_ms, "classification": self.classification}


class ValidationRunner(Protocol):
    """Runner contract; implementation must use a fresh independent environment."""
    def open_fresh_context(self, request: ProductGateRequest, idempotency_key: str) -> FreshContext: ...
    def run_check(self, request: ProductGateRequest, context: FreshContext, check: str, idempotency_key: str) -> CheckObservation: ...


@dataclass(frozen=True)
class ValidationVerdict:
    outcome: str
    reason: str
    gate_kind: str
    run_id: str
    contract_digest: str
    repository: str
    base_sha: str
    head_sha: str
    profile_id: str
    profile_digest: str
    acceptance_criteria_digest: str
    governance_digest: str
    required_markers: tuple[str, ...]
    observed_markers: tuple[str, ...]
    checks: tuple[CheckObservation, ...]
    evidence_digest: str

    def to_dict(self) -> dict[str, Any]:
        return {"outcome": self.outcome, "reason": self.reason, "gate_kind": self.gate_kind, "run_id": self.run_id, "contract_digest": self.contract_digest, "repository": self.repository, "base_sha": self.base_sha, "head_sha": self.head_sha, "profile_id": self.profile_id, "profile_digest": self.profile_digest, "acceptance_criteria_digest": self.acceptance_criteria_digest, "governance_digest": self.governance_digest, "required_markers": list(self.required_markers), "observed_markers": list(self.observed_markers), "checks": [item.to_dict() for item in self.checks], "evidence_digest": self.evidence_digest}


def _request_errors(request: ProductGateRequest, profile: ValidationProfile) -> list[str]:
    errors: list[str] = []
    _text(request.run_id, "request.run_id", errors, re.compile(r"^run-v1-[0-9a-f]{32}$"), False)
    for field in ("contract_digest", "profile_digest", "acceptance_criteria_digest", "governance_digest"):
        _dig(getattr(request, field), f"request.{field}", errors)
    _text(request.repository, "request.repository", errors, re.compile(r"^mhoo-os/[a-z0-9][a-z0-9._-]{0,99}$"))
    _text(request.base_sha, "request.base_sha", errors, SHA)
    _text(request.head_sha, "request.head_sha", errors, SHA)
    _text(request.profile_id, "request.profile_id", errors)
    if request.profile_id != profile.profile_id:
        errors.append("request.profile_id.mismatch")
    if request.profile_digest != profile.digest:
        errors.append("request.profile_digest.mismatch")
    return errors


def _invalid_verdict(request: ProductGateRequest, profile: ValidationProfile, reason: str) -> ValidationVerdict:
    payload = {"run_id": request.run_id, "reason": reason, "profile_digest": profile.digest}
    return ValidationVerdict("needs-human", reason, "product", request.run_id, request.contract_digest, request.repository, request.base_sha, request.head_sha, request.profile_id, request.profile_digest, request.acceptance_criteria_digest, request.governance_digest, profile.required_markers, (), (), _digest(payload))


def _observation_error(item: CheckObservation, request: ProductGateRequest, check: str) -> str | None:
    if not isinstance(item, CheckObservation) or item.name != check or item.repository != request.repository or item.base_sha != request.base_sha or item.head_sha != request.head_sha or item.profile_digest != request.profile_digest or item.contract_digest != request.contract_digest:
        return f"check_identity_invalid:{check}"
    if item.status not in CHECK_STATES or item.classification not in CLASSIFICATIONS:
        return f"check_observation_invalid:{check}"
    if (not isinstance(item.duration_ms, int) or isinstance(item.duration_ms, bool) or item.duration_ms < 0 or item.duration_ms > 86_400_000):
        return f"check_observation_invalid:{check}"
    if (not isinstance(item.markers, tuple) or len(item.markers) > 64 or
            any(not isinstance(marker, str) or NAME.fullmatch(marker) is None for marker in item.markers)):
        return f"check_observation_invalid:{check}"
    if item.evidence_digest is None and item.status == "skipped":
        return None
    if (not isinstance(item.evidence_digest, str) or DIGEST.fullmatch(item.evidence_digest) is None or
            item.evidence_ref is None):
        return f"check_evidence_missing:{check}"
    if item.evidence_ref is not None and (not isinstance(item.evidence_ref, str) or len(item.evidence_ref) > 256 or "\n" in item.evidence_ref or not item.evidence_ref.startswith("r2://runs/")):
        return f"check_evidence_ref_invalid:{check}"
    return None


def run_product_gate(request: ProductGateRequest, profile: ValidationProfile, runner: ValidationRunner) -> ValidationVerdict:
    """Run only the admitted profile and never accept a claim without evidence."""
    errors = _request_errors(request, profile)
    if errors:
        return _invalid_verdict(request, profile, errors[0])
    context: FreshContext | None = None
    try:
        context = runner.open_fresh_context(request, f"{request.run_id}:product-context")
    except Exception:
        return _invalid_verdict(request, profile, "fresh_context_open_failed")
    if (not isinstance(context, FreshContext) or context.fresh is not True or context.builder_reasoning_withheld is not True or
            (not isinstance(context.context_id, str) or not context.context_id or len(context.context_id) > 128) or context.repository != request.repository or
            context.base_sha != request.base_sha or context.head_sha != request.head_sha or
            context.profile_digest != request.profile_digest or context.contract_digest != request.contract_digest):
        return _invalid_verdict(request, profile, "fresh_context_identity_invalid")
    observations: list[CheckObservation] = []
    for check in profile.checks:
        try:
            observation = runner.run_check(request, context, check, f"{request.run_id}:product-check:{check}")
        except Exception:
            return _invalid_verdict(request, profile, f"check_execution_failed:{check}")
        error = _observation_error(observation, request, check)
        if error:
            return _invalid_verdict(request, profile, error)
        observations.append(observation)
    observed = tuple(sorted({marker for item in observations for marker in item.markers}))
    missing = tuple(marker for marker in profile.required_markers if marker not in observed)
    failing = next((item for item in observations if item.status != "passed"), None)
    if failing is not None:
        reason = "required_check_not_run" if failing.status == "skipped" else f"check_{failing.status}:{failing.name}"
        outcome = "auto-reject" if failing.status == "skipped" else (failing.classification if failing.classification != "none" else "needs-human")
    elif missing:
        outcome, reason = "auto-reject", "required_marker_missing"
    else:
        outcome, reason = "pass", "all_profile_checks_and_markers_passed"
    payload = {"request": request.__dict__, "required_markers": profile.required_markers, "observed_markers": observed, "checks": [item.to_dict() for item in observations], "outcome": outcome, "reason": reason}
    return ValidationVerdict(outcome, reason, "product", request.run_id, request.contract_digest, request.repository, request.base_sha, request.head_sha, request.profile_id, request.profile_digest, request.acceptance_criteria_digest, request.governance_digest, profile.required_markers, observed, tuple(observations), _digest(payload))
