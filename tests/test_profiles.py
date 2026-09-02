from __future__ import annotations

import unittest

from factory.profile_registry import (
    UnknownProfileError,
    collision_groups_conflict,
    collision_groups_for_paths,
    resolve_profiles,
)


class ProfileRegistryTests(unittest.TestCase):
    def test_resolves_concrete_repository_profiles_and_digest(self):
        bundle = resolve_profiles("mhoo-os/dark-factory", "python-tests-v1", "python-tests-v1")
        self.assertEqual(bundle.repository, "mhoo-os/dark-factory")
        self.assertTrue(bundle.digest.startswith("sha256:"))
        self.assertEqual(collision_groups_for_paths(bundle, ["factory/state.py"]), ("dark-factory-runtime",))

    def test_unknown_profiles_and_repository_fail_closed(self):
        with self.assertRaises(UnknownProfileError):
            resolve_profiles("mhoo-os/unknown", "python-tests-v1", "python-tests-v1")
        with self.assertRaises(UnknownProfileError):
            resolve_profiles("mhoo-os/dark-factory", "unknown-v1", "python-tests-v1")

    def test_collision_comparison_is_deterministic_and_unknown_is_fenced(self):
        bundle = resolve_profiles("mhoo-os/dark-factory", "python-tests-v1", "python-tests-v1")
        self.assertEqual(collision_groups_for_paths(bundle, ["new/unknown.file"]), ("unclassified",))
        self.assertTrue(collision_groups_conflict(("unclassified",), ("unclassified",)))
        self.assertFalse(collision_groups_conflict(("dark-factory-runtime",), ("dark-factory-reference",)))


if __name__ == "__main__":
    unittest.main()
