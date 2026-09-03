"""Trusted, human-owned Factory Registry v1 resolution and ceiling checks."""
from __future__ import annotations

from dataclasses import dataclass
import fnmatch
import hashlib
import json
from pathlib import Path
from typing import Any, Iterable, Mapping


REGISTRY_PATH = Path(__file__).with_name("factory_registry.json")
REGISTRY = json.loads(REGISTRY_PATH.read_text())
ACTIVE_STATES = frozenset({"pilot", "limited", "enabled"})
RISK_ORDER = {"low": 0, "medium": 1, "high": 2}
AUTHORITY_ORDER = {"repository-local": 0, "cross-system": 1}
MERGE_ORDER = {"human": 0, "auto-eligible": 1}


class RegistryError(ValueError):
    """A deterministic, fail-closed registry decision."""


@dataclass(frozen=True)
class RegistryBinding:
    factory_id: str
    registry_version: str
    registry_digest: str
    entry_version: str
    entry: Mapping[str, Any]
    repository: Mapping[str, Any]
    request: Mapping[str, Any]

    def identity(self) -> dict[str, str]:
        return {
            "factory_id": self.factory_id,
            "registry_version": self.registry_version,
            "registry_digest": self.registry_digest,
            "entry_version": self.entry_version,
        }


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


def registry_digest(registry: Mapping[str, Any] = REGISTRY) -> str:
    return "sha256:" + hashlib.sha256(canonical_json(registry).encode()).hexdigest()


def _id(value: Any, reason: str) -> str:
    if not isinstance(value, str) or not value or len(value) > 192:
        raise RegistryError(reason)
    return value


def _duplicates(values: Iterable[str]) -> bool:
    items = list(values)
    return len(items) != len(set(items))


def inherent_effect_classes(contract: Mapping[str, Any]) -> frozenset[str]:
    """Effects that follow from execution even if the request omits them."""
    request = contract.get("factory_request") or {}
    if not isinstance(request, Mapping):
        raise RegistryError("registry_request_invalid")
    effects = {"repository-write"}
    if request.get("credential_profile", "none") != "none":
        effects.add("provider-read")
    if contract.get("merge_policy") == "auto-eligible":
        effects.add("merge")
    return frozenset(effects)


def effective_effect_classes(contract: Mapping[str, Any]) -> frozenset[str]:
    request = contract.get("factory_request") or {}
    if not isinstance(request, Mapping):
        raise RegistryError("registry_request_invalid")
    requested = request.get("effect_classes", [])
    if not isinstance(requested, list) or any(not isinstance(item, str) or not item for item in requested):
        raise RegistryError("registry_effect_classes_invalid")
    return frozenset(requested) | inherent_effect_classes(contract)


def active_intake_mappings(*, registry: Mapping[str, Any] = REGISTRY) -> tuple[tuple[str, str, str], ...]:
    """Return every active factory/project/team mapping; never select a named pilot."""
    validate_registry(registry)
    mappings = [
        (str(factory["factory_id"]), project_id, team_id)
        for factory in registry["factories"] if factory["state"] in ACTIVE_STATES
        for project_id in factory["linear"]["project_ids"]
        for team_id in factory["linear"]["team_ids"]
    ]
    projects = [project_id for _, project_id, _ in mappings]
    if _duplicates(projects):
        raise RegistryError("registry_active_project_ambiguous")
    return tuple(sorted(mappings))


def assert_human_only_legacy_operation(repository: str, *, registry: Mapping[str, Any] = REGISTRY) -> None:
    """Legacy scripts may only hand work to a human; they never merge or deploy."""
    validate_registry(registry)
    matches = [factory for factory in registry["factories"] if any(item.get("repository") == repository for item in factory["repositories"])]
    if len(matches) != 1:
        raise RegistryError("registry_repository_ambiguous")
    risk = matches[0]["risk"]
    if risk.get("merge_ceiling") != "human" or repository not in risk.get("autonomous_merge_exclusions", []):
        raise RegistryError("registry_human_only_operation_required")


def validate_registry(registry: Mapping[str, Any] = REGISTRY) -> None:
    if not isinstance(registry, Mapping) or registry.get("schema_version") != "v1":
        raise RegistryError("registry_schema_invalid")
    _id(registry.get("registry_version"), "registry_version_invalid")
    factories = registry.get("factories")
    if not isinstance(factories, list) or not factories:
        raise RegistryError("registry_factories_invalid")
    factory_ids = [item.get("factory_id") for item in factories if isinstance(item, Mapping)]
    if len(factory_ids) != len(factories) or any(not isinstance(item, str) for item in factory_ids) or _duplicates(factory_ids):
        raise RegistryError("registry_factory_id_ambiguous")
    for factory in factories:
        if factory.get("state") not in {"disabled", "pilot", "limited", "enabled"}:
            raise RegistryError("registry_state_invalid")
        for field in ("display_name", "owner", "entry_version", "approval_record", "rollout_phase", "rollback_path"):
            _id(factory.get(field), f"registry_{field}_invalid")
        linear = factory.get("linear")
        if not isinstance(linear, Mapping):
            raise RegistryError("registry_linear_boundary_invalid")
        for field in ("project_ids", "team_ids", "eligible_state_types", "required_contract_versions", "required_labels"):
            values = linear.get(field)
            if not isinstance(values, list) or _duplicates(values) or any(not isinstance(item, str) or not item for item in values):
                raise RegistryError(f"registry_{field}_invalid")
        repositories = factory.get("repositories")
        if not isinstance(repositories, list):
            raise RegistryError("registry_repositories_invalid")
        names = [item.get("repository") for item in repositories if isinstance(item, Mapping)]
        if len(names) != len(repositories) or any(not isinstance(item, str) for item in names) or _duplicates(names):
            raise RegistryError("registry_repository_ambiguous")
        risk = factory.get("risk")
        if not isinstance(risk, Mapping) or risk.get("merge_ceiling") != "human":
            raise RegistryError("registry_human_merge_required")
        exclusions = risk.get("autonomous_merge_exclusions")
        if not isinstance(exclusions, list) or any(not isinstance(item, str) or not item for item in exclusions):
            raise RegistryError("registry_autonomous_merge_exclusions_invalid")
        if factory.get("state") in ACTIVE_STATES and not set(names).issubset(exclusions):
            raise RegistryError("registry_autonomous_merge_exclusions_incomplete")
    profiles = registry.get("execution_profiles")
    validations = registry.get("validation_profiles")
    groups = registry.get("collision_groups")
    for values, reason in ((profiles, "registry_execution_profiles_invalid"), (validations, "registry_validation_profiles_invalid"), (groups, "registry_collision_groups_invalid")):
        if not isinstance(values, list) or not values or _duplicates(item.get("id") for item in values if isinstance(item, Mapping)):
            raise RegistryError(reason)


def _provider_id(issue: Mapping[str, Any], field: str) -> str | None:
    value = issue.get(field)
    if isinstance(value, Mapping) and isinstance(value.get("id"), str):
        return value["id"]
    for key in (f"{field}_id", f"{field}Id"):
        if isinstance(issue.get(key), str):
            return issue[key]
    return None


def resolve_factory(
    issue: Mapping[str, Any],
    contract: Mapping[str, Any],
    *,
    registry: Mapping[str, Any] = REGISTRY,
) -> RegistryBinding:
    """Resolve authority from provider project/team identity, never issue prose."""
    validate_registry(registry)
    project_id = _provider_id(issue, "project")
    team_id = _provider_id(issue, "team")
    if project_id is None:
        raise RegistryError("registry_project_identity_missing")
    if team_id is None:
        raise RegistryError("registry_team_identity_missing")
    matches = [item for item in registry["factories"] if project_id in item["linear"]["project_ids"]]
    if not matches:
        raise RegistryError("registry_unknown_project")
    if len(matches) != 1:
        raise RegistryError("registry_ambiguous_project")
    entry = matches[0]
    if entry["state"] not in ACTIVE_STATES:
        raise RegistryError("registry_factory_disabled")
    linear = entry["linear"]
    if team_id not in linear["team_ids"]:
        raise RegistryError("registry_team_not_allowed")
    state = issue.get("state")
    state_type = state.get("type") if isinstance(state, Mapping) else None
    if state_type not in linear["eligible_state_types"]:
        raise RegistryError("registry_issue_state_not_allowed")
    if contract.get("contract_version") not in linear["required_contract_versions"]:
        raise RegistryError("registry_contract_version_not_allowed")
    labels = issue.get("labels")
    entries = labels if isinstance(labels, list) else labels.get("nodes", []) if isinstance(labels, Mapping) else []
    label_names = {item if isinstance(item, str) else item.get("name") for item in entries if isinstance(item, (str, Mapping))}
    if not set(linear["required_labels"]).issubset(label_names):
        raise RegistryError("registry_required_label_missing")
    target = contract.get("target")
    if not isinstance(target, Mapping):
        raise RegistryError("registry_target_invalid")
    repository_matches = [item for item in entry["repositories"] if item.get("repository") == target.get("repository")]
    if not repository_matches:
        raise RegistryError("registry_repository_not_allowed")
    if len(repository_matches) != 1:
        raise RegistryError("registry_repository_ambiguous")
    repository = repository_matches[0]
    checks = (
        (target.get("work_type"), repository["work_types"], "registry_work_type_not_allowed"),
        (target.get("execution_profile"), repository["execution_profiles"], "registry_execution_profile_not_allowed"),
        (contract.get("validation_profile"), repository["validation_profiles"], "registry_validation_profile_not_allowed"),
        (target.get("collision_group"), repository["collision_groups"], "registry_collision_group_not_allowed"),
    )
    for requested, allowed, reason in checks:
        if requested not in allowed:
            raise RegistryError(reason)
    scope = contract.get("allowed_scope")
    if not isinstance(scope, Mapping):
        raise RegistryError("registry_scope_invalid")
    if scope.get("max_files", 0) > repository["scope"]["max_files"] or scope.get("max_files", 0) > entry["capacity"]["max_files"]:
        raise RegistryError("registry_scope_max_files_exceeded")
    if scope.get("max_changed_lines", 0) > repository["scope"]["max_changed_lines"] or scope.get("max_changed_lines", 0) > entry["capacity"]["max_changed_lines"]:
        raise RegistryError("registry_scope_max_changed_lines_exceeded")
    for path in scope.get("paths", []):
        # Match the requested path/pattern against the trusted ceiling only.
        # Reversing these operands would let a broad request such as ``**``
        # match every narrower registry path and silently expand authority.
        if not any(fnmatch.fnmatch(path, allowed) for allowed in repository["scope"]["paths"]):
            raise RegistryError("registry_scope_path_not_allowed")
    risk = contract.get("risk")
    if not isinstance(risk, Mapping) or RISK_ORDER.get(risk.get("risk_class"), 99) > RISK_ORDER[entry["risk"]["maximum_risk_class"]]:
        raise RegistryError("registry_risk_ceiling_exceeded")
    if AUTHORITY_ORDER.get(risk.get("authority_class"), 99) > AUTHORITY_ORDER[entry["risk"]["maximum_authority_class"]]:
        raise RegistryError("registry_authority_ceiling_exceeded")
    if MERGE_ORDER.get(contract.get("merge_policy"), 99) > MERGE_ORDER[entry["risk"]["merge_ceiling"]]:
        raise RegistryError("registry_merge_ceiling_exceeded")
    if contract.get("merge_policy") != "human" or entry["risk"].get("merge_ceiling") != "human":
        raise RegistryError("registry_human_merge_required")
    if target.get("repository") not in entry["risk"].get("autonomous_merge_exclusions", []):
        raise RegistryError("registry_autonomous_merge_exclusion_missing")
    request = contract.get("factory_request") or {}
    if not isinstance(request, Mapping):
        raise RegistryError("registry_request_invalid")
    credential_profile = request.get("credential_profile", "none")
    if credential_profile not in entry["credentials"]["sandbox_secret_profiles"]:
        raise RegistryError("registry_credential_profile_not_allowed")
    concurrency = request.get("concurrency", 1)
    if not isinstance(concurrency, int) or isinstance(concurrency, bool) or concurrency < 1 or concurrency > min(entry["capacity"]["per_factory_concurrency"], entry["capacity"]["global_concurrency"], entry["capacity"]["per_repository_concurrency"], entry["capacity"]["collision_group_concurrency"]):
        raise RegistryError("registry_concurrency_ceiling_exceeded")
    execution = next(item for item in registry["execution_profiles"] if item.get("id") == target.get("execution_profile"))
    model_policy = request.get("model_policy_key", execution.get("model_policy"))
    if model_policy not in entry["model_policy_keys"]:
        raise RegistryError("registry_model_policy_not_allowed")
    if request.get("escalation_class", "human") != entry["escalation_ceiling"]:
        raise RegistryError("registry_escalation_ceiling_exceeded")
    effect_classes = effective_effect_classes(contract)
    forbidden = set(entry["risk"]["forbidden_work_effect_classes"])
    if "all" in forbidden and effect_classes or forbidden.intersection(effect_classes):
        raise RegistryError("registry_effect_class_forbidden")
    permitted = set(entry["risk"].get("permitted_work_effect_classes", []))
    if not effect_classes.issubset(permitted):
        raise RegistryError("registry_effect_class_not_permitted")
    limits = execution.get("limits")
    if not isinstance(limits, Mapping):
        raise RegistryError("registry_profile_limits_invalid")
    for field in ("cost_usd", "timeout_seconds", "max_changed_lines", "max_files"):
        if not isinstance(limits.get(field), (int, float)) or limits[field] > entry["capacity"][field]:
            raise RegistryError("registry_profile_limit_exceeds_capacity")
    normalized_request = {
        "credential_profile": credential_profile,
        "concurrency": concurrency,
        "model_policy_key": model_policy,
        "escalation_class": request.get("escalation_class", "human"),
        "effect_classes": sorted(effect_classes),
    }
    return RegistryBinding(
        entry["factory_id"], registry["registry_version"], registry_digest(registry),
        entry["entry_version"], entry, repository, normalized_request,
    )


def registry_entry(factory_id: str, *, registry: Mapping[str, Any] = REGISTRY) -> Mapping[str, Any]:
    validate_registry(registry)
    matches = [item for item in registry["factories"] if item["factory_id"] == factory_id]
    if len(matches) != 1:
        raise RegistryError("registry_factory_identity_missing")
    return matches[0]


def validate_current_binding(identity: Mapping[str, Any], *, registry: Mapping[str, Any] = REGISTRY) -> None:
    """Require explicit re-admission after any execution-significant registry change."""
    entry = registry_entry(str(identity.get("factory_id", "")), registry=registry)
    if entry["state"] not in ACTIVE_STATES:
        raise RegistryError("registry_factory_disabled")
    expected = {
        "factory_id": entry["factory_id"],
        "registry_version": registry["registry_version"],
        "registry_digest": registry_digest(registry),
        "entry_version": entry["entry_version"],
    }
    if any(identity.get(key) != value for key, value in expected.items()):
        raise RegistryError("registry_stale_re_admission_required")
