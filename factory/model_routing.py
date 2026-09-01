"""Provider-neutral, static model routing and escalation contract."""
from __future__ import annotations
import hashlib
import json
import math
import re
from dataclasses import dataclass
from typing import Any, Mapping
DIGEST = re.compile(r"^sha256:[0-9a-f]{64}$")
SHA = re.compile(r"^[0-9a-f]{40}$", re.I)
ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,191}$")
NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}$")
REPOSITORY = re.compile(r"^mhoo-os/[a-z0-9][a-z0-9._-]{0,99}$")
RUN_ID = re.compile(r"^run-v1-[0-9a-f]{32}$")
RISKS = frozenset({"low", "medium", "high"})
AUTHORITIES = frozenset({"repository-local", "cross-system"})
ADMISSIONS = frozenset({"admitted", "not-admitted", "needs-replan"})
EVENT_NAME = re.compile(r"^[a-z][a-z0-9._-]{0,63}$")
OUTCOMES = frozenset({"ROUTED", "NEEDS_HUMAN"})
class RoutingValidationError(ValueError):
    def __init__(self, errors: list[str] | tuple[str, ...]):
        self.errors = tuple(errors)
        super().__init__(";".join(self.errors) or "routing_invalid")
def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
def _digest(value: Any) -> str:
    return "sha256:" + hashlib.sha256(_json(value).encode()).hexdigest()
def _mapping(value: Any, path: str, keys: set[str], errors: list[str]) -> dict[str, Any] | None:
    if not isinstance(value, dict):
        errors.append(f"{path}.type")
        return None
    errors.extend(f"{path}.missing:{key}" for key in sorted(keys - value.keys()))
    errors.extend(f"{path}.unexpected:{key}" for key in sorted(value.keys() - keys))
    return value
def _text(value: Any, path: str, pattern: re.Pattern[str], errors: list[str], *, nullable: bool = False, length: int = 256) -> None:
    if nullable and value is None:
        return
    if not isinstance(value, str) or not value or len(value) > length or "\n" in value or "\r" in value or pattern.fullmatch(value) is None:
        errors.append(f"{path}.invalid")
def _dig(value: Any, path: str, errors: list[str]) -> None:
    _text(value, path, DIGEST, errors, length=71)
def _list(value: Any, path: str, errors: list[str], maximum: int) -> list[Any]:
    if not isinstance(value, list) or len(value) > maximum:
        errors.append(f"{path}.list")
        return []
    return value
def _number(value: Any, path: str, errors: list[str]) -> None:
    if not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(value) or value < 0:
        errors.append(f"{path}.nonnegative_number")
def _int(value: Any, path: str, errors: list[str], maximum: int) -> None:
    if not isinstance(value, int) or isinstance(value, bool) or value < 0 or value > maximum:
        errors.append(f"{path}.nonnegative_integer")
class _Sealed:
    def __init__(self, *_args: Any, **_kwargs: Any) -> None:
        raise TypeError("use the validated routing factory")
    def __reduce__(self) -> Any:
        raise TypeError("routing proof values are not pickleable")
def _seal(cls: type[Any], **values: Any) -> Any:
    value = object.__new__(cls)
    for name, item in values.items():
        object.__setattr__(value, name, item)
    return value
@dataclass(frozen=True)
class ModelSpec:
    id: str
    provider: str
    model: str
    version: str
    reasoning_effort: str
    max_cost_usd: float
    def to_dict(self) -> dict[str, Any]:
        return {"id": self.id, "provider": self.provider, "model": self.model, "version": self.version, "reasoning_effort": self.reasoning_effort, "max_cost_usd": self.max_cost_usd}
@dataclass(frozen=True, init=False)
class RoutingPolicy(_Sealed):
    version: str
    models: tuple[ModelSpec, ...]
    routes: tuple[tuple[str, str, str, str, str], ...]
    fallbacks: tuple[tuple[str, str], ...]
    escalations: tuple[tuple[str, str], ...]
    human_only_work_types: tuple[str, ...]
    human_only_authority_classes: tuple[str, ...]
    cost_ceiling_usd: float
    max_escalations: int
    adaptive_routing: bool
    @property
    def digest(self) -> str:
        return _digest(self.to_dict())
    @property
    def model_map(self) -> dict[str, ModelSpec]:
        return {model.id: model for model in self.models}
    @property
    def route_map(self) -> dict[tuple[str, str, str, str], str]:
        return {(profile, work, risk, authority): model for profile, work, risk, authority, model in self.routes}
    def to_dict(self) -> dict[str, Any]:
        return {"version": self.version, "models": [model.to_dict() for model in self.models], "routes": [{"execution_profile": profile, "work_type": work, "risk_class": risk, "authority_class": authority, "model_id": model} for profile, work, risk, authority, model in self.routes], "fallbacks": dict(self.fallbacks), "escalations": dict(self.escalations), "human_only_work_types": list(self.human_only_work_types), "human_only_authority_classes": list(self.human_only_authority_classes), "cost_ceiling_usd": self.cost_ceiling_usd, "max_escalations": self.max_escalations, "adaptive_routing": self.adaptive_routing}
@dataclass(frozen=True, init=False)
class RouteRequest(_Sealed):
    run_id: str
    dispatch_id: str
    contract_digest: str
    repository: str
    base_sha: str
    execution_profile: str
    validation_profile: str
    work_type: str
    risk_class: str
    authority_class: str
    admission_outcome: str
    fallback_reason: str | None
    escalation_trigger: str | None
    escalation_count: int
    def to_dict(self) -> dict[str, Any]:
        return {"run_id": self.run_id, "dispatch_id": self.dispatch_id, "contract_digest": self.contract_digest, "repository": self.repository, "base_sha": self.base_sha, "execution_profile": self.execution_profile, "validation_profile": self.validation_profile, "work_type": self.work_type, "risk_class": self.risk_class, "authority_class": self.authority_class, "admission_outcome": self.admission_outcome, "fallback_reason": self.fallback_reason, "escalation_trigger": self.escalation_trigger, "escalation_count": self.escalation_count}
@dataclass(frozen=True, init=False)
class RouteDecision(_Sealed):
    outcome: str
    reason: str
    route_kind: str
    run_id: str
    request_digest: str
    policy_digest: str
    model: ModelSpec | None
    escalation_count: int
    authority_preserved: bool
    decision_digest: str
    def to_dict(self) -> dict[str, Any]:
        return {"outcome": self.outcome, "reason": self.reason, "route_kind": self.route_kind, "run_id": self.run_id, "request_digest": self.request_digest, "policy_digest": self.policy_digest, "model": self.model.to_dict() if self.model else None, "escalation_count": self.escalation_count, "authority_preserved": self.authority_preserved, "decision_digest": self.decision_digest}
def make_routing_policy(value: Mapping[str, Any]) -> RoutingPolicy:
    errors: list[str] = []
    root = _mapping(value, "policy", {"version", "models", "routes", "fallbacks", "escalations", "human_only_work_types", "human_only_authority_classes", "cost_ceiling_usd", "max_escalations", "adaptive_routing"}, errors)
    if root is None:
        raise RoutingValidationError(errors)
    if root.get("version") != "v1":
        errors.append("policy.version.unsupported")
    models: list[ModelSpec] = []
    model_ids: set[str] = set()
    for index, item in enumerate(_list(root.get("models"), "policy.models", errors, 32)):
        model = _mapping(item, f"policy.models[{index}]", {"id", "provider", "model", "version", "reasoning_effort", "max_cost_usd"}, errors)
        if model is None:
            continue
        for field in ("id", "provider", "model", "version", "reasoning_effort"):
            _text(model.get(field), f"policy.models[{index}].{field}", NAME, errors)
        _number(model.get("max_cost_usd"), f"policy.models[{index}].max_cost_usd", errors)
        if isinstance(model.get("id"), str):
            if model["id"] in model_ids:
                errors.append("policy.models.duplicate")
            model_ids.add(model["id"])
            models.append(ModelSpec(model["id"], model.get("provider", ""), model.get("model", ""), model.get("version", ""), model.get("reasoning_effort", ""), float(model.get("max_cost_usd", 0))))
    routes: list[tuple[str, str, str, str, str]] = []
    for index, item in enumerate(_list(root.get("routes"), "policy.routes", errors, 128)):
        route = _mapping(item, f"policy.routes[{index}]", {"execution_profile", "work_type", "risk_class", "authority_class", "model_id"}, errors)
        if route is None:
            continue
        for field in ("execution_profile", "work_type", "model_id"):
            _text(route.get(field), f"policy.routes[{index}].{field}", NAME, errors)
        if route.get("risk_class") not in RISKS:
            errors.append(f"policy.routes[{index}].risk_class.invalid")
        if route.get("authority_class") not in AUTHORITIES:
            errors.append(f"policy.routes[{index}].authority_class.invalid")
        key = (str(route.get("execution_profile")), str(route.get("work_type")), str(route.get("risk_class")), str(route.get("authority_class")), str(route.get("model_id")))
        if key in routes:
            errors.append("policy.routes.duplicate")
        routes.append(key)
    def targets(name: str) -> tuple[tuple[str, str], ...]:
        value_map = root.get(name)
        if not isinstance(value_map, dict):
            errors.append(f"policy.{name}.mapping")
            return ()
        result: list[tuple[str, str]] = []
        for trigger, model_id in value_map.items():
            _text(trigger, f"policy.{name}.trigger", EVENT_NAME, errors)
            _text(model_id, f"policy.{name}.{trigger}", NAME, errors)
            if isinstance(trigger, str) and isinstance(model_id, str):
                result.append((trigger, model_id))
        if len({trigger for trigger, _ in result}) != len(result):
            errors.append(f"policy.{name}.duplicate")
        return tuple(sorted(result))
    fallbacks, escalations = targets("fallbacks"), targets("escalations")
    def names(field: str) -> tuple[str, ...]:
        output: list[str] = []
        for index, item in enumerate(_list(root.get(field), f"policy.{field}", errors, 32)):
            _text(item, f"policy.{field}[{index}]", NAME, errors)
            if isinstance(item, str):
                output.append(item)
        if len(set(output)) != len(output):
            errors.append(f"policy.{field}.duplicate")
        return tuple(sorted(output))
    work_types, authority_classes = names("human_only_work_types"), names("human_only_authority_classes")
    _number(root.get("cost_ceiling_usd"), "policy.cost_ceiling_usd", errors)
    _int(root.get("max_escalations"), "policy.max_escalations", errors, 2)
    if root.get("adaptive_routing") is not False:
        errors.append("policy.adaptive_routing.must_be_false")
    if errors:
        raise RoutingValidationError(errors)
    if not models:
        errors.append("policy.models.empty")
    if any(model_id not in model_ids for *_, model_id in routes):
        errors.append("policy.routes.unknown_model")
    if any(model_id not in model_ids for _, model_id in (*fallbacks, *escalations)):
        errors.append("policy.event_unknown_model")
    if root["cost_ceiling_usd"] <= 0:
        errors.append("policy.cost_ceiling_usd.must_be_positive")
    if errors:
        raise RoutingValidationError(errors)
    return _seal(RoutingPolicy, version="v1", models=tuple(sorted(models, key=lambda model: model.id)), routes=tuple(sorted(routes)), fallbacks=fallbacks, escalations=escalations, human_only_work_types=work_types, human_only_authority_classes=authority_classes, cost_ceiling_usd=float(root["cost_ceiling_usd"]), max_escalations=root["max_escalations"], adaptive_routing=False)
def make_route_request(value: Mapping[str, Any]) -> RouteRequest:
    errors: list[str] = []
    root = _mapping(value, "request", {"run_id", "dispatch_id", "contract_digest", "repository", "base_sha", "execution_profile", "validation_profile", "work_type", "risk_class", "authority_class", "admission_outcome", "fallback_reason", "escalation_trigger", "escalation_count"}, errors)
    if root is None:
        raise RoutingValidationError(errors)
    _text(root.get("run_id"), "request.run_id", RUN_ID, errors, length=40)
    _text(root.get("dispatch_id"), "request.dispatch_id", ID, errors)
    _dig(root.get("contract_digest"), "request.contract_digest", errors)
    _text(root.get("repository"), "request.repository", REPOSITORY, errors)
    _text(root.get("base_sha"), "request.base_sha", SHA, errors, length=40)
    for field in ("execution_profile", "validation_profile", "work_type"):
        _text(root.get(field), f"request.{field}", NAME, errors)
    if root.get("risk_class") not in RISKS:
        errors.append("request.risk_class.invalid")
    if root.get("authority_class") not in AUTHORITIES:
        errors.append("request.authority_class.invalid")
    if root.get("admission_outcome") not in ADMISSIONS:
        errors.append("request.admission_outcome.invalid")
    for field in ("fallback_reason", "escalation_trigger"):
        _text(root.get(field), f"request.{field}", EVENT_NAME, errors, nullable=True)
    _int(root.get("escalation_count"), "request.escalation_count", errors, 2)
    if root.get("fallback_reason") is not None and root.get("escalation_trigger") is not None:
        errors.append("request.routing_events.ambiguous")
    if errors:
        raise RoutingValidationError(errors)
    return _seal(RouteRequest, **root)
def _decision(request: RouteRequest, policy: RoutingPolicy, input_digest: str, outcome: str, reason: str, kind: str, model: ModelSpec | None) -> RouteDecision:
    payload = {"request_digest": input_digest, "policy_digest": policy.digest, "outcome": outcome, "reason": reason, "route_kind": kind, "model": model.to_dict() if model else None, "escalation_count": request.escalation_count}
    return _seal(RouteDecision, outcome=outcome, reason=reason, route_kind=kind, run_id=request.run_id, request_digest=input_digest, policy_digest=policy.digest, model=model, escalation_count=request.escalation_count, authority_preserved=True, decision_digest=_digest(payload))
def select_route(request: RouteRequest, policy: RoutingPolicy) -> RouteDecision:
    """Select only a declared model; never infer authority or self-escalate."""
    if not isinstance(request, RouteRequest) or not isinstance(policy, RoutingPolicy):
        raise TypeError("select_route requires validated request and policy")
    input_digest = _digest({"request": request.to_dict(), "policy_digest": policy.digest})
    if request.admission_outcome != "admitted":
        return _decision(request, policy, input_digest, "NEEDS_HUMAN", "admission_not_confirmed", "none", None)
    if request.authority_class in policy.human_only_authority_classes or request.work_type in policy.human_only_work_types:
        return _decision(request, policy, input_digest, "NEEDS_HUMAN", "authority_reserved", "none", None)
    if request.escalation_count and request.escalation_trigger is None:
        return _decision(request, policy, input_digest, "NEEDS_HUMAN", "escalation_reason_missing", "none", None)
    if request.escalation_count > policy.max_escalations:
        return _decision(request, policy, input_digest, "NEEDS_HUMAN", "escalation_cap_reached", "none", None)
    kind, model_id = "initial", policy.route_map.get((request.execution_profile, request.work_type, request.risk_class, request.authority_class))
    if request.fallback_reason is not None:
        kind, model_id = "fallback", dict(policy.fallbacks).get(request.fallback_reason)
        if model_id is None:
            return _decision(request, policy, input_digest, "NEEDS_HUMAN", "fallback_not_declared", "fallback", None)
    elif request.escalation_trigger is not None:
        kind, model_id = "escalation", dict(policy.escalations).get(request.escalation_trigger)
        if model_id is None:
            return _decision(request, policy, input_digest, "NEEDS_HUMAN", "escalation_not_declared", "escalation", None)
        if request.escalation_count >= policy.max_escalations:
            return _decision(request, policy, input_digest, "NEEDS_HUMAN", "escalation_cap_reached", "escalation", None)
    if model_id is None:
        return _decision(request, policy, input_digest, "NEEDS_HUMAN", "route_not_declared", kind, None)
    model = policy.model_map[model_id]
    if model.max_cost_usd > policy.cost_ceiling_usd:
        return _decision(request, policy, input_digest, "NEEDS_HUMAN", "cost_cap_exceeded", kind, None)
    return _decision(request, policy, input_digest, "ROUTED", "route_selected", kind, model)
