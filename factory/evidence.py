"""Versioned, redacted run evidence with one identity for all evaluators."""
from __future__ import annotations
import hashlib
import json
import math
import re
from collections import Counter
from collections.abc import Mapping
from typing import Any
EVIDENCE_VERSION = "v1"
MAX_EVIDENCE_BYTES = 512 * 1024
MAX_ARTIFACT_BYTES = 512 * 1024
MAX_ITEMS = {"steps": 64, "turns": 256, "tool_calls": 512, "sandbox": 256,
             "validation": 256, "fix_attempts": 2, "evaluations": 32}
SHA = re.compile(r"^[0-9a-f]{40}$", re.I)
DIGEST = re.compile(r"^sha256:[0-9a-f]{64}$")
ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,191}$")
NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}$")
ISSUE = re.compile(r"^[A-Z][A-Z0-9]{1,9}-[1-9][0-9]*$")
RUN = re.compile(r"^run-v1-[0-9a-f]{32}$")
SECRET = re.compile(r"(?i)(bearer\s+|sk-[a-z0-9]|(?:api[_-]?key|access[_-]?token|password|cookie|authorization)\s*[:=])")
OUTCOMES = frozenset({"succeeded", "failed", "stopped", "needs-human", "needs-replan", "reconciliation-only"})
STATUSES = frozenset({"started", "passed", "failed", "skipped", "not-run", "error", "completed"})
VALIDATION = frozenset({"passed", "failed", "skipped", "not-run", "error"})
EVAL_KINDS = frozenset({"product", "pr-trajectory", "conversation-trajectory"})
EVAL_STATUSES = frozenset({"pass", "fail", "not-configured", "needs-human"})
RETENTION = frozenset({"run-7d", "run-30d", "run-90d"})
class EvidenceValidationError(ValueError):
    def __init__(self, errors: list[str] | tuple[str, ...]):
        self.errors = tuple(errors)
        super().__init__(";".join(self.errors) or "evidence_invalid")
def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
def _digest(value: Any) -> str:
    return "sha256:" + hashlib.sha256(_json(value).encode()).hexdigest()
def derive_run_id(*, dispatch_id: str, contract_digest: str, linear_project_id: str,
                  linear_issue_id: str, repository: str, base_sha: str) -> str:
    """The retry-stable identity is derived from the immutable admitted binding."""
    value = {"base_sha": base_sha, "contract_digest": contract_digest,
             "dispatch_id": dispatch_id, "linear_issue_id": linear_issue_id,
             "linear_project_id": linear_project_id, "repository": repository}
    return "run-v1-" + hashlib.sha256(_json(value).encode()).hexdigest()[:32]
def _obj(value: Any, path: str, keys: set[str], errors: list[str]) -> Mapping[str, Any] | None:
    if not isinstance(value, dict):
        errors.append(f"{path}.type")
        return None
    errors.extend(f"{path}.missing:{key}" for key in sorted(keys - value.keys()))
    errors.extend(f"{path}.unexpected:{key}" for key in sorted(value.keys() - keys))
    return value
def _str(value: Any, path: str, errors: list[str], *, pattern: re.Pattern[str] | None = None,
         length: int = 256, nullable: bool = False) -> None:
    if nullable and value is None:
        return
    if not isinstance(value, str) or not value or len(value) > length or "\n" in value or "\r" in value:
        errors.append(f"{path}.string")
        return
    if SECRET.search(value):
        errors.append(f"{path}.sensitive")
    if pattern is not None and pattern.fullmatch(value) is None:
        errors.append(f"{path}.format")
def _dig(value: Any, path: str, errors: list[str], *, nullable: bool = False) -> None:
    _str(value, path, errors, pattern=DIGEST, length=71, nullable=nullable)
def _int(value: Any, path: str, errors: list[str], *, maximum: int = 2**31 - 1,
         nullable: bool = False) -> None:
    if nullable and value is None:
        return
    if not isinstance(value, int) or isinstance(value, bool) or value < 0 or value > maximum:
        errors.append(f"{path}.nonnegative_integer")
def _num(value: Any, path: str, errors: list[str], *, nullable: bool = False) -> None:
    if nullable and value is None:
        return
    if not isinstance(value, (int, float)) or isinstance(value, bool) or value < 0 or not math.isfinite(value):
        errors.append(f"{path}.nonnegative_number")
def _list(value: Any, path: str, errors: list[str], maximum: int) -> list[Any]:
    if not isinstance(value, list) or len(value) > maximum:
        errors.append(f"{path}.list")
        return []
    return value
def _ref(value: Any, path: str, errors: list[str]) -> None:
    item = _obj(value, path, {"store", "key", "digest", "bytes", "redacted", "retention"}, errors)
    if item is None:
        return
    _str(item.get("store"), f"{path}.store", errors, pattern=re.compile(r"^r2$"), length=8)
    _str(item.get("key"), f"{path}.key", errors, pattern=re.compile(r"^runs/[A-Za-z0-9._/@-]+$"))
    _dig(item.get("digest"), f"{path}.digest", errors)
    _int(item.get("bytes"), f"{path}.bytes", errors, maximum=MAX_ARTIFACT_BYTES)
    if item.get("redacted") is not True:
        errors.append(f"{path}.redacted_required")
    if item.get("retention") not in RETENTION:
        errors.append(f"{path}.retention.unsupported")
def _identity(value: Any, errors: list[str]) -> None:
    item = _obj(value, "identity", {"run_id", "dispatch_id", "attempt", "contract_digest", "linear", "repository"}, errors)
    if item is None:
        return
    _str(item.get("run_id"), "identity.run_id", errors, pattern=RUN, length=40)
    _str(item.get("dispatch_id"), "identity.dispatch_id", errors, pattern=ID)
    _int(item.get("attempt"), "identity.attempt", errors, maximum=2)
    _dig(item.get("contract_digest"), "identity.contract_digest", errors)
    linear = _obj(item.get("linear"), "identity.linear", {"project_id", "issue_id", "identifier", "planning_revision", "planning_fingerprint"}, errors)
    if linear is not None:
        for field in ("project_id", "issue_id", "planning_revision"):
            _str(linear.get(field), f"identity.linear.{field}", errors, pattern=ID)
        _str(linear.get("identifier"), "identity.linear.identifier", errors, pattern=ISSUE, length=32)
        _dig(linear.get("planning_fingerprint"), "identity.linear.planning_fingerprint", errors)
    repo = _obj(item.get("repository"), "identity.repository", {"name", "base_sha", "head_sha", "branch", "pr_number", "pr_url"}, errors)
    if repo is None:
        return
    _str(repo.get("name"), "identity.repository.name", errors, pattern=re.compile(r"^mhoo-os/[a-z0-9][a-z0-9._-]{0,99}$"))
    _str(repo.get("base_sha"), "identity.repository.base_sha", errors, pattern=SHA, length=40)
    _str(repo.get("head_sha"), "identity.repository.head_sha", errors, pattern=SHA, length=40, nullable=True)
    _str(repo.get("branch"), "identity.repository.branch", errors, pattern=NAME, nullable=True)
    _int(repo.get("pr_number"), "identity.repository.pr_number", errors, nullable=True)
    _str(repo.get("pr_url"), "identity.repository.pr_url", errors, length=512,
         pattern=re.compile(r"^https://github\.com/mhoo-os/[a-z0-9][a-z0-9._-]{0,99}/pull/[1-9][0-9]*$"), nullable=True)
    if repo.get("pr_number") is not None and (repo.get("head_sha") is None or repo.get("pr_url") is None):
        errors.append("identity.repository.pr_binding_incomplete")
    if repo.get("pr_number") is None and any(repo.get(key) is not None for key in ("head_sha", "branch", "pr_url")):
        errors.append("identity.repository.unbound_pr_fields")
def _refs(value: Any, path: str, errors: list[str], maximum: int = 8) -> None:
    for index, item in enumerate(_list(value, path, errors, maximum)):
        _ref(item, f"{path}[{index}]", errors)
def _records(value: Any, kind: str, keys: set[str], errors: list[str]) -> list[Mapping[str, Any]]:
    records: list[Mapping[str, Any]] = []
    for index, item in enumerate(_list(value, kind, errors, MAX_ITEMS[kind])):
        record = _obj(item, f"{kind}[{index}]", keys, errors)
        if record is not None:
            records.append(record)
    return records
def _validate(value: Any) -> list[str]:
    errors: list[str] = []
    root = _obj(value, "evidence", {"schema_version", "identity", "profiles", "model", "outcome", "steps", "turns", "tool_calls", "sandbox", "validation", "fix_attempts", "usage", "evaluations", "storage"}, errors)
    if root is None:
        return errors
    if root.get("schema_version") != EVIDENCE_VERSION:
        errors.append("schema_version.unsupported")
    _identity(root.get("identity"), errors)
    profiles = _obj(root.get("profiles"), "profiles", {"execution_digest", "validation_digest"}, errors)
    if profiles is not None:
        _dig(profiles.get("execution_digest"), "profiles.execution_digest", errors)
        _dig(profiles.get("validation_digest"), "profiles.validation_digest", errors)
    model = _obj(root.get("model"), "model", {"provider", "model", "version", "reasoning_effort", "routing_decision"}, errors)
    if model is not None:
        for field in ("provider", "model", "version", "reasoning_effort", "routing_decision"):
            _str(model.get(field), f"model.{field}", errors, length=128, nullable=True)
    outcome = _obj(root.get("outcome"), "outcome", {"status", "escalation_reason", "replan_cause"}, errors)
    if outcome is not None:
        if outcome.get("status") not in OUTCOMES:
            errors.append("outcome.status.unsupported")
        for field in ("escalation_reason", "replan_cause"):
            _str(outcome.get(field), f"outcome.{field}", errors, nullable=True)
    steps = _records(root.get("steps"), "steps", {"key", "phase", "attempt", "status", "started_at", "duration_ms", "result_digest", "evidence_refs"}, errors)
    for index, step in enumerate(steps):
        _str(step.get("key"), f"steps[{index}].key", errors, pattern=NAME)
        _str(step.get("phase"), f"steps[{index}].phase", errors, pattern=NAME)
        _int(step.get("attempt"), f"steps[{index}].attempt", errors, maximum=2)
        if step.get("status") not in STATUSES:
            errors.append(f"steps[{index}].status.unsupported")
        _str(step.get("started_at"), f"steps[{index}].started_at", errors, length=64)
        _int(step.get("duration_ms"), f"steps[{index}].duration_ms", errors, maximum=86_400_000)
        _dig(step.get("result_digest"), f"steps[{index}].result_digest", errors, nullable=True)
        _refs(step.get("evidence_refs"), f"steps[{index}].evidence_refs", errors)
    turns = _records(root.get("turns"), "turns", {"id", "role", "phase", "message_digest", "retained", "content_ref", "untrusted"}, errors)
    for index, turn in enumerate(turns):
        for field in ("id", "phase"):
            _str(turn.get(field), f"turns[{index}].{field}", errors, pattern=NAME)
        _str(turn.get("role"), f"turns[{index}].role", errors, pattern=re.compile(r"^(system|user|assistant|tool|evaluator)$"), length=32)
        _dig(turn.get("message_digest"), f"turns[{index}].message_digest", errors)
        if not isinstance(turn.get("retained"), bool):
            errors.append(f"turns[{index}].retained.boolean")
        if turn.get("retained"):
            if turn.get("content_ref") is None:
                errors.append(f"turns[{index}].content_ref.required")
            else:
                _ref(turn.get("content_ref"), f"turns[{index}].content_ref", errors)
        elif turn.get("content_ref") is not None:
            errors.append(f"turns[{index}].content_ref_without_retention")
        if turn.get("untrusted") is not True:
            errors.append(f"turns[{index}].untrusted_required")
    calls = _records(root.get("tool_calls"), "tool_calls", {"id", "turn_id", "name", "argument_keys", "argument_value_digests", "result_status", "duration_ms", "result_digest", "result_ref"}, errors)
    for index, call in enumerate(calls):
        for field in ("id", "turn_id", "name"):
            _str(call.get(field), f"tool_calls[{index}].{field}", errors, pattern=NAME)
        keys = _list(call.get("argument_keys"), f"tool_calls[{index}].argument_keys", errors, 32)
        for key_index, key in enumerate(keys):
            _str(key, f"tool_calls[{index}].argument_keys[{key_index}]", errors, pattern=NAME)
        digests = call.get("argument_value_digests")
        if not isinstance(digests, dict) or set(digests) != set(keys):
            errors.append(f"tool_calls[{index}].argument_value_digests.keys")
        else:
            for key, digest in digests.items():
                _dig(digest, f"tool_calls[{index}].argument_value_digests.{key}", errors)
        if call.get("result_status") not in STATUSES:
            errors.append(f"tool_calls[{index}].result_status.unsupported")
        _int(call.get("duration_ms"), f"tool_calls[{index}].duration_ms", errors, maximum=86_400_000)
        _dig(call.get("result_digest"), f"tool_calls[{index}].result_digest", errors, nullable=True)
        if call.get("result_ref") is not None:
            _ref(call.get("result_ref"), f"tool_calls[{index}].result_ref", errors)
    sandbox = _records(root.get("sandbox"), "sandbox", {"id", "tool", "argv_digest", "status", "duration_ms", "output_bytes", "output_digest", "output_ref", "artifact_refs"}, errors)
    for index, command in enumerate(sandbox):
        for field in ("id", "tool"):
            _str(command.get(field), f"sandbox[{index}].{field}", errors, pattern=NAME)
        _dig(command.get("argv_digest"), f"sandbox[{index}].argv_digest", errors)
        if command.get("status") not in STATUSES:
            errors.append(f"sandbox[{index}].status.unsupported")
        _int(command.get("duration_ms"), f"sandbox[{index}].duration_ms", errors, maximum=86_400_000)
        _int(command.get("output_bytes"), f"sandbox[{index}].output_bytes", errors, maximum=MAX_ARTIFACT_BYTES)
        _dig(command.get("output_digest"), f"sandbox[{index}].output_digest", errors, nullable=True)
        if command.get("output_ref") is not None:
            _ref(command.get("output_ref"), f"sandbox[{index}].output_ref", errors)
        _refs(command.get("artifact_refs"), f"sandbox[{index}].artifact_refs", errors)
    checks = _records(root.get("validation"), "validation", {"id", "name", "status", "required_marker", "marker_observed", "duration_ms", "evidence_ref"}, errors)
    for index, check in enumerate(checks):
        for field in ("id", "name"):
            _str(check.get(field), f"validation[{index}].{field}", errors, pattern=NAME)
        if check.get("status") not in VALIDATION:
            errors.append(f"validation[{index}].status.unsupported")
        _str(check.get("required_marker"), f"validation[{index}].required_marker", errors, pattern=NAME, nullable=True)
        if not isinstance(check.get("marker_observed"), bool):
            errors.append(f"validation[{index}].marker_observed.boolean")
        _int(check.get("duration_ms"), f"validation[{index}].duration_ms", errors, maximum=86_400_000)
        if check.get("evidence_ref") is not None:
            _ref(check.get("evidence_ref"), f"validation[{index}].evidence_ref", errors)
        if check.get("status") == "passed" and (check.get("evidence_ref") is None or (check.get("required_marker") and not check.get("marker_observed"))):
            errors.append(f"validation[{index}].passed_without_evidence")
    fixes = _records(root.get("fix_attempts"), "fix_attempts", {"attempt", "finding_digests", "head_sha", "status", "evidence_ref"}, errors)
    for index, fix in enumerate(fixes):
        _int(fix.get("attempt"), f"fix_attempts[{index}].attempt", errors, maximum=2)
        for digest_index, digest in enumerate(_list(fix.get("finding_digests"), f"fix_attempts[{index}].finding_digests", errors, 32)):
            _dig(digest, f"fix_attempts[{index}].finding_digests[{digest_index}]", errors)
        _str(fix.get("head_sha"), f"fix_attempts[{index}].head_sha", errors, pattern=SHA, length=40, nullable=True)
        if fix.get("status") not in STATUSES:
            errors.append(f"fix_attempts[{index}].status.unsupported")
        if fix.get("evidence_ref") is not None:
            _ref(fix.get("evidence_ref"), f"fix_attempts[{index}].evidence_ref", errors)
    usage = _obj(root.get("usage"), "usage", {"input_tokens", "output_tokens", "cache_read_tokens", "cost_usd", "latency_ms", "cpu_ms", "memory_mb"}, errors)
    if usage is not None:
        for field in ("input_tokens", "output_tokens", "cache_read_tokens", "latency_ms", "cpu_ms", "memory_mb"):
            _int(usage.get(field), f"usage.{field}", errors, maximum=2**53 - 1)
        _num(usage.get("cost_usd"), "usage.cost_usd", errors, nullable=True)
    evaluations = _records(root.get("evaluations"), "evaluations", {"id", "kind", "evaluator", "status", "rubric_digest", "model_digest", "observation_digest", "repository", "base_sha", "head_sha", "pr_number", "evidence_ref", "authority"}, errors)
    identity = root.get("identity") if isinstance(root.get("identity"), dict) else {}
    repo = identity.get("repository", {}) if isinstance(identity.get("repository"), dict) else {}
    for index, evaluation in enumerate(evaluations):
        _str(evaluation.get("id"), f"evaluations[{index}].id", errors, pattern=NAME)
        if evaluation.get("kind") not in EVAL_KINDS:
            errors.append(f"evaluations[{index}].kind.unsupported")
        _str(evaluation.get("evaluator"), f"evaluations[{index}].evaluator", errors, pattern=NAME)
        if evaluation.get("status") not in EVAL_STATUSES:
            errors.append(f"evaluations[{index}].status.unsupported")
        _dig(evaluation.get("rubric_digest"), f"evaluations[{index}].rubric_digest", errors)
        _dig(evaluation.get("model_digest"), f"evaluations[{index}].model_digest", errors, nullable=True)
        _dig(evaluation.get("observation_digest"), f"evaluations[{index}].observation_digest", errors)
        _str(evaluation.get("repository"), f"evaluations[{index}].repository", errors, pattern=re.compile(r"^mhoo-os/[a-z0-9][a-z0-9._-]{0,99}$"))
        _str(evaluation.get("base_sha"), f"evaluations[{index}].base_sha", errors, pattern=SHA, length=40)
        _str(evaluation.get("head_sha"), f"evaluations[{index}].head_sha", errors, pattern=SHA, length=40, nullable=True)
        _int(evaluation.get("pr_number"), f"evaluations[{index}].pr_number", errors, nullable=True)
        if evaluation.get("evidence_ref") is not None:
            _ref(evaluation.get("evidence_ref"), f"evaluations[{index}].evidence_ref", errors)
        if evaluation.get("authority") != "observer-only":
            errors.append(f"evaluations[{index}].authority_required")
        if evaluation.get("repository") != repo.get("name"):
            errors.append(f"evaluations[{index}].repository_unbound")
        if evaluation.get("base_sha") != repo.get("base_sha"):
            errors.append(f"evaluations[{index}].base_unbound")
    storage = _obj(root.get("storage"), "storage", {"trace_ref", "retention", "trace_untrusted", "builder_private_reasoning"}, errors)
    if storage is not None:
        _ref(storage.get("trace_ref"), "storage.trace_ref", errors)
        if storage.get("retention") not in RETENTION:
            errors.append("storage.retention.unsupported")
        if storage.get("trace_untrusted") is not True:
            errors.append("storage.trace_untrusted_required")
        if storage.get("builder_private_reasoning") != "excluded":
            errors.append("storage.builder_private_reasoning_required")
    if isinstance(identity, dict) and isinstance(identity.get("linear"), dict) and isinstance(repo, dict):
        expected = derive_run_id(dispatch_id=identity.get("dispatch_id", ""), contract_digest=identity.get("contract_digest", ""), linear_project_id=identity["linear"].get("project_id", ""), linear_issue_id=identity["linear"].get("issue_id", ""), repository=repo.get("name", ""), base_sha=repo.get("base_sha", ""))
        if identity.get("run_id") != expected:
            errors.append("identity.run_id.not_deterministic")
    return errors
class FactoryRunEvidence:
    """Immutable validated evidence; callers must use build/parse."""
    __slots__ = ("_canonical", "_digest")
    def __init__(self, *_args: Any, **_kwargs: Any):
        raise TypeError("use build_evidence or parse_evidence")
    def __setattr__(self, _name: str, _value: Any) -> None:
        raise AttributeError("FactoryRunEvidence is immutable")
    def __reduce__(self) -> Any:
        raise TypeError("FactoryRunEvidence cannot be reconstructed by pickle")
    @property
    def digest(self) -> str:
        return self._digest
    @property
    def run_id(self) -> str:
        return json.loads(self._canonical)["identity"]["run_id"]
    def to_json(self) -> str:
        return self._canonical
    def to_dict(self) -> dict[str, Any]:
        return json.loads(self._canonical)
    def evaluator_view(self, *, include_turn_metadata: bool = False) -> dict[str, Any]:
        document = self.to_dict()
        metrics = _metrics(document)
        document.pop("storage", None)
        if not include_turn_metadata:
            document.pop("turns", None)
        return {**document, "metrics": metrics}
    def d1_projection(self) -> dict[str, Any]:
        document = self.to_dict()
        return {"schema_version": document["schema_version"], "run_id": self.run_id,
                "dispatch_id": document["identity"]["dispatch_id"], "contract_digest": document["identity"]["contract_digest"],
                "linear": document["identity"]["linear"], "repository": document["identity"]["repository"],
                "profiles": document["profiles"], "model": document["model"], "outcome": document["outcome"],
                "usage": document["usage"], "metrics": _metrics(document), "trace_ref": document["storage"]["trace_ref"],
                "evaluations": [{"id": item["id"], "kind": item["kind"], "status": item["status"],
                                 "rubric_digest": item["rubric_digest"], "observation_digest": item["observation_digest"]}
                                for item in document["evaluations"]]}
def _metrics(document: Mapping[str, Any]) -> dict[str, Any]:
    count = lambda field, values: dict(sorted(Counter(item[field] for item in values).items()))
    usage = document["usage"]
    return {"step_count": len(document["steps"]), "step_status": count("status", document["steps"]),
            "turn_count": len(document["turns"]), "tool_call_count": len(document["tool_calls"]),
            "tool_status": count("result_status", document["tool_calls"]), "sandbox_command_count": len(document["sandbox"]),
            "validation_count": len(document["validation"]), "validation_status": count("status", document["validation"]),
            "fix_attempt_count": len(document["fix_attempts"]), "evaluation_count": len(document["evaluations"]),
            "evaluation_kinds": count("kind", document["evaluations"]), "input_tokens": usage["input_tokens"],
            "output_tokens": usage["output_tokens"], "cache_read_tokens": usage["cache_read_tokens"],
            "cost_usd": usage["cost_usd"], "cost_complete": usage["cost_usd"] is not None,
            "latency_ms": usage["latency_ms"], "cpu_ms": usage["cpu_ms"], "memory_mb": usage["memory_mb"],
            "outcome": document["outcome"]["status"]}
def build_evidence(value: Mapping[str, Any]) -> FactoryRunEvidence:
    """Validate an untrusted mapping and seal a copy represented by canonical JSON."""
    errors = _validate(value)
    if errors:
        raise EvidenceValidationError(errors)
    serialized = _json(value)
    if len(serialized.encode()) > MAX_EVIDENCE_BYTES:
        raise EvidenceValidationError(("evidence.serialized_too_large",))
    evidence = object.__new__(FactoryRunEvidence)
    object.__setattr__(evidence, "_canonical", serialized)
    object.__setattr__(evidence, "_digest", _digest(value))
    return evidence
def parse_evidence(serialized: str | bytes) -> FactoryRunEvidence:
    """Parse JSON as data only; serialized trace content is never executable."""
    raw = serialized.encode() if isinstance(serialized, str) else serialized
    if not isinstance(raw, bytes) or len(raw) > MAX_EVIDENCE_BYTES:
        raise EvidenceValidationError(("evidence.serialized_too_large",))
    try:
        value = json.loads(raw.decode())
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise EvidenceValidationError(("evidence.invalid_json",)) from error
    return build_evidence(value)
