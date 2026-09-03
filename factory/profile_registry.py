"""Versioned execution, validation, and collision-group profile registry."""
from __future__ import annotations

import fnmatch
import hashlib
import json
from dataclasses import dataclass
from typing import Any, Iterable

from factory.factory_registry import REGISTRY, registry_digest, validate_registry


class UnknownProfileError(ValueError):
    pass


@dataclass(frozen=True)
class ProfileBundle:
    repository: str
    execution: dict[str, Any]
    validation: dict[str, Any]
    collision_groups: tuple[dict[str, Any], ...]
    digest: str


def _canonical(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


def _digest(value: Any) -> str:
    return "sha256:" + hashlib.sha256(_canonical(value).encode("utf-8")).hexdigest()


def _one(items: list[dict[str, Any]], profile_id: str, kind: str) -> dict[str, Any]:
    for item in items:
        if item.get("id") == profile_id:
            return item
    raise UnknownProfileError(f"unknown_{kind}_profile:{profile_id}")


def resolve_profiles(repository: str, execution_profile: str, validation_profile: str) -> ProfileBundle:
    """Resolve only a declared target/profile tuple; never infer a target."""
    validate_registry()
    targets = [
        target
        for factory in REGISTRY["factories"]
        if factory["state"] != "disabled"
        for target in factory["repositories"]
        if target.get("repository") == repository
    ]
    if len(targets) != 1:
        raise UnknownProfileError(f"unsupported_repository:{repository}")
    target = targets[0]
    if execution_profile not in target.get("execution_profiles", []) or validation_profile not in target.get("validation_profiles", []):
        raise UnknownProfileError("profile_not_declared_for_repository")
    execution = _one(REGISTRY["execution_profiles"], execution_profile, "execution")
    validation = _one(REGISTRY["validation_profiles"], validation_profile, "validation")
    groups: list[dict[str, Any]] = []
    for group_id in target.get("collision_groups", []):
        group = next((item for item in REGISTRY["collision_groups"] if item.get("id") == group_id), None)
        if group is None:
            raise UnknownProfileError(f"unknown_collision_group:{group_id}")
        groups.append(group)
    binding = {"registry_version": REGISTRY["registry_version"], "registry_digest": registry_digest(), "repository": repository, "execution": execution, "validation": validation, "collision_groups": groups}
    return ProfileBundle(repository, execution, validation, tuple(groups), _digest(binding))


def collision_groups_for_paths(bundle: ProfileBundle, paths: Iterable[str]) -> tuple[str, ...]:
    """Return matching group IDs in sorted order; unknown paths use a shared fence."""
    matched = {group["id"] for path in paths for group in bundle.collision_groups if any(fnmatch.fnmatch(path, pattern) for pattern in group["paths"])}
    return tuple(sorted(matched or {"unclassified"}))


def collision_groups_conflict(left: Iterable[str], right: Iterable[str]) -> bool:
    """Deterministically compare scheduler collision keys."""
    return bool(set(left) & set(right))
