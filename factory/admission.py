"""Deterministic admission of an explicitly declared Linear dispatch contract."""
from __future__ import annotations

from dataclasses import dataclass
import json
from typing import Any, Iterable, Mapping

from factory.dispatch_contract import DispatchContract, bind_registry_identity, validate_dispatch_contract
from factory.factory_registry import REGISTRY, RegistryError, resolve_factory, validate_current_binding
from factory.profile_registry import UnknownProfileError, resolve_profiles


CONTRACT_OPEN = "<!-- mhoo-factory-dispatch:v1 -->"
CONTRACT_CLOSE = "<!-- /mhoo-factory-dispatch:v1 -->"
ELIGIBLE_STATE_TYPES = frozenset({"unstarted", "started"})


@dataclass(frozen=True)
class AdmissionDecision:
    outcome: str
    reasons: tuple[str, ...]
    contract: DispatchContract | None = None

    @property
    def dispatch_id(self) -> str | None:
        return self.contract.dispatch_id if self.contract else None

    @property
    def digest(self) -> str | None:
        return self.contract.digest if self.contract else None


def contract_block(value: Mapping[str, Any]) -> str:
    """Encode one explicit contract block for a Linear description or fixture."""
    serialized = json.dumps(value, sort_keys=True, separators=(",", ":"))
    return f"{CONTRACT_OPEN}\n{serialized}\n{CONTRACT_CLOSE}"


def _declared_contract(description: Any) -> tuple[Mapping[str, Any] | None, tuple[str, ...]]:
    if not isinstance(description, str):
        return None, ("description_missing",)
    openings = description.count(CONTRACT_OPEN)
    closings = description.count(CONTRACT_CLOSE)
    if openings == 0 or closings == 0:
        return None, ("contract_block_missing",)
    if openings != 1 or closings != 1:
        return None, ("contract_block_ambiguous",)
    start = description.index(CONTRACT_OPEN) + len(CONTRACT_OPEN)
    end = description.index(CONTRACT_CLOSE)
    if end <= start:
        return None, ("contract_block_order_invalid",)
    try:
        value = json.loads(description[start:end].strip())
    except json.JSONDecodeError:
        return None, ("contract_json_invalid",)
    if not isinstance(value, dict):
        return None, ("contract_json_not_object",)
    if "factory_id" in value or "registry" in value:
        return None, ("issue_factory_identity_forbidden",)
    return value, ()


def _project_id(issue: Mapping[str, Any]) -> str | None:
    project = issue.get("project")
    if isinstance(project, Mapping):
        value = project.get("id")
        return value if isinstance(value, str) else None
    value = issue.get("project_id") or issue.get("projectId")
    return value if isinstance(value, str) else None


def _reject(*reasons: str) -> AdmissionDecision:
    return AdmissionDecision("not-admitted", tuple(reasons))


def admit_linear_issue(
    issue: Mapping[str, Any],
    *,
    registry: Mapping[str, Any] = REGISTRY,
    current_planning_revision: str | None = None,
    current_planning_fingerprint: str | None = None,
    current_base_sha: str | None = None,
    existing_dispatch_ids: Iterable[str] = (),
    existing_issue_dispatches: Mapping[str, Iterable[tuple[str, str]]] | None = None,
    seen_event_ids: Iterable[str] = (),
    event_id: str | None = None,
    admitted_registry_identity: Mapping[str, Any] | None = None,
) -> AdmissionDecision:
    """Return a deterministic decision without network, model, or provider writes."""
    if not isinstance(issue, Mapping):
        return _reject("issue_not_an_object")
    if event_id is not None and event_id in set(seen_event_ids):
        return _reject("replayed_event")
    issue_id = issue.get("id")
    identifier = issue.get("identifier")
    if not isinstance(issue_id, str) or not isinstance(identifier, str):
        return _reject("issue_identity_missing")

    value, errors = _declared_contract(issue.get("description"))
    if errors:
        return _reject(*errors)
    assert value is not None
    linear = value.get("linear")
    if isinstance(linear, Mapping):
        identity_errors = []
        if linear.get("project_id") != _project_id(issue):
            identity_errors.append("contract_project_mismatch")
        if linear.get("issue_id") != issue_id:
            identity_errors.append("contract_issue_mismatch")
        if linear.get("identifier") != identifier:
            identity_errors.append("contract_identifier_mismatch")
        if identity_errors:
            return _reject(*identity_errors)

    validation = validate_dispatch_contract(
        value,
        current_planning_revision=current_planning_revision,
        current_planning_fingerprint=current_planning_fingerprint,
        current_base_sha=current_base_sha,
        existing_dispatch_ids=existing_dispatch_ids,
    )
    if validation.outcome != "admitted":
        return AdmissionDecision(validation.outcome, validation.reasons, validation.contract)
    assert validation.contract is not None
    try:
        binding = resolve_factory(issue, validation.contract.to_dict(), registry=registry)
        if admitted_registry_identity is not None:
            validate_current_binding(admitted_registry_identity, registry=registry)
    except RegistryError as error:
        outcome = "needs-replan" if str(error) == "registry_stale_re_admission_required" else "not-admitted"
        return AdmissionDecision(outcome, (str(error),), validation.contract)
    bound_contract = bind_registry_identity(validation.contract, binding)
    contract_value = bound_contract.to_dict()
    revision = contract_value["linear"]["planning_revision"]
    if bound_contract.dispatch_id != f"{identifier}@{revision}":
        return AdmissionDecision("not-admitted", ("dispatch_id_not_bound_to_issue_revision",), bound_contract)

    target = contract_value["target"]
    try:
        profiles = resolve_profiles(
            target["repository"], target["execution_profile"], contract_value["validation_profile"]
        )
    except (KeyError, TypeError, UnknownProfileError):
        return AdmissionDecision("not-admitted", ("unsupported_repository_or_profile",), bound_contract)
    allowed_groups = {group["id"] for group in profiles.collision_groups}
    if target["collision_group"] not in allowed_groups:
        return AdmissionDecision("not-admitted", ("unsupported_collision_group",), bound_contract)

    records = tuple((existing_issue_dispatches or {}).get(issue_id, ()))
    if records:
        if any(dispatch_id == bound_contract.dispatch_id and digest == bound_contract.digest for dispatch_id, digest in records):
            return AdmissionDecision("not-admitted", ("duplicate_admitted_dispatch",), bound_contract)
        return AdmissionDecision("needs-human", ("conflicting_admitted_dispatch",), bound_contract)
    return AdmissionDecision("admitted", (), bound_contract)
