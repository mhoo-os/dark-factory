from __future__ import annotations

import json
from pathlib import Path
import sqlite3
import unittest

from factory.ledger import Ledger
from factory.leases import LeaseCoordinator, LeaseDenied, LeaseFenced, lease_keys
from factory.scheduler import SchedulableRun, acquire_run_lease, choose_eligible


ROOT = Path(__file__).parents[1]


def runs() -> list[SchedulableRun]:
    raw = json.loads((ROOT / "tests/fixtures/scheduler_cases.json").read_text())
    return [SchedulableRun(**item) for item in raw["runs"]]


class SchedulerTests(unittest.TestCase):
    def test_order_and_blocking_are_deterministic(self):
        first = choose_eligible(runs(), global_limit=2)
        second = choose_eligible(list(reversed(runs())), global_limit=2)
        self.assertEqual([run.dispatch_id for run in first.eligible], ["run-a", "run-d"])
        self.assertEqual(first.eligible, second.eligible)
        self.assertEqual(first.blocked["run-b"], "dependency_not_completed")

    def test_in_flight_run_does_not_inert_unrelated_capacity(self):
        result = choose_eligible(runs(), active_repositories={"mhoo-os/dark-factory": 1}, active_global=1, global_limit=2)
        self.assertEqual([run.dispatch_id for run in result.eligible], ["run-d"])

    def test_risk_and_auto_merge_policy_require_their_own_authority(self):
        risky = SchedulableRun("run-risk", "MHO-50", "mhoo-os/other", ("risk",), 1, "admitted", {}, risk_class="high")
        automatic = SchedulableRun("run-auto", "MHO-51", "mhoo-os/other", ("auto",), 2, "admitted", {}, merge_policy="auto-eligible")
        result = choose_eligible([risky, automatic], global_limit=3)
        self.assertEqual(result.eligible, ())
        self.assertEqual(result.blocked["run-risk"], "human_authorization_required")
        self.assertEqual(result.blocked["run-auto"], "merge_policy_not_human_reviewed")

    def test_lease_acquisition_is_serialized_and_fenced_after_expiry(self):
        connection = sqlite3.connect(":memory:")
        Ledger(connection)
        coordinator = LeaseCoordinator(connection)
        keys = lease_keys("mhoo-os/dark-factory", ("runtime",))
        first = coordinator.acquire(keys, owner="worker-1", dispatch_id="run-1", now=100, ttl_seconds=10)
        with self.assertRaises(LeaseDenied):
            coordinator.acquire(keys, owner="worker-2", dispatch_id="run-2", now=101, ttl_seconds=10)
        second = coordinator.acquire(keys, owner="worker-2", dispatch_id="run-2", now=111, ttl_seconds=10)
        with self.assertRaises(LeaseFenced):
            coordinator.assert_current(first, now=111)
        coordinator.assert_current(second, now=111)
        coordinator.release(second, now=112)
        connection.close()

    def test_scheduler_lease_helper_uses_repository_and_collision_keys(self):
        connection = sqlite3.connect(":memory:")
        Ledger(connection)
        coordinator = LeaseCoordinator(connection)
        run = runs()[0]
        grant = acquire_run_lease(coordinator, run, owner="worker-1", now=100, ttl_seconds=10)
        self.assertEqual(set(grant.fences), {"repository:mhoo-os/dark-factory", "collision:runtime"})
        connection.close()


if __name__ == "__main__":
    unittest.main()
