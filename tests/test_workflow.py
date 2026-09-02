from __future__ import annotations

import json
from pathlib import Path
import unittest

from factory.dispatch_contract import validate_dispatch_contract
from factory.ground import RepositorySnapshot
from factory.workflow import (
    ImplementationResult, LeaseReceipt, PRReceipt, ReviewResult, StepRecord,
    ValidationResult, WorkflowCrash, WorkflowFailure, WorkflowRequest, DurableWorkflow,
)

ROOT = Path(__file__).parents[1]
GROUND = json.loads((ROOT / "tests/fixtures/ground_cases.json").read_text())
CASES = json.loads((ROOT / "tests/fixtures/workflow_cases.json").read_text())
CONTRACT = validate_dispatch_contract(GROUND["contract"]).contract
assert CONTRACT is not None
SNAPSHOT = RepositorySnapshot(**GROUND["snapshot"])
BASE = SNAPSHOT.base_sha
HEAD = "f" * 40


class MemoryStore:
    def __init__(self, crash_key=None):
        self.records = {}
        self.events = []
        self.crash_key, self.crashed = crash_key, False

    def get_step(self, run_id, key):
        return self.records.get((run_id, key))

    def begin_step(self, run_id, key):
        record = self.records.setdefault((run_id, key), StepRecord(run_id, key, "started"))
        return record

    def complete_step(self, run_id, key, result):
        if key == self.crash_key and not self.crashed:
            self.crashed = True
            raise WorkflowCrash("simulated durable write loss")
        record = StepRecord(run_id, key, "completed", result)
        self.records[(run_id, key)] = record
        return record

    def record_event(self, run_id, key, event_type, details):
        self.events.append((run_id, key, event_type, details))

    def list_steps(self, run_id):
        return tuple(record for (item, _), record in self.records.items() if item == run_id)


class Backend:
    def __init__(self, validation=None, protected=False, judgement=False, cost=1.0, release_fail=False):
        self.validation = validation or CASES["green"]["validation"]
        self.protected, self.judgement, self.cost, self.release_fail = protected, judgement, cost, release_fail
        self.effects, self.side_effects = {}, []
        self.validator_saw_builder_reasoning = False

    def effect(self, key, value):
        if key not in self.effects:
            self.effects[key] = value
            self.side_effects.append(key)
        return self.effects[key]

    def acquire_lease(self, request, idempotency_key):
        return self.effect(idempotency_key, LeaseReceipt("worker-1", 1))

    def implement(self, request, grounding, findings, attempt, idempotency_key):
        result = ImplementationResult("passed", BASE, HEAD, "sha256:" + "b" * 64, ("tests/fixture.py",), "", ("sha256:" + "c" * 64,), self.cost)
        return self.effect(idempotency_key, result)

    def validate(self, request, input, attempt, idempotency_key):
        self.validator_saw_builder_reasoning = hasattr(input, "builder_reasoning")
        outcome = self.validation[min(attempt, len(self.validation) - 1)]
        result = ValidationResult(outcome, ("repair this fixture",) if outcome == "fixable" else (), self.protected, False)
        return self.effect(idempotency_key, result)

    def review(self, request, implementation, validation, idempotency_key):
        result = ReviewResult("ready", False, self.judgement, "review needs a human" if self.judgement else "")
        return self.effect(idempotency_key, result)

    def publish_pr(self, request, implementation, idempotency_key):
        return self.effect(idempotency_key, PRReceipt(1, "https://github.com/mhoo-os/dark-factory/pull/1", HEAD, idempotency_key))

    def release_lease(self, request, lease, idempotency_key):
        if self.release_fail:
            self.release_fail = False
            raise WorkflowFailure("lease_release_failed")
        self.effect(idempotency_key, None)


def make_request(**kwargs):
    return WorkflowRequest(CONTRACT, "run-900", SNAPSHOT, **kwargs)


class WorkflowTests(unittest.TestCase):
    def test_green_fixture_reaches_one_idempotent_pr(self):
        store, backend = MemoryStore(), Backend()
        first = DurableWorkflow(store, backend).run(make_request())
        second = DurableWorkflow(store, backend).run(make_request())
        self.assertEqual((first.state, first.pr.number, first.attempt), ("pr-open", 1, 0))
        self.assertEqual(first.to_dict(), second.to_dict())
        self.assertEqual(len([key for key in backend.side_effects if "publish-pr" in key]), 1)
        self.assertFalse(backend.validator_saw_builder_reasoning)

    def test_red_fixture_has_one_bounded_fix_and_revalidation(self):
        store, backend = MemoryStore(), Backend(CASES["red"]["validation"])
        result = DurableWorkflow(store, backend).run(make_request(max_fix_attempts=1))
        keys = [record.key for record in store.list_steps("run-900")]
        self.assertEqual((result.state, result.attempt), ("pr-open", 1))
        self.assertIn("fix:1", keys)
        self.assertIn("validate:1", keys)
        self.assertEqual(len([key for key in backend.side_effects if "publish-pr" in key]), 1)

    def test_protected_and_judgement_values_stop_before_pr(self):
        for backend in (Backend(protected=True), Backend(judgement=True)):
            result = DurableWorkflow(MemoryStore(), backend).run(make_request())
            self.assertEqual(result.state, "needs-human")
            self.assertFalse(any("publish-pr" in key for key in backend.side_effects))

    def test_cost_cap_is_code_enforced(self):
        result = DurableWorkflow(MemoryStore(), Backend(cost=9.0)).run(make_request(max_cost_usd=8.0))
        self.assertEqual(result.reason, "cost_cap_exceeded")

    def test_stop_is_fail_closed_before_lease(self):
        backend = Backend()
        stopped = DurableWorkflow(MemoryStore(), backend).run(make_request(stop_requested=True))
        unreadable = DurableWorkflow(MemoryStore(), backend).run(make_request(stop_readable=False))
        self.assertEqual((stopped.state, unreadable.state), ("stopped", "stopped"))
        self.assertFalse(backend.side_effects)

    def test_failed_lease_release_remains_retryable(self):
        store, backend = MemoryStore(), Backend(release_fail=True)
        first = DurableWorkflow(store, backend).run(make_request())
        second = DurableWorkflow(store, backend).run(make_request())
        self.assertEqual(first.reason, "lease_release_failed")
        self.assertEqual(second.state, "pr-open")

    def test_retry_after_each_durable_step_reuses_effect_identity(self):
        keys = ("lease:acquire", "ground", "implement:0", "validate:0", "review:0", "publish-pr:0", "lease:release", "workflow:final")
        for crash_key in keys:
            with self.subTest(crash_key=crash_key):
                store, backend = MemoryStore(crash_key), Backend()
                with self.assertRaises(WorkflowCrash):
                    DurableWorkflow(store, backend).run(make_request())
                result = DurableWorkflow(store, backend).run(make_request())
                self.assertEqual(result.state, "pr-open")
                self.assertEqual(len(backend.side_effects), len(set(backend.side_effects)))


if __name__ == "__main__":
    unittest.main()
