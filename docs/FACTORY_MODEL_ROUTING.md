# Factory model routing
`factory/model_routing.py` is a static, provider-swappable route table.
Admission, authority class, cost ceiling, and escalation caps are checked before
any model is selected. Provider outage and named escalation triggers are explicit;
unknown routes stop for a human. Adaptive routing is rejected, and each decision
records exact request, policy, provider, model, version, reasoning, and output
digests. Routing preserves authority and does not dispatch, validate, merge, or
change factory state.
