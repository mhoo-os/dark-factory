from __future__ import annotations

import unittest

from factory.factory_registry import (
    REGISTRY,
    RegistryError,
    assert_human_only_legacy_operation,
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


if __name__ == "__main__":
    unittest.main()
