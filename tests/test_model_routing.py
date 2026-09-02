from __future__ import annotations
import copy
import json
from pathlib import Path
import unittest
from factory.model_routing import (RouteDecision, RouteRequest, RoutingPolicy, RoutingValidationError, make_route_request, make_routing_policy, select_route)
ROOT = Path(__file__).parents[1]
CASES = json.loads((ROOT / "tests/fixtures/model_routing_cases.json").read_text())
class ModelRoutingTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.policy = make_routing_policy(CASES["policy"])
    def request(self, **changes: object) -> RouteRequest:
        value = copy.deepcopy(CASES["request"])
        value.update(changes)
        return make_route_request(value)
    def test_static_route_is_deterministic_and_records_exact_model_identity(self) -> None:
        first, second = select_route(self.request(), self.policy), select_route(self.request(), self.policy)
        self.assertEqual(first.to_dict(), second.to_dict())
        self.assertEqual((first.outcome, first.route_kind, first.model.provider, first.model.model, first.model.version, first.model.reasoning_effort), ("ROUTED", "initial", "openrouter", "z-ai/glm-5.3-flash", "2026-08", "medium"))
        self.assertTrue(first.authority_preserved)
    def test_risk_maps_to_stronger_model_and_explicit_events_are_auditable(self) -> None:
        strong = select_route(self.request(risk_class="high"), self.policy)
        fallback = select_route(self.request(fallback_reason="provider_outage"), self.policy)
        escalation = select_route(self.request(escalation_trigger="validation_failed", escalation_count=0), self.policy)
        self.assertEqual((strong.model.id, fallback.route_kind, escalation.route_kind), ("strong-approved", "fallback", "escalation"))
        self.assertEqual((fallback.model.id, escalation.model.id), ("strong-approved", "strong-approved"))
        self.assertTrue(all(item for item in (strong.request_digest, strong.policy_digest, strong.decision_digest)))
    def test_admission_authority_and_escalation_caps_fail_closed(self) -> None:
        for changes, reason in ((("admission_outcome", "not-admitted"), "admission_not_confirmed"), (("authority_class", "cross-system"), "authority_reserved"), (("work_type", "security"), "authority_reserved"), (("escalation_trigger", "validation_failed"), "escalation_cap_reached")):
            result = select_route(self.request(**dict([changes])), self.policy) if changes != ("escalation_trigger", "validation_failed") else select_route(self.request(escalation_trigger="validation_failed", escalation_count=1), self.policy)
            self.assertEqual((result.outcome, result.reason, result.model), ("NEEDS_HUMAN", reason, None))
    def test_unknown_selector_or_event_never_infers_a_route(self) -> None:
        self.assertEqual(select_route(self.request(work_type="unknown"), self.policy).reason, "route_not_declared")
        self.assertEqual(select_route(self.request(fallback_reason="unknown"), self.policy).reason, "fallback_not_declared")
        self.assertEqual(select_route(self.request(escalation_trigger="unknown"), self.policy).reason, "escalation_not_declared")
    def test_adaptive_routing_and_cost_overrides_are_rejected(self) -> None:
        with self.assertRaises(RoutingValidationError):
            make_routing_policy({**CASES["policy"], "adaptive_routing": True})
        costly = copy.deepcopy(CASES["policy"])
        costly["cost_ceiling_usd"] = 1.0
        self.assertEqual(select_route(self.request(), make_routing_policy(costly)).reason, "cost_cap_exceeded")
    def test_round_trip_and_proof_types_are_sealed(self) -> None:
        rebuilt = make_routing_policy(self.policy.to_dict())
        self.assertEqual(rebuilt.digest, self.policy.digest)
        self.assertEqual(make_route_request(self.request().to_dict()).to_dict(), self.request().to_dict())
        with self.assertRaises(TypeError):
            RoutingPolicy()  # type: ignore[call-arg]
        with self.assertRaises(TypeError):
            RouteRequest()  # type: ignore[call-arg]
        with self.assertRaises(TypeError):
            RouteDecision()  # type: ignore[call-arg]
    def test_route_result_has_no_execution_authority_operation(self) -> None:
        encoded = json.dumps(select_route(self.request(), self.policy).to_dict())
        for forbidden in ("dispatch", "merge", "approve", "state_transition", "adaptive"):
            self.assertNotIn(forbidden, encoded)
if __name__ == "__main__":
    unittest.main()
