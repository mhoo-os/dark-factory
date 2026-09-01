"""Deterministic contract-to-repository grounding; no planning model is involved."""
from __future__ import annotations

from dataclasses import dataclass
import fnmatch
import hashlib
import json
from typing import Mapping

from factory.dispatch_contract import DispatchContract
from factory.profile_registry import resolve_profiles


@dataclass(frozen=True)
class RepositorySnapshot:
    repository: str
    base_sha: str
    files: tuple[str, ...]
    renames: Mapping[str, str] | None = None
    contradictions: tuple[str, ...] = ()


@dataclass(frozen=True)
class GroundingDecision:
    outcome: str
    reasons: tuple[str, ...]
    contract_digest: str
    profile_digest: str | None
    base_sha: str
    touchpoints: tuple[str, ...]
    path_map: Mapping[str, str]
    steps: tuple[str, ...]
    digest: str

    def to_dict(self) -> dict[str, object]:
        return {
            "outcome": self.outcome, "reasons": list(self.reasons),
            "contract_digest": self.contract_digest, "profile_digest": self.profile_digest,
            "base_sha": self.base_sha, "touchpoints": list(self.touchpoints),
            "path_map": dict(self.path_map), "steps": list(self.steps), "digest": self.digest,
        }


def _output_digest(value: Mapping[str, object]) -> str:
    encoded = json.dumps(value, sort_keys=True, separators=(",", ":")).encode()
    return "sha256:" + hashlib.sha256(encoded).hexdigest()


def ground_contract(contract: DispatchContract, snapshot: RepositorySnapshot) -> GroundingDecision:
    """Lower only the approved contract against observed repository facts."""
    document = contract.to_dict()
    target = document["target"]
    common = {
        "contract_digest": contract.digest, "base_sha": snapshot.base_sha,
        "touchpoints": (), "path_map": {}, "steps": (),
    }
    if snapshot.repository != target["repository"]:
        reasons = ("repository_changed",)
        return GroundingDecision("needs-replan", reasons, contract.digest, None, snapshot.base_sha, (), {}, (), _output_digest({**common, "outcome": "needs-replan", "reasons": reasons}))
    if snapshot.base_sha != target["base_sha"]:
        reasons = ("base_sha_changed",)
        return GroundingDecision("needs-replan", reasons, contract.digest, None, snapshot.base_sha, (), {}, (), _output_digest({**common, "outcome": "needs-replan", "reasons": reasons}))
    if snapshot.contradictions:
        reasons = tuple(sorted(set(snapshot.contradictions)))
        return GroundingDecision("needs-replan", reasons, contract.digest, None, snapshot.base_sha, (), {}, (), _output_digest({**common, "outcome": "needs-replan", "reasons": reasons}))

    try:
        profiles = resolve_profiles(target["repository"], target["execution_profile"], document["validation_profile"])
    except (KeyError, TypeError, ValueError) as error:
        reasons = ("profile_resolution_failed", str(error))
        return GroundingDecision("needs-replan", reasons, contract.digest, None, snapshot.base_sha, (), {}, (), _output_digest({**common, "outcome": "needs-replan", "reasons": reasons}))
    patterns = tuple(document["allowed_scope"]["paths"])
    files = tuple(sorted(set(snapshot.files)))
    renames = dict(snapshot.renames or {})
    path_map: dict[str, str] = {}
    for old, new in sorted(renames.items()):
        if any(fnmatch.fnmatch(old, pattern) for pattern in patterns):
            if not any(fnmatch.fnmatch(new, pattern) for pattern in patterns):
                reasons = ("file_movement_outside_declared_scope",)
                return GroundingDecision("needs-replan", reasons, contract.digest, profiles.digest, snapshot.base_sha, (), {}, (), _output_digest({**common, "outcome": "needs-replan", "reasons": reasons, "profile_digest": profiles.digest}))
            path_map[old] = new
    touchpoints = tuple(sorted(set(path_map.values()) | {path for path in files if any(fnmatch.fnmatch(path, pattern) for pattern in patterns)}))
    steps = tuple(
        [f"acceptance:{index}:{criterion}" for index, criterion in enumerate(document["acceptance_criteria"], 1)]
        + [f"validation:{check}" for check in profiles.validation["full_checks"]]
    )
    result = {
        "outcome": "grounded", "reasons": [], "contract_digest": contract.digest,
        "profile_digest": profiles.digest, "base_sha": snapshot.base_sha,
        "touchpoints": touchpoints, "path_map": path_map, "steps": steps,
    }
    return GroundingDecision("grounded", (), contract.digest, profiles.digest, snapshot.base_sha, touchpoints, path_map, steps, _output_digest(result))
