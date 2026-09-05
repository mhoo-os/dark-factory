from __future__ import annotations

import copy
import json
from pathlib import Path
import unittest

from factory.admission import admit_linear_issue, contract_block
from factory.factory_registry import REGISTRY, RegistryError, resolve_factory, validate_current_binding


ROOT = Path(__file__).parents[1]
CASE = json.loads((ROOT / "tests/fixtures/admission_cases.json").read_text())["valid"]
REASONS = json.loads((ROOT / "tests/fixtures/factory_registry_cases.json").read_text())


def issue(contract=None):
    value = copy.deepcopy(CASE["issue"])
    value["description"] = contract_block(contract or copy.deepcopy(CASE["contract"]))
    return value


class FactoryRegistryTests(unittest.TestCase):
    def assert_refused(self, expected: str, contract=None, provider=None, registry=None) -> None:
        value = issue(contract)
        if provider:
            value.update(provider)
        decision = admit_linear_issue(value, registry=registry or REGISTRY)
        self.assertEqual(decision.outcome, "not-admitted")
        self.assertEqual(decision.reasons, (expected,))

    def test_exact_project_maps_to_the_sole_enabled_factory(self) -> None:
        decision = admit_linear_issue(issue())
        self.assertEqual(decision.outcome, "admitted")
        self.assertEqual(decision.contract.factory_id, "foundation-pilot")
        enabled = [item["factory_id"] for item in REGISTRY["factories"] if item["state"] != "disabled"]
        self.assertEqual(enabled, ["foundation-pilot"])

    def test_effective_request_defaults_are_bound_before_persistence(self) -> None:
        contract = copy.deepcopy(CASE["contract"])
        contract["factory_request"] = {"credential_profile": "none"}
        decision = admit_linear_issue(issue(contract))
        self.assertEqual(decision.outcome, "admitted")
        self.assertEqual(decision.contract.to_dict()["factory_request"], {
            "credential_profile": "none",
            "concurrency": 1,
            "model_policy_key": "static:execution-default-v1",
            "escalation_class": "human",
            "effect_classes": ["repository-write"],
        })

    def test_unknown_disabled_and_ambiguous_projects_fail_closed(self) -> None:
        unknown = copy.deepcopy(CASE["contract"])
        unknown["linear"]["project_id"] = "unknown-project"
        self.assert_refused(REASONS["unknown_project"], unknown, {"project": {"id": "unknown-project"}})

        disabled_registry = copy.deepcopy(REGISTRY)
        disabled = next(item for item in disabled_registry["factories"] if item["factory_id"] == "finance")
        disabled["linear"]["project_ids"] = ["finance-project"]
        disabled["linear"]["team_ids"] = [CASE["issue"]["team"]["id"]]
        disabled["linear"]["eligible_state_types"] = ["unstarted"]
        contract = copy.deepcopy(CASE["contract"])
        contract["linear"]["project_id"] = "finance-project"
        self.assert_refused(REASONS["disabled_factory"], contract, {"project": {"id": "finance-project"}}, disabled_registry)

        ambiguous = copy.deepcopy(REGISTRY)
        finance = next(item for item in ambiguous["factories"] if item["factory_id"] == "finance")
        finance["linear"]["project_ids"] = [CASE["project_id"]]
        finance["state"] = "pilot"
        self.assert_refused(REASONS["ambiguous_project"], registry=ambiguous)

    def test_issue_cannot_forge_factory_identity(self) -> None:
        contract = copy.deepcopy(CASE["contract"])
        contract["registry"] = {"factory_id": "finance"}
        self.assert_refused(REASONS["forged_factory_id"], contract)

    def test_repository_profile_and_collision_group_are_exact(self) -> None:
        for field, value, reason in (
            ("repository", "mhoo-os/finance", REASONS["unregistered_repository"]),
            ("execution_profile", "unknown-v1", REASONS["unregistered_profile"]),
            ("collision_group", "finance-runtime", REASONS["unregistered_collision_group"]),
        ):
            contract = copy.deepcopy(CASE["contract"])
            contract["target"][field] = value
            self.assert_refused(reason, contract)

        broad_scope = copy.deepcopy(CASE["contract"])
        broad_scope["allowed_scope"]["paths"] = ["**"]
        self.assert_refused("registry_scope_path_not_allowed", broad_scope)

    def test_risk_authority_merge_credential_and_concurrency_ceilings(self) -> None:
        cases = []
        risk = copy.deepcopy(CASE["contract"]); risk["risk"]["risk_class"] = "high"; cases.append((risk, REASONS["risk_above_ceiling"]))
        authority = copy.deepcopy(CASE["contract"]); authority["risk"]["authority_class"] = "cross-system"; cases.append((authority, REASONS["authority_above_ceiling"]))
        merge = copy.deepcopy(CASE["contract"]); merge["merge_policy"] = "auto-eligible"; cases.append((merge, REASONS["merge_above_ceiling"]))
        credential = copy.deepcopy(CASE["contract"]); credential["factory_request"] = {"credential_profile": "finance-production", "concurrency": 1}; cases.append((credential, REASONS["credential_above_ceiling"]))
        concurrency = copy.deepcopy(CASE["contract"]); concurrency["factory_request"] = {"credential_profile": "none", "concurrency": 2}; cases.append((concurrency, REASONS["concurrency_above_ceiling"]))
        effect = copy.deepcopy(CASE["contract"]); effect["factory_request"] = {"credential_profile": "none", "concurrency": 1, "effect_classes": ["deployment"]}; cases.append((effect, REASONS["forbidden_effect"]))
        for contract, reason in cases:
            with self.subTest(reason=reason):
                self.assert_refused(reason, contract)

    def test_execution_profile_binds_the_exact_canonical_model_policy_and_pricing(self) -> None:
        drift_registry = copy.deepcopy(REGISTRY)
        drift_registry["model_policies"].append({
            "id": "static:other-v1", "provider": "openrouter", "model": "other/model",
            "version": "2026-09-03", "pricing": {"cost_usd_per_output_token": 0.002, "request_overhead_usd": 0.5},
        })
        drift_registry["factories"][0]["model_policy_keys"].append("static:other-v1")
        drift = copy.deepcopy(CASE["contract"])
        drift["factory_request"] = {"credential_profile": "none", "concurrency": 1, "model_policy_key": "static:other-v1", "escalation_class": "human", "effect_classes": []}
        self.assert_refused("registry_model_policy_not_canonical", drift, registry=drift_registry)

        invalid_pricing = copy.deepcopy(REGISTRY)
        invalid_pricing["model_policies"][0]["pricing"]["cost_usd_per_output_token"] = 0
        with self.assertRaisesRegex(RegistryError, "registry_model_policy_invalid"):
            resolve_factory(CASE["issue"], CASE["contract"], registry=invalid_pricing)
        invalid_provider = copy.deepcopy(REGISTRY)
        invalid_provider["model_policies"][0]["provider"] = "other"
        with self.assertRaisesRegex(RegistryError, "registry_model_policy_invalid"):
            resolve_factory(CASE["issue"], CASE["contract"], registry=invalid_provider)

    def test_stale_revision_disable_and_old_event_replay_require_new_admission(self) -> None:
        admitted = admit_linear_issue(issue())
        identity = admitted.contract.to_dict()["registry"]

        changed = copy.deepcopy(REGISTRY)
        changed["registry_version"] = "2026-09-03.2"
        with self.assertRaisesRegex(RegistryError, REASONS["stale_revision"]):
            validate_current_binding(identity, registry=changed)
        replay = admit_linear_issue(issue(), registry=changed, admitted_registry_identity=identity)
        self.assertEqual((replay.outcome, replay.reasons), ("needs-replan", (REASONS["stale_revision"],)))

        disabled = copy.deepcopy(REGISTRY)
        disabled["factories"][0]["state"] = "disabled"
        with self.assertRaisesRegex(RegistryError, REASONS["disabled_after_admission"]):
            validate_current_binding(identity, registry=disabled)

    def test_cross_vertical_repository_and_credentials_are_denied(self) -> None:
        repository = copy.deepcopy(CASE["contract"])
        repository["target"]["repository"] = "mhoo-os/finance"
        self.assert_refused(REASONS["cross_vertical_repository"], repository)
        credential = copy.deepcopy(CASE["contract"])
        credential["factory_request"] = {"credential_profile": "customer-provider", "concurrency": 1}
        self.assert_refused(REASONS["credential_above_ceiling"], credential)


if __name__ == "__main__":
    unittest.main()
