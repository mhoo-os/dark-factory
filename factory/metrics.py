"""Structured quality/cost reporting for evidence-backed model comparisons."""
from __future__ import annotations
import hashlib
import json
import math
import re
from collections import defaultdict
from dataclasses import dataclass
from typing import Any, Mapping, Sequence
DIGEST = re.compile(r"^sha256:[0-9a-f]{64}$")
RUN_ID = re.compile(r"^run-v1-[0-9a-f]{32}$")
SHA = re.compile(r"^[0-9a-f]{40}$", re.I)
NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}$")
REPOSITORY = re.compile(r"^mhoo-os/[a-z0-9][a-z0-9._-]{0,99}$")
RISKS = frozenset({"low", "medium", "high"})
OUTCOMES = frozenset({"succeeded", "failed", "stopped", "needs-human", "needs-replan", "reconciliation-only"})
VALIDATION = frozenset({"passed", "failed", "skipped", "not-run", "error"})
PR_STATES = frozenset({"published", "not-published", "unknown"})
MERGE_STATES = frozenset({"merged", "not-merged", "unknown"})
RECOMMENDATIONS = frozenset({"insufficient-evidence", "incomparable-cohorts", "no-material-difference", "escalate-to-candidate", "retain-baseline"})
RAW_KEYS = frozenset({"content", "message", "messages", "reasoning", "thoughts", "prompt", "response", "logs", "raw", "transcript"})
class MetricsValidationError(ValueError):
    def __init__(self, errors: list[str] | tuple[str, ...]):
        self.errors = tuple(errors)
        super().__init__(";".join(self.errors) or "metrics_invalid")
def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
def _digest(value: Any) -> str:
    return "sha256:" + hashlib.sha256(_json(value).encode()).hexdigest()
def _mapping(value: Any, path: str, keys: set[str], errors: list[str]) -> dict[str, Any] | None:
    if not isinstance(value, dict):
        errors.append(f"{path}.type")
        return None
    errors.extend(f"{path}.missing:{key}" for key in sorted(keys - value.keys()))
    errors.extend(f"{path}.unexpected:{key}" for key in sorted(value.keys() - keys))
    errors.extend(f"{path}.{key}.forbidden" for key in sorted(RAW_KEYS & set(value.keys())))
    return value
def _text(value: Any, path: str, pattern: re.Pattern[str], errors: list[str], *, nullable: bool = False, length: int = 256) -> None:
    if nullable and value is None:
        return
    if not isinstance(value, str) or not value or len(value) > length or "\n" in value or "\r" in value or pattern.fullmatch(value) is None:
        errors.append(f"{path}.invalid")
def _dig(value: Any, path: str, errors: list[str]) -> None:
    _text(value, path, DIGEST, errors, length=71)
def _list(value: Any, path: str, errors: list[str], maximum: int) -> list[Any]:
    if not isinstance(value, list) or len(value) > maximum:
        errors.append(f"{path}.list")
        return []
    return value
def _number(value: Any, path: str, errors: list[str], *, nullable: bool = False) -> None:
    if nullable and value is None:
        return
    if not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(value) or value < 0:
        errors.append(f"{path}.nonnegative_number")
def _int(value: Any, path: str, errors: list[str], maximum: int) -> None:
    if not isinstance(value, int) or isinstance(value, bool) or value < 0 or value > maximum:
        errors.append(f"{path}.nonnegative_integer")
class _Sealed:
    def __init__(self, *_args: Any, **_kwargs: Any) -> None:
        raise TypeError("use the validated metrics factory")
    def __reduce__(self) -> Any:
        raise TypeError("metrics proof values are not pickleable")
def _seal(cls: type[Any], **values: Any) -> Any:
    value = object.__new__(cls)
    for name, item in values.items():
        object.__setattr__(value, name, item)
    return value
@dataclass(frozen=True)
class CohortKey:
    repository: str
    execution_profile: str
    work_type: str
    model_provider: str
    model: str
    model_version: str
    risk_class: str
    def to_dict(self) -> dict[str, str]:
        return {"repository": self.repository, "execution_profile": self.execution_profile, "work_type": self.work_type, "model_provider": self.model_provider, "model": self.model, "model_version": self.model_version, "risk_class": self.risk_class}
    @property
    def value(self) -> str:
        return _json(self.to_dict())
@dataclass(frozen=True, init=False)
class RunObservation(_Sealed):
    run_id: str
    evidence_digest: str
    contract_digest: str
    routing_digest: str
    repository: str
    base_sha: str
    execution_profile: str
    work_type: str
    model_provider: str
    model: str
    model_version: str
    risk_class: str
    terminal_outcome: str
    terminal_cause: str | None
    validation_status: str
    fix_attempts: int
    fix_success: bool
    pr_status: str
    pr_trajectory_findings: tuple[str, ...]
    conversation_trajectory_findings: tuple[str, ...]
    input_tokens: int
    output_tokens: int
    cost_usd: float | None
    cost_complete: bool
    wall_time_ms: int
    sandbox_time_ms: int
    stale_count: int
    collision_count: int
    retry_count: int
    dlq_count: int
    merge_outcome: str | None
    evaluator_digests: tuple[str, ...]
    def cohort(self) -> CohortKey:
        return CohortKey(self.repository, self.execution_profile, self.work_type, self.model_provider, self.model, self.model_version, self.risk_class)
    def to_dict(self) -> dict[str, Any]:
        return {"run_id": self.run_id, "evidence_digest": self.evidence_digest, "contract_digest": self.contract_digest, "routing_digest": self.routing_digest, "repository": self.repository, "base_sha": self.base_sha, "execution_profile": self.execution_profile, "work_type": self.work_type, "model_provider": self.model_provider, "model": self.model, "model_version": self.model_version, "risk_class": self.risk_class, "terminal_outcome": self.terminal_outcome, "terminal_cause": self.terminal_cause, "validation_status": self.validation_status, "fix_attempts": self.fix_attempts, "fix_success": self.fix_success, "pr_status": self.pr_status, "pr_trajectory_findings": list(self.pr_trajectory_findings), "conversation_trajectory_findings": list(self.conversation_trajectory_findings), "input_tokens": self.input_tokens, "output_tokens": self.output_tokens, "cost_usd": self.cost_usd, "cost_complete": self.cost_complete, "wall_time_ms": self.wall_time_ms, "sandbox_time_ms": self.sandbox_time_ms, "stale_count": self.stale_count, "collision_count": self.collision_count, "retry_count": self.retry_count, "dlq_count": self.dlq_count, "merge_outcome": self.merge_outcome, "evaluator_digests": list(self.evaluator_digests)}
@dataclass(frozen=True, init=False)
class MetricsPolicy(_Sealed):
    minimum_cohort_size: int
    minimum_cost_complete_fraction: float
    minimum_evaluator_coverage_fraction: float
    material_first_pass_delta: float
    material_cost_increase_fraction: float
    def to_dict(self) -> dict[str, Any]:
        return {"minimum_cohort_size": self.minimum_cohort_size, "minimum_cost_complete_fraction": self.minimum_cost_complete_fraction, "minimum_evaluator_coverage_fraction": self.minimum_evaluator_coverage_fraction, "material_first_pass_delta": self.material_first_pass_delta, "material_cost_increase_fraction": self.material_cost_increase_fraction}
    @property
    def digest(self) -> str:
        return _digest(self.to_dict())
@dataclass(frozen=True)
class CohortMetrics:
    cohort: CohortKey
    sample_size: int
    first_pass_validation_rate: float
    successful_pr_rate: float
    fix_attempt_rate: float
    fix_success_rate: float | None
    needs_replan_rate: float
    needs_human_rate: float
    terminal_failure_rate: float
    terminal_cause_types: tuple[tuple[str, int], ...]
    pr_trajectory_finding_rate: float
    conversation_trajectory_finding_rate: float
    pr_trajectory_finding_types: tuple[tuple[str, int], ...]
    conversation_trajectory_finding_types: tuple[tuple[str, int], ...]
    cost_complete_fraction: float
    total_cost_usd: float | None
    average_cost_usd: float | None
    average_wall_time_ms: float
    average_sandbox_time_ms: float
    stale_incidents: int
    collision_incidents: int
    retry_incidents: int
    dlq_incidents: int
    merge_rate: float | None
    evidence_digests: tuple[str, ...]
    routing_digests: tuple[str, ...]
    evaluator_digests: tuple[str, ...]
    evaluator_coverage_fraction: float
    def to_dict(self) -> dict[str, Any]:
        return {"cohort": self.cohort.to_dict(), "sample_size": self.sample_size, "first_pass_validation_rate": self.first_pass_validation_rate, "successful_pr_rate": self.successful_pr_rate, "fix_attempt_rate": self.fix_attempt_rate, "fix_success_rate": self.fix_success_rate, "needs_replan_rate": self.needs_replan_rate, "needs_human_rate": self.needs_human_rate, "terminal_failure_rate": self.terminal_failure_rate, "terminal_cause_types": [list(item) for item in self.terminal_cause_types], "pr_trajectory_finding_rate": self.pr_trajectory_finding_rate, "conversation_trajectory_finding_rate": self.conversation_trajectory_finding_rate, "pr_trajectory_finding_types": [list(item) for item in self.pr_trajectory_finding_types], "conversation_trajectory_finding_types": [list(item) for item in self.conversation_trajectory_finding_types], "cost_complete_fraction": self.cost_complete_fraction, "total_cost_usd": self.total_cost_usd, "average_cost_usd": self.average_cost_usd, "average_wall_time_ms": self.average_wall_time_ms, "average_sandbox_time_ms": self.average_sandbox_time_ms, "stale_incidents": self.stale_incidents, "collision_incidents": self.collision_incidents, "retry_incidents": self.retry_incidents, "dlq_incidents": self.dlq_incidents, "merge_rate": self.merge_rate, "evidence_digests": list(self.evidence_digests), "routing_digests": list(self.routing_digests), "evaluator_digests": list(self.evaluator_digests), "evaluator_coverage_fraction": self.evaluator_coverage_fraction}
@dataclass(frozen=True, init=False)
class MetricsReport(_Sealed):
    policy_digest: str
    observation_count: int
    cohorts: tuple[CohortMetrics, ...]
    evidence_digests: tuple[str, ...]
    routing_digests: tuple[str, ...]
    evaluator_digests: tuple[str, ...]
    report_digest: str
    authority: str
    def to_dict(self) -> dict[str, Any]:
        return {"policy_digest": self.policy_digest, "observation_count": self.observation_count, "cohorts": [cohort.to_dict() for cohort in self.cohorts], "evidence_digests": list(self.evidence_digests), "routing_digests": list(self.routing_digests), "evaluator_digests": list(self.evaluator_digests), "report_digest": self.report_digest, "authority": self.authority}
@dataclass(frozen=True, init=False)
class CohortComparison(_Sealed):
    baseline: CohortMetrics
    candidate: CohortMetrics
    recommendation: str
    reason: str
    report_digest: str
    source_evidence_digests: tuple[str, ...]
    source_routing_digests: tuple[str, ...]
    source_evaluator_digests: tuple[str, ...]
    authority: str
    def to_dict(self) -> dict[str, Any]:
        return {"baseline": self.baseline.to_dict(), "candidate": self.candidate.to_dict(), "recommendation": self.recommendation, "reason": self.reason, "report_digest": self.report_digest, "source_evidence_digests": list(self.source_evidence_digests), "source_routing_digests": list(self.source_routing_digests), "source_evaluator_digests": list(self.source_evaluator_digests), "authority": self.authority}
def make_metrics_policy(value: Mapping[str, Any]) -> MetricsPolicy:
    errors: list[str] = []
    root = _mapping(value, "policy", {"minimum_cohort_size", "minimum_cost_complete_fraction", "minimum_evaluator_coverage_fraction", "material_first_pass_delta", "material_cost_increase_fraction"}, errors)
    if root is None:
        raise MetricsValidationError(errors)
    _int(root.get("minimum_cohort_size"), "policy.minimum_cohort_size", errors, 1000000)
    for field in ("minimum_cost_complete_fraction", "minimum_evaluator_coverage_fraction", "material_first_pass_delta", "material_cost_increase_fraction"):
        _number(root.get(field), f"policy.{field}", errors)
        if isinstance(root.get(field), (int, float)) and root[field] > 1:
            errors.append(f"policy.{field}.must_be_fraction")
    if errors:
        raise MetricsValidationError(errors)
    return _seal(MetricsPolicy, minimum_cohort_size=root["minimum_cohort_size"], minimum_cost_complete_fraction=float(root["minimum_cost_complete_fraction"]), minimum_evaluator_coverage_fraction=float(root["minimum_evaluator_coverage_fraction"]), material_first_pass_delta=float(root["material_first_pass_delta"]), material_cost_increase_fraction=float(root["material_cost_increase_fraction"]))
def make_run_observation(value: Mapping[str, Any]) -> RunObservation:
    errors: list[str] = []
    keys = {"run_id", "evidence_digest", "contract_digest", "routing_digest", "repository", "base_sha", "execution_profile", "work_type", "model_provider", "model", "model_version", "risk_class", "terminal_outcome", "terminal_cause", "validation_status", "fix_attempts", "fix_success", "pr_status", "pr_trajectory_findings", "conversation_trajectory_findings", "input_tokens", "output_tokens", "cost_usd", "cost_complete", "wall_time_ms", "sandbox_time_ms", "stale_count", "collision_count", "retry_count", "dlq_count", "merge_outcome", "evaluator_digests"}
    root = _mapping(value, "observation", keys, errors)
    if root is None:
        raise MetricsValidationError(errors)
    _text(root.get("run_id"), "observation.run_id", RUN_ID, errors, length=40)
    for field in ("evidence_digest", "contract_digest", "routing_digest"):
        _dig(root.get(field), f"observation.{field}", errors)
    _text(root.get("repository"), "observation.repository", REPOSITORY, errors)
    _text(root.get("base_sha"), "observation.base_sha", SHA, errors, length=40)
    for field in ("execution_profile", "work_type", "model_provider", "model", "model_version"):
        _text(root.get(field), f"observation.{field}", NAME, errors)
    if root.get("risk_class") not in RISKS:
        errors.append("observation.risk_class.invalid")
    if root.get("terminal_outcome") not in OUTCOMES:
        errors.append("observation.terminal_outcome.invalid")
    _text(root.get("terminal_cause"), "observation.terminal_cause", NAME, errors, nullable=True)
    if root.get("validation_status") not in VALIDATION:
        errors.append("observation.validation_status.invalid")
    _int(root.get("fix_attempts"), "observation.fix_attempts", errors, 2)
    if not isinstance(root.get("fix_success"), bool):
        errors.append("observation.fix_success.boolean")
    if root.get("pr_status") not in PR_STATES:
        errors.append("observation.pr_status.invalid")
    findings: dict[str, tuple[str, ...]] = {}
    for field in ("pr_trajectory_findings", "conversation_trajectory_findings"):
        items = _list(root.get(field), f"observation.{field}", errors, 128)
        names: list[str] = []
        for index, item in enumerate(items):
            _text(item, f"observation.{field}[{index}]", NAME, errors)
            if isinstance(item, str):
                names.append(item)
        findings[field] = tuple(names)
    for field in ("input_tokens", "output_tokens", "wall_time_ms", "sandbox_time_ms", "stale_count", "collision_count", "retry_count", "dlq_count"):
        _int(root.get(field), f"observation.{field}", errors, 2**31 - 1)
    _number(root.get("cost_usd"), "observation.cost_usd", errors, nullable=True)
    if not isinstance(root.get("cost_complete"), bool):
        errors.append("observation.cost_complete.boolean")
    if root.get("cost_complete") and root.get("cost_usd") is None:
        errors.append("observation.cost_usd.required_when_complete")
    if root.get("merge_outcome") is not None and root.get("merge_outcome") not in MERGE_STATES:
        errors.append("observation.merge_outcome.invalid")
    evaluator = _list(root.get("evaluator_digests"), "observation.evaluator_digests", errors, 32)
    for index, digest in enumerate(evaluator):
        _dig(digest, f"observation.evaluator_digests[{index}]", errors)
    if errors:
        raise MetricsValidationError(errors)
    return _seal(RunObservation, **{**root, **findings, "evaluator_digests": tuple(evaluator)})
def _rate(numerator: int, denominator: int) -> float:
    return round(numerator / denominator, 6) if denominator else 0.0
def _optional_rate(numerator: int, denominator: int) -> float | None:
    return round(numerator / denominator, 6) if denominator else None
def _cohort_metrics(observations: Sequence[RunObservation]) -> CohortMetrics:
    first_pass = sum(item.validation_status == "passed" and item.fix_attempts == 0 for item in observations)
    pr = sum(item.pr_status == "published" for item in observations)
    fixes = [item for item in observations if item.fix_attempts > 0]
    complete = [item for item in observations if item.cost_complete]
    merges = [item for item in observations if item.merge_outcome is not None and item.merge_outcome != "unknown"]
    pr_types: dict[str, int] = defaultdict(int)
    conversation_types: dict[str, int] = defaultdict(int)
    causes: dict[str, int] = defaultdict(int)
    for item in observations:
        if item.terminal_cause is not None:
            causes[item.terminal_cause] += 1
        for code in item.pr_trajectory_findings:
            pr_types[code] += 1
        for code in item.conversation_trajectory_findings:
            conversation_types[code] += 1
    cohort = observations[0].cohort()
    return CohortMetrics(cohort, len(observations), _rate(first_pass, len(observations)), _rate(pr, len(observations)), _rate(len(fixes), len(observations)), _optional_rate(sum(item.fix_success for item in fixes), len(fixes)), _rate(sum(item.terminal_outcome == "needs-replan" for item in observations), len(observations)), _rate(sum(item.terminal_outcome == "needs-human" for item in observations), len(observations)), _rate(sum(item.terminal_outcome == "failed" for item in observations), len(observations)), tuple(sorted(causes.items())), _rate(sum(bool(item.pr_trajectory_findings) for item in observations), len(observations)), _rate(sum(bool(item.conversation_trajectory_findings) for item in observations), len(observations)), tuple(sorted(pr_types.items())), tuple(sorted(conversation_types.items())), _rate(len(complete), len(observations)), round(sum(item.cost_usd for item in complete), 6) if complete else None, round(sum(item.cost_usd for item in complete) / len(complete), 6) if complete else None, round(sum(item.wall_time_ms for item in observations) / len(observations), 6), round(sum(item.sandbox_time_ms for item in observations) / len(observations), 6), sum(item.stale_count for item in observations), sum(item.collision_count for item in observations), sum(item.retry_count for item in observations), sum(item.dlq_count for item in observations), _optional_rate(sum(item.merge_outcome == "merged" for item in merges), len(merges)), tuple(sorted({item.evidence_digest for item in observations})), tuple(sorted({item.routing_digest for item in observations})), tuple(sorted({digest for item in observations for digest in item.evaluator_digests})), _rate(sum(bool(item.evaluator_digests) for item in observations), len(observations)))
def build_metrics_report(observations: Sequence[RunObservation], policy: MetricsPolicy) -> MetricsReport:
    if not isinstance(policy, MetricsPolicy) or not all(isinstance(item, RunObservation) for item in observations):
        raise TypeError("build_metrics_report requires validated observations and policy")
    if not observations:
        raise MetricsValidationError(("report.observations.empty",))
    if len({item.run_id for item in observations}) != len(observations):
        raise MetricsValidationError(("report.observations.duplicate_run_id",))
    grouped: dict[str, list[RunObservation]] = defaultdict(list)
    for item in observations:
        grouped[item.cohort().value].append(item)
    cohorts = tuple(sorted((_cohort_metrics(items) for items in grouped.values()), key=lambda item: item.cohort.value))
    evidence = tuple(sorted({item.evidence_digest for item in observations}))
    routing = tuple(sorted({item.routing_digest for item in observations}))
    evaluator = tuple(sorted({digest for item in observations for digest in item.evaluator_digests}))
    payload = {"policy_digest": policy.digest, "observation_count": len(observations), "cohorts": [item.to_dict() for item in cohorts], "evidence_digests": list(evidence), "routing_digests": list(routing), "evaluator_digests": list(evaluator), "authority": "report-only"}
    return _seal(MetricsReport, policy_digest=policy.digest, observation_count=len(observations), cohorts=cohorts, evidence_digests=evidence, routing_digests=routing, evaluator_digests=evaluator, report_digest=_digest(payload), authority="report-only")
def compare_cohorts(baseline: CohortMetrics, candidate: CohortMetrics, policy: MetricsPolicy, report_digest: str) -> CohortComparison:
    if not isinstance(baseline, CohortMetrics) or not isinstance(candidate, CohortMetrics) or not isinstance(policy, MetricsPolicy) or not isinstance(report_digest, str) or not DIGEST.fullmatch(report_digest):
        raise TypeError("compare_cohorts requires validated report values")
    same_scope = baseline.cohort.repository == candidate.cohort.repository and baseline.cohort.execution_profile == candidate.cohort.execution_profile and baseline.cohort.work_type == candidate.cohort.work_type and baseline.cohort.risk_class == candidate.cohort.risk_class
    if not same_scope:
        recommendation, reason = "incomparable-cohorts", "repository_profile_work_type_or_risk_differs"
    elif min(baseline.sample_size, candidate.sample_size) < policy.minimum_cohort_size:
        recommendation, reason = "insufficient-evidence", "minimum_cohort_size_not_met"
    elif min(baseline.cost_complete_fraction, candidate.cost_complete_fraction) < policy.minimum_cost_complete_fraction:
        recommendation, reason = "insufficient-evidence", "cost_evidence_incomplete"
    elif min(baseline.evaluator_coverage_fraction, candidate.evaluator_coverage_fraction) < policy.minimum_evaluator_coverage_fraction:
        recommendation, reason = "insufficient-evidence", "evaluator_evidence_incomplete"
    else:
        delta = candidate.first_pass_validation_rate - baseline.first_pass_validation_rate
        cost_worse = baseline.average_cost_usd is not None and candidate.average_cost_usd is not None and candidate.average_cost_usd > baseline.average_cost_usd * (1 + policy.material_cost_increase_fraction)
        if delta >= policy.material_first_pass_delta and not cost_worse:
            recommendation, reason = "escalate-to-candidate", "candidate_first_pass_gain_is_material_within_cost_guardrail"
        elif delta <= -policy.material_first_pass_delta or cost_worse:
            recommendation, reason = "retain-baseline", "candidate_has_no_quality_gain_or_exceeds_cost_guardrail"
        else:
            recommendation, reason = "no-material-difference", "observed_difference_is_below_policy_threshold"
    evidence = tuple(sorted(set(baseline.evidence_digests) | set(candidate.evidence_digests)))
    routing = tuple(sorted(set(baseline.routing_digests) | set(candidate.routing_digests)))
    evaluator = tuple(sorted(set(baseline.evaluator_digests) | set(candidate.evaluator_digests)))
    payload = {"baseline": baseline.to_dict(), "candidate": candidate.to_dict(), "recommendation": recommendation, "reason": reason, "report_digest": report_digest, "authority": "report-only"}
    return _seal(CohortComparison, baseline=baseline, candidate=candidate, recommendation=recommendation, reason=reason, report_digest=report_digest, source_evidence_digests=evidence, source_routing_digests=routing, source_evaluator_digests=evaluator, authority="report-only")
