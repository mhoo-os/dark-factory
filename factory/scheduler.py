"""Deterministic eligibility ordering for admitted factory runs."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable, Mapping

from factory.leases import LeaseCoordinator, LeaseGrant, lease_keys


READY_STATES = frozenset({"admitted", "queued"})


@dataclass(frozen=True)
class SchedulableRun:
    dispatch_id: str
    identifier: str
    repository: str
    collision_groups: tuple[str, ...]
    priority: int
    state: str
    dependency_states: Mapping[str, str]
    risk_class: str = "low"
    authority_class: str = "repository-local"
    merge_policy: str = "human"
    attempts: int = 0
    max_attempts: int = 2
    stop_requested: bool = False
    factory_id: str | None = None
    registry_version: str | None = None
    registry_digest: str | None = None
    registry_entry_version: str | None = None


@dataclass(frozen=True)
class SchedulingResult:
    eligible: tuple[SchedulableRun, ...]
    blocked: Mapping[str, str]


def choose_eligible(
    runs: Iterable[SchedulableRun],
    *,
    active_repositories: Mapping[str, int] | None = None,
    active_collision_groups: Mapping[str, int] | None = None,
    active_global: int = 0,
    global_limit: int = 1,
    repository_limit: int = 1,
    autonomy_level: int = 0,
) -> SchedulingResult:
    """Select a stable prefix without mutating state or invoking a model."""
    repositories = dict(active_repositories or {})
    collisions = dict(active_collision_groups or {})
    blocked: dict[str, str] = {}
    selected: list[SchedulableRun] = []
    ordered = sorted(runs, key=lambda item: (item.priority, item.identifier, item.dispatch_id))
    for run in ordered:
        reason = None
        if run.state not in READY_STATES:
            reason = "state_not_ready"
        elif run.stop_requested:
            reason = "stop_requested"
        elif run.risk_class == "high" or run.authority_class == "cross-system":
            reason = "human_authorization_required"
        elif run.merge_policy == "auto-eligible" and autonomy_level < 3:
            reason = "merge_policy_not_human_reviewed"
        elif run.attempts >= run.max_attempts:
            reason = "attempt_cap_reached"
        elif any(state != "completed" for state in run.dependency_states.values()):
            reason = "dependency_not_completed"
        elif active_global + len(selected) >= global_limit:
            reason = "global_capacity_full"
        elif repositories.get(run.repository, 0) + sum(item.repository == run.repository for item in selected) >= repository_limit:
            reason = "repository_capacity_full"
        elif any(
            collisions.get(group, 0) + sum(group in item.collision_groups for item in selected) > 0
            for group in run.collision_groups
        ):
            reason = "collision_lease_unavailable"
        if reason is not None:
            blocked[run.dispatch_id] = reason
            continue
        selected.append(run)
    return SchedulingResult(tuple(selected), blocked)


def acquire_run_lease(
    coordinator: LeaseCoordinator,
    run: SchedulableRun,
    *,
    owner: str,
    now: int,
    ttl_seconds: int,
) -> LeaseGrant:
    return coordinator.acquire(
        lease_keys(run.repository, run.collision_groups),
        owner=owner, dispatch_id=run.dispatch_id, now=now, ttl_seconds=ttl_seconds,
        registry_identity={
            "factory_id": run.factory_id,
            "registry_version": run.registry_version,
            "registry_digest": run.registry_digest,
            "entry_version": run.registry_entry_version,
        } if run.factory_id and run.registry_version and run.registry_digest and run.registry_entry_version else None,
    )
