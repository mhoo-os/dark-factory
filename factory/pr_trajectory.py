"""Provider-neutral binding for the independent PR trajectory evaluator."""
from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass
from typing import Any, Mapping

MARKER = "<!-- trajectory-reviewer:v1 -->"
SHA = re.compile(r"^[0-9a-f]{40}$", re.I)
DIGEST = re.compile(r"^sha256:[0-9a-f]{64}$")
REPOSITORY = re.compile(r"^mhoo-os/[a-z0-9][a-z0-9._-]{0,99}$")
PATH = re.compile(r"^[A-Za-z0-9._/@-]{1,256}$")
RUN_ID = re.compile(r"^run-v1-[0-9a-f]{32}$")
REF = re.compile(r"^r2://runs/[A-Za-z0-9._/@-]{1,256}$")
STATUSES = frozenset({"PASS", "FAIL", "NON_FINAL"})
TIER1_STATUSES = frozenset({"PASS", "FAIL", "UNKNOWN"})
MANIFEST_STATUSES = frozenset({"valid", "missing", "invalid"})


class TrajectoryValidationError(ValueError):
    def __init__(self, errors: list[str] | tuple[str, ...]):
        self.errors = tuple(errors)
        super().__init__(";".join(self.errors) or "trajectory_invalid")


def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


def _digest(value: Any) -> str:
    return "sha256:" + hashlib.sha256(_json(value).encode()).hexdigest()


def _str(value: Any, pattern: re.Pattern[str], path: str, errors: list[str], nullable: bool = False) -> None:
    if nullable and value is None:
        return
    if not isinstance(value, str) or not value or len(value) > 512 or "\n" in value or "\r" in value or pattern.fullmatch(value) is None:
        errors.append(f"{path}.invalid")


def _ref(value: Any) -> bool:
    return value is None or isinstance(value, str) and REF.fullmatch(value) is not None


@dataclass(frozen=True)
class TrajectoryKey:
    repository: str
    pr_number: int
    head_sha: str
    base_sha: str
    rubric_digest: str | None

    @property
    def value(self) -> str:
        return f"trajectory-v1:{self.repository}:{self.pr_number}:{self.head_sha}:{self.base_sha}:{self.rubric_digest or 'not-configured'}"


def make_trajectory_key(repository: str, pr_number: int, head_sha: str, base_sha: str, rubric_digest: str | None) -> TrajectoryKey:
    errors: list[str] = []
    _str(repository, REPOSITORY, "key.repository", errors)
    if not isinstance(pr_number, int) or isinstance(pr_number, bool) or pr_number < 1:
        errors.append("key.pr_number.invalid")
    _str(head_sha, SHA, "key.head_sha", errors)
    _str(base_sha, SHA, "key.base_sha", errors)
    _str(rubric_digest, DIGEST, "key.rubric_digest", errors, rubric_digest is None)
    if errors:
        raise TrajectoryValidationError(errors)
    return TrajectoryKey(repository, pr_number, head_sha, base_sha, rubric_digest)


@dataclass(frozen=True)
class Tier1Evidence:
    status: str
    evidence_digest: str
    finding_codes: tuple[str, ...] = ()
    evidence_ref: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {"status": self.status, "evidence_digest": self.evidence_digest, "finding_codes": list(self.finding_codes), "evidence_ref": self.evidence_ref}


@dataclass(frozen=True)
class Tier2Evidence:
    outcome: str
    model_digest: str | None
    evidence_digest: str
    finding_digests: tuple[str, ...] = ()
    evidence_ref: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {"outcome": self.outcome, "model_digest": self.model_digest, "evidence_digest": self.evidence_digest, "finding_digests": list(self.finding_digests), "evidence_ref": self.evidence_ref}


@dataclass(frozen=True)
class TrajectoryRequest:
    run_id: str
    dispatch_id: str
    contract_digest: str
    key: TrajectoryKey
    base_manifest_status: str
    base_manifest_digest: str | None
    governing_source_digests: tuple[tuple[str, str], ...]
    tier1: Tier1Evidence | None
    tier2: Tier2Evidence | None


@dataclass(frozen=True)
class CommentIntent:
    key: str
    repository: str
    pr_number: int
    marker: str
    observation_key: str
    observation_digest: str

    def to_dict(self) -> dict[str, Any]:
        return {"key": self.key, "provider": "github", "operation": "upsert_marker_comment", "repository": self.repository, "pr_number": self.pr_number, "marker": self.marker, "observation_key": self.observation_key, "observation_digest": self.observation_digest}


@dataclass(frozen=True)
class TrajectoryDecision:
    outcome: str
    reason: str
    run_id: str
    key: TrajectoryKey
    observation_digest: str
    tier1: Tier1Evidence | None
    tier2: Tier2Evidence | None
    normalized_evaluation: Mapping[str, Any] | None
    comment: CommentIntent | None
    duplicate: bool
    supersedes: tuple[str, ...]

    def to_dict(self) -> dict[str, Any]:
        return {"outcome": self.outcome, "reason": self.reason, "run_id": self.run_id, "observation_key": self.key.value, "observation_digest": self.observation_digest, "tier1": self.tier1.to_dict() if self.tier1 else None, "tier2": self.tier2.to_dict() if self.tier2 else None, "normalized_evaluation": dict(self.normalized_evaluation) if self.normalized_evaluation else None, "comment": self.comment.to_dict() if self.comment else None, "duplicate": self.duplicate, "supersedes": list(self.supersedes)}


def _request_errors(request: TrajectoryRequest) -> list[str]:
    errors: list[str] = []
    _str(request.run_id, RUN_ID, "request.run_id", errors)
    _str(request.dispatch_id, re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,191}$"), "request.dispatch_id", errors)
    _str(request.contract_digest, DIGEST, "request.contract_digest", errors)
    if not isinstance(request.key, TrajectoryKey):
        errors.append("request.key.type")
    else:
        try:
            expected = make_trajectory_key(request.key.repository, request.key.pr_number, request.key.head_sha, request.key.base_sha, request.key.rubric_digest)
            if expected != request.key:
                errors.append("request.key.not_canonical")
        except TrajectoryValidationError as error:
            errors.extend(error.errors)
    if request.base_manifest_status not in MANIFEST_STATUSES:
        errors.append("request.base_manifest_status.invalid")
    if request.base_manifest_status == "valid":
        _str(request.base_manifest_digest, DIGEST, "request.base_manifest_digest", errors)
        if not isinstance(request.governing_source_digests, tuple) or not request.governing_source_digests or len(request.governing_source_digests) > 32:
            errors.append("request.governing_source_digests.invalid")
    else:
        if request.base_manifest_digest is not None:
            errors.append("request.base_manifest_digest.must_be_null")
        if request.governing_source_digests:
            errors.append("request.governing_source_digests.must_be_empty")
    if request.base_manifest_status == "valid" and (not isinstance(request.key, TrajectoryKey) or request.key.rubric_digest is None):
        errors.append("request.key.rubric_digest.required")
    if request.base_manifest_status != "valid" and isinstance(request.key, TrajectoryKey) and request.key.rubric_digest is not None:
        errors.append("request.key.rubric_digest.must_be_null")
    if not isinstance(request.governing_source_digests, tuple) or len(request.governing_source_digests) > 32:
        errors.append("request.governing_source_digests.invalid")
    elif request.base_manifest_status == "valid":
        for index, source in enumerate(request.governing_source_digests):
            if not isinstance(source, tuple) or len(source) != 2:
                errors.append(f"request.governing_source_digests[{index}].invalid")
                continue
            _str(source[0], PATH, f"request.governing_source_digests[{index}].path", errors)
            if isinstance(source[0], str) and (source[0].startswith("/") or ".." in source[0].split("/")):
                errors.append(f"request.governing_source_digests[{index}].path.unsafe")
            _str(source[1], DIGEST, f"request.governing_source_digests[{index}].digest", errors)
    return errors


def _tier_error(tier1: Tier1Evidence | None, tier2: Tier2Evidence | None) -> str | None:
    if not isinstance(tier1, Tier1Evidence) or not isinstance(tier2, Tier2Evidence):
        return "evaluator_observation_missing"
    if tier1.status not in TIER1_STATUSES or not DIGEST.fullmatch(tier1.evidence_digest):
        return "tier1_observation_invalid"
    if len(tier1.finding_codes) > 64 or any(not isinstance(code, str) or re.fullmatch(r"[A-Za-z0-9._-]{1,128}", code) is None for code in tier1.finding_codes):
        return "tier1_finding_codes_invalid"
    if not _ref(tier1.evidence_ref):
        return "tier1_evidence_ref_invalid"
    if tier2.outcome not in STATUSES or not DIGEST.fullmatch(tier2.evidence_digest):
        return "tier2_observation_invalid"
    if tier2.model_digest is not None and not DIGEST.fullmatch(tier2.model_digest):
        return "tier2_model_digest_invalid"
    if len(tier2.finding_digests) > 64 or any(not isinstance(item, str) or DIGEST.fullmatch(item) is None for item in tier2.finding_digests):
        return "tier2_finding_digests_invalid"
    if not _ref(tier2.evidence_ref):
        return "tier2_evidence_ref_invalid"
    return None


def _not_configured(request: TrajectoryRequest, reason: str) -> TrajectoryDecision:
    key = request.key.value if isinstance(request.key, TrajectoryKey) else "trajectory-v1:not-configured"
    payload = {"run_id": request.run_id, "key": key, "outcome": "NOT_CONFIGURED", "reason": reason, "base_manifest_status": request.base_manifest_status}
    return TrajectoryDecision("NOT_CONFIGURED", reason, request.run_id, request.key, _digest(payload), None, None, None, None, False, ())


def reconcile_trajectory(request: TrajectoryRequest, *, applied_observation_digests: Mapping[str, str] | None = None) -> TrajectoryDecision:
    """Attach one current observer result without changing factory authority."""
    errors = _request_errors(request)
    if errors:
        return _not_configured(request, errors[0])
    if request.base_manifest_status != "valid":
        return _not_configured(request, "base_manifest_" + request.base_manifest_status)
    tier_error = _tier_error(request.tier1, request.tier2)
    if tier_error:
        outcome, reason = "NON_FINAL", tier_error
    else:
        assert request.tier2 is not None
        outcome, reason = request.tier2.outcome, "tier1_and_tier2_observed"
    payload = {"run_id": request.run_id, "dispatch_id": request.dispatch_id, "key": request.key.value, "manifest_digest": request.base_manifest_digest, "governing_sources": list(request.governing_source_digests), "tier1": request.tier1.to_dict() if request.tier1 else None, "tier2": request.tier2.to_dict() if request.tier2 else None, "outcome": outcome, "reason": reason}
    observation_digest = _digest(payload)
    applied = applied_observation_digests or {}
    observation_key = request.key.value
    duplicate = applied.get(observation_key) == observation_digest
    supersedes = tuple(sorted(key for key in applied if key.startswith(f"trajectory-v1:{request.key.repository}:{request.key.pr_number}:") and key != observation_key))
    normalized: Mapping[str, Any] | None = None
    if request.tier2 is not None:
        normalized = {"kind": "pr-trajectory", "evaluator": "trajectory-eval", "status": {"PASS": "pass", "FAIL": "fail", "NON_FINAL": "needs-human"}.get(outcome, "needs-human"), "rubric_digest": request.key.rubric_digest, "model_digest": request.tier2.model_digest, "observation_digest": observation_digest, "repository": request.key.repository, "base_sha": request.key.base_sha, "head_sha": request.key.head_sha, "pr_number": request.key.pr_number, "evidence_ref": request.tier2.evidence_ref or request.tier1.evidence_ref if request.tier1 else request.tier2.evidence_ref, "authority": "observer-only"}
    comment_key = f"github:trajectory-reviewer:comment:{request.key.repository}:{request.key.pr_number}"
    comment = None if applied.get(comment_key) == observation_digest else CommentIntent(comment_key, request.key.repository, request.key.pr_number, MARKER, observation_key, observation_digest)
    return TrajectoryDecision(outcome, reason, request.run_id, request.key, observation_digest, request.tier1, request.tier2, normalized, comment, duplicate, supersedes)
