from __future__ import annotations

import unittest
import copy

from factory.factory_registry import (
    REGISTRY,
    RegistryError,
    assert_human_only_legacy_operation,
    active_intake_mappings,
    effective_effect_classes,
)


class FactoryRegistryPolicyTests(unittest.TestCase):
    def test_effects_include_repository_write_and_provider_read(self):
        contract = {"merge_policy": "human", "factory_request": {"credential_profile": "github-linear-openrouter-v1", "effect_classes": []}}
        self.assertEqual(effective_effect_classes(contract), {"repository-write", "provider-read"})

    def test_human_only_legacy_operation_requires_registry_exclusion(self):
        assert_human_only_legacy_operation("mhoo-os/dark-factory")
        altered = {**REGISTRY, "factories": [{**REGISTRY["factories"][0], "risk": {**REGISTRY["factories"][0]["risk"], "autonomous_merge_exclusions": []}}, *REGISTRY["factories"][1:]]}
        with self.assertRaises(RegistryError):
            assert_human_only_legacy_operation("mhoo-os/dark-factory", registry=altered)

    def test_one_project_can_have_multiple_approved_teams_but_not_multiple_factories(self):
        same_factory = copy.deepcopy(REGISTRY)
        same_factory["factories"][0]["linear"]["team_ids"].append("second-approved-team")
        mappings = active_intake_mappings(registry=same_factory)
        self.assertIn(("foundation-pilot", same_factory["factories"][0]["linear"]["project_ids"][0], "second-approved-team"), mappings)

        cross_factory = copy.deepcopy(same_factory)
        other = cross_factory["factories"][1]
        other["state"] = "pilot"
        other["linear"]["project_ids"] = [same_factory["factories"][0]["linear"]["project_ids"][0]]
        other["linear"]["team_ids"] = ["other-team"]
        with self.assertRaises(RegistryError):
            active_intake_mappings(registry=cross_factory)


if __name__ == "__main__":
    unittest.main()
