"""Deterministic admission of an explicitly declared Linear dispatch contract."""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
import json
import re
from typing import Any, Iterable, Mapping

from factory.dispatch_contract import DispatchContract, validate_dispatch_contract
from factory.profile_registry import UnknownProfileError, resolve_profiles


CONTRACT_OPEN = "<!-- mhoo-factory-dispatch:v1 -->"
CONTRACT_CLOSE = "<!-- /mhoo-factory-dispatch:v1 -->"
ELIGIBLE_STATE_TYPES = frozenset({"unstarted", "started"})
CHECKOUT_HEAD_PATTERN = re.compile(r"^[0-9a-f]{40}$", re.IGNORECASE)


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
    expected_project_id: str,
    current_planning_revision: str | None = None,
    current_planning_fingerprint: str | None = None,
    current_base_sha: str | None = None,
    existing_dispatch_ids: Iterable[str] = (),
    existing_issue_dispatches: Mapping[str, Iterable[tuple[str, str]]] | None = None,
    seen_event_ids: Iterable[str] = (),
    event_id: str | None = None,
    allow_dry_run_authorization: bool = False,
    current_checkout_head: str | None = None,
    now: datetime | None = None,
) -> AdmissionDecision:
    """Return a deterministic decision without network, model, or provider writes."""
    if not isinstance(issue, Mapping):
        return _reject("issue_not_an_object")
    if event_id is not None and event_id in set(seen_event_ids):
        return _reject("replayed_event")
    if _project_id(issue) != expected_project_id:
        return _reject("issue_not_in_expected_project")
    state = issue.get("state")
    if not isinstance(state, Mapping) or state.get("type") not in ELIGIBLE_STATE_TYPES:
        return _reject("issue_not_eligible_state")
    issue_id = issue.get("id")
    identifier = issue.get("identifier")
    if not isinstance(issue_id, str) or not isinstance(identifier, str):
        return _reject("issue_identity_missing")

    value, errors = _declared_contract(issue.get("description"))
    if errors:
        return _reject(*errors)
    assert value is not None
    validation = validate_dispatch_contract(
        value,
        current_planning_revision=current_planning_revision,
        current_planning_fingerprint=current_planning_fingerprint,
        current_base_sha=current_base_sha,
        existing_dispatch_ids=existing_dispatch_ids,
        now=now,
    )
    if validation.outcome != "admitted":
        return AdmissionDecision(validation.outcome, validation.reasons, validation.contract)
    assert validation.contract is not None
    contract_value = validation.contract.to_dict()
    linear = contract_value["linear"]
    identity_errors = []
    if linear["project_id"] != expected_project_id:
        identity_errors.append("contract_project_mismatch")
    if linear["issue_id"] != issue_id:
        identity_errors.append("contract_issue_mismatch")
    if linear["identifier"] != identifier:
        identity_errors.append("contract_identifier_mismatch")
    if identity_errors:
        return _reject(*identity_errors)
    dry_run_authorization = validation.contract.dry_run_authorization
    if dry_run_authorization is not None:
        if not allow_dry_run_authorization:
            return AdmissionDecision("not-admitted", ("dry_run_authorization_requires_dry_run",), validation.contract)
        if not isinstance(current_checkout_head, str) or CHECKOUT_HEAD_PATTERN.fullmatch(current_checkout_head) is None:
            return AdmissionDecision("not-admitted", ("dry_run_authorization_checkout_head_missing",), validation.contract)
        if current_checkout_head.lower() != dry_run_authorization["checkout_head_sha"].lower():
            return AdmissionDecision("not-admitted", ("dry_run_authorization_checkout_head_mismatch",), validation.contract)
    revision = linear["planning_revision"]
    if validation.contract.dispatch_id != f"{identifier}@{revision}":
        return AdmissionDecision("not-admitted", ("dispatch_id_not_bound_to_issue_revision",), validation.contract)

    target = contract_value["target"]
    try:
        profiles = resolve_profiles(
            target["repository"], target["execution_profile"], contract_value["validation_profile"]
        )
    except (KeyError, TypeError, UnknownProfileError):
        return AdmissionDecision("not-admitted", ("unsupported_repository_or_profile",), validation.contract)
    allowed_groups = {group["id"] for group in profiles.collision_groups}
    if target["collision_group"] not in allowed_groups:
        return AdmissionDecision("not-admitted", ("unsupported_collision_group",), validation.contract)

    records = tuple((existing_issue_dispatches or {}).get(issue_id, ()))
    if records:
        if any(dispatch_id == validation.contract.dispatch_id and digest == validation.contract.digest for dispatch_id, digest in records):
            return AdmissionDecision("not-admitted", ("duplicate_admitted_dispatch",), validation.contract)
        return AdmissionDecision("needs-human", ("conflicting_admitted_dispatch",), validation.contract)

    risk = contract_value["risk"]
    if risk["risk_class"] == "high" or risk["authority_class"] == "cross-system":
        return AdmissionDecision("needs-human", ("high_risk_or_cross_system_contract",), validation.contract)
    return AdmissionDecision("admitted", (), validation.contract)
