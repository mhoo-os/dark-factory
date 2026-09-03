"""Pure validation and canonicalization for Factory Dispatch Contract v1."""
from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass
from typing import Any, Iterable, Mapping

from factory.factory_registry import RegistryBinding

CONTRACT_VERSION = "v1"
SUPPORTED_OUTCOMES = ("admitted", "not-admitted", "needs-replan")
STALE_CONDITIONS = frozenset(
    {"planning_revision_changed", "planning_fingerprint_changed", "base_sha_changed"}
)
MERGE_POLICIES = frozenset({"human", "auto-eligible"})
AUTHORITY_CLASSES = frozenset({"repository-local", "cross-system"})
RISK_CLASSES = frozenset({"low", "medium", "high"})
DEPENDENCY_STATES = frozenset({"completed"})
ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,191}$")
ISSUE_PATTERN = re.compile(r"^[A-Z][A-Z0-9]{1,9}-[1-9][0-9]*$")
REPOSITORY_PATTERN = re.compile(r"^mhoo-os/[a-z0-9][a-z0-9._-]{0,99}$")
SHA256_PATTERN = re.compile(r"^sha256:[0-9a-f]{64}$")
BASE_SHA_PATTERN = re.compile(r"^[0-9a-f]{40}$", re.IGNORECASE)


@dataclass(frozen=True)
class DispatchContract:
    """An immutable, validated contract represented by canonical JSON."""

    _canonical_json: str
    digest: str

    def to_dict(self) -> dict[str, Any]:
        return json.loads(self._canonical_json)

    @property
    def dispatch_id(self) -> str:
        return self.to_dict()["dispatch_id"]

    @property
    def execution_profile(self) -> str:
        return self.to_dict()["target"]["execution_profile"]

    @property
    def factory_id(self) -> str | None:
        registry = self.to_dict().get("registry")
        return registry.get("factory_id") if isinstance(registry, dict) else None


@dataclass(frozen=True)
class ContractValidation:
    outcome: str
    reasons: tuple[str, ...]
    contract: DispatchContract | None = None


def canonical_json(value: Mapping[str, Any]) -> str:
    """Serialize a contract without whitespace or insertion-order dependence."""
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


def _mapping(value: Any, path: str, errors: list[str]) -> Mapping[str, Any] | None:
    if not isinstance(value, dict):
        errors.append(f"{path}.type")
        return None
    return value


def _keys(value: Mapping[str, Any], expected: set[str], path: str, errors: list[str], *, optional: set[str] = frozenset()) -> None:
    for key in sorted(expected - value.keys()):
        errors.append(f"{path}.missing:{key}")
    for key in sorted(value.keys() - expected - optional):
        errors.append(f"{path}.unexpected:{key}")


def _string(value: Any, path: str, errors: list[str], pattern: re.Pattern[str] | None = None, max_len: int = 256) -> None:
    if not isinstance(value, str) or not value or len(value) > max_len:
        errors.append(f"{path}.string")
    elif pattern is not None and pattern.fullmatch(value) is None:
        errors.append(f"{path}.format")


def _string_list(value: Any, path: str, errors: list[str], *, allow_empty: bool = False, max_items: int = 50) -> None:
    if not isinstance(value, list) or (not allow_empty and not value) or len(value) > max_items:
        errors.append(f"{path}.list")
        return
    if any(not isinstance(item, str) or not item or len(item) > 512 for item in value):
        errors.append(f"{path}.item")
    if len(set(value)) != len(value):
        errors.append(f"{path}.duplicate")


def _static_errors(value: Any) -> list[str]:
    errors: list[str] = []
    root = _mapping(value, "contract", errors)
    if root is None:
        return errors
    _keys(
        root,
        {"contract_version", "dispatch_id", "linear", "target", "dependencies", "risk", "acceptance_criteria", "validation_profile", "allowed_scope", "merge_policy", "stale_conditions"},
        "contract",
        errors,
        optional={"factory_request", "registry"},
    )
    if root.get("contract_version") != CONTRACT_VERSION:
        errors.append("contract_version.unsupported")
    _string(root.get("dispatch_id"), "dispatch_id", errors, ID_PATTERN)
    _string(root.get("validation_profile"), "validation_profile", errors, ID_PATTERN, 128)
    if root.get("merge_policy") not in MERGE_POLICIES:
        errors.append("merge_policy.unsupported")
    _string_list(root.get("acceptance_criteria"), "acceptance_criteria", errors, max_items=50)
    _string_list(root.get("stale_conditions"), "stale_conditions", errors, max_items=10)
    if isinstance(root.get("stale_conditions"), list) and any(item not in STALE_CONDITIONS for item in root["stale_conditions"]):
        errors.append("stale_conditions.unsupported")

    linear = _mapping(root.get("linear"), "linear", errors)
    if linear is not None:
        _keys(linear, {"project_id", "issue_id", "identifier", "planning_revision", "planning_fingerprint"}, "linear", errors)
        for field in ("project_id", "issue_id", "planning_revision"):
            _string(linear.get(field), f"linear.{field}", errors, ID_PATTERN)
        _string(linear.get("identifier"), "linear.identifier", errors, ISSUE_PATTERN, 32)
        _string(linear.get("planning_fingerprint"), "linear.planning_fingerprint", errors, SHA256_PATTERN, 71)

    target = _mapping(root.get("target"), "target", errors)
    if target is not None:
        _keys(target, {"repository", "work_type", "execution_profile", "collision_group", "base_sha"}, "target", errors)
        _string(target.get("repository"), "target.repository", errors, REPOSITORY_PATTERN, 128)
        for field in ("work_type", "execution_profile", "collision_group"):
            _string(target.get(field), f"target.{field}", errors, ID_PATTERN, 128)
        _string(target.get("base_sha"), "target.base_sha", errors, BASE_SHA_PATTERN, 40)

    dependencies = root.get("dependencies")
    if not isinstance(dependencies, list) or len(dependencies) > 50:
        errors.append("dependencies.list")
    else:
        seen: set[str] = set()
        for index, dependency in enumerate(dependencies):
            item = _mapping(dependency, f"dependencies[{index}]", errors)
            if item is None:
                continue
            _keys(item, {"issue_id", "required_state"}, f"dependencies[{index}]", errors)
            _string(item.get("issue_id"), f"dependencies[{index}].issue_id", errors, ISSUE_PATTERN, 32)
            if item.get("required_state") not in DEPENDENCY_STATES:
                errors.append(f"dependencies[{index}].required_state.unsupported")
            if isinstance(item.get("issue_id"), str):
                if item["issue_id"] in seen:
                    errors.append("dependencies.duplicate")
                seen.add(item["issue_id"])

    risk = _mapping(root.get("risk"), "risk", errors)
    if risk is not None:
        _keys(risk, {"risk_class", "authority_class"}, "risk", errors)
        if risk.get("risk_class") not in RISK_CLASSES:
            errors.append("risk.risk_class.unsupported")
        if risk.get("authority_class") not in AUTHORITY_CLASSES:
            errors.append("risk.authority_class.unsupported")

    scope = _mapping(root.get("allowed_scope"), "allowed_scope", errors)
    if scope is not None:
        _keys(scope, {"paths", "max_files", "max_changed_lines"}, "allowed_scope", errors)
        _string_list(scope.get("paths"), "allowed_scope.paths", errors, max_items=100)
        if isinstance(scope.get("paths"), list) and any(
            not isinstance(path, str) or path.startswith("/") or path in {".", ".."} or ".." in path.split("/")
            for path in scope["paths"]
        ):
            errors.append("allowed_scope.paths.unsafe")
        for field in ("max_files", "max_changed_lines"):
            if not isinstance(scope.get(field), int) or isinstance(scope.get(field), bool) or scope[field] < 1:
                errors.append(f"allowed_scope.{field}.positive_integer")

    if "factory_request" in root:
        request = _mapping(root.get("factory_request"), "factory_request", errors)
        if request is not None:
            _keys(request, set(), "factory_request", errors, optional={"credential_profile", "concurrency", "model_policy_key", "escalation_class", "effect_classes"})
            for field in ("credential_profile", "model_policy_key", "escalation_class"):
                if field in request:
                    _string(request.get(field), f"factory_request.{field}", errors, ID_PATTERN, 128)
            if "concurrency" in request and (not isinstance(request["concurrency"], int) or isinstance(request["concurrency"], bool) or request["concurrency"] < 1):
                errors.append("factory_request.concurrency.positive_integer")
            if "effect_classes" in request:
                _string_list(request.get("effect_classes"), "factory_request.effect_classes", errors, allow_empty=True, max_items=20)

    if "registry" in root:
        registry = _mapping(root.get("registry"), "registry", errors)
        if registry is not None:
            _keys(registry, {"factory_id", "registry_version", "registry_digest", "entry_version"}, "registry", errors)
            for field in ("factory_id", "registry_version", "entry_version"):
                _string(registry.get(field), f"registry.{field}", errors, ID_PATTERN, 192)
            _string(registry.get("registry_digest"), "registry.registry_digest", errors, SHA256_PATTERN, 71)
    return errors


def _make_contract(value: Mapping[str, Any]) -> DispatchContract:
    serialized = canonical_json(value)
    digest = "sha256:" + hashlib.sha256(serialized.encode("utf-8")).hexdigest()
    return DispatchContract(serialized, digest)


def bind_registry_identity(contract: DispatchContract, binding: RegistryBinding) -> DispatchContract:
    """Materialize trusted registry identity after issue-authored validation."""
    document = contract.to_dict()
    if "registry" in document:
        raise ValueError("registry_identity_already_present")
    # Persist the effective request, including registry-derived defaults, so a
    # later dispatcher never has to guess which ceiling was actually admitted.
    document["factory_request"] = dict(binding.request)
    document["registry"] = binding.identity()
    return _make_contract(document)


def validate_dispatch_contract(
    value: Any,
    *,
    current_planning_revision: str | None = None,
    current_planning_fingerprint: str | None = None,
    current_base_sha: str | None = None,
    existing_dispatch_ids: Iterable[str] = (),
    supported_profiles: Iterable[str] | None = None,
) -> ContractValidation:
    """Validate static shape, then classify deterministic admission conditions."""
    errors = _static_errors(value)
    if errors:
        return ContractValidation("not-admitted", tuple(errors))
    contract = _make_contract(value)
    document = contract.to_dict()
    if contract.dispatch_id in set(existing_dispatch_ids):
        return ContractValidation("not-admitted", ("duplicate_dispatch_id",), contract)
    if supported_profiles is not None and contract.execution_profile not in set(supported_profiles):
        return ContractValidation("not-admitted", ("unsupported_execution_profile",), contract)
    linear = document["linear"]
    target = document["target"]
    stale: list[str] = []
    if current_planning_revision is not None and linear["planning_revision"] != current_planning_revision:
        stale.append("stale_planning_revision")
    if current_planning_fingerprint is not None and linear["planning_fingerprint"] != current_planning_fingerprint:
        stale.append("stale_planning_fingerprint")
    if current_base_sha is not None and target["base_sha"] != current_base_sha:
        stale.append("stale_base_sha")
    if stale:
        return ContractValidation("needs-replan", tuple(stale), contract)
    return ContractValidation("admitted", (), contract)
