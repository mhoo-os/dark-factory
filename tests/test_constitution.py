from __future__ import annotations

from pathlib import Path
import re
import unittest


ROOT = Path(__file__).parents[1]
GOVERNANCE = ("MISSION.md", "FACTORY.md", "FACTORY_RULES.md", "CLAUDE.md")
PLACEHOLDER = re.compile(r"<[^>\n]*>")


class ConstitutionTests(unittest.TestCase):
    def test_operational_governance_has_no_template_placeholders(self) -> None:
        for name in GOVERNANCE:
            with self.subTest(name=name):
                self.assertIsNone(PLACEHOLDER.search((ROOT / name).read_text()))

    def test_constitution_keeps_planning_and_authority_outside_the_factory(self) -> None:
        mission = (ROOT / "MISSION.md").read_text()
        rules = (ROOT / "FACTORY_RULES.md").read_text()
        self.assertIn("Linear remains the planning and operational queue", mission)
        self.assertIn("the factory never guesses", mission)
        self.assertIn("reconciliation", rules.lower())
        self.assertNotIn("re-plan every admitted issue", mission.lower())

    def test_autonomy_defaults_to_disabled(self) -> None:
        factory = (ROOT / "FACTORY.md").read_text()
        config = (ROOT / "factory/config.sh").read_text()
        self.assertIn("Current autonomy level: 0", factory)
        self.assertIn('FACTORY_AUTONOMY="${FACTORY_AUTONOMY:-0}"', config)
        self.assertNotIn('FACTORY_AUTONOMY="${FACTORY_AUTONOMY:-4}"', config)


if __name__ == "__main__":
    unittest.main()
