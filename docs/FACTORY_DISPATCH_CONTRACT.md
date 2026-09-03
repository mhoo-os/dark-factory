# Factory Dispatch Contract v1

The factory executes only a normalized contract produced from an already-planned
Linear issue. It never fills missing fields by guessing.

The machine-readable schema is [`factory/dispatch_contract.schema.json`](../factory/dispatch_contract.schema.json), and the pure validator is [`factory/dispatch_contract.py`](../factory/dispatch_contract.py).

Required issue-authored data binds one Linear issue and planning revision to one `mhoo-os/<repository>`, base commit, execution/validation profiles, dependency list, risk and authority class, acceptance criteria, allowed scope, merge policy, and explicit stale conditions. Admission then materializes the trusted `factory_id`, registry version, entry version, and registry digest into the normalized contract. `dispatch_id` is the idempotency identity; the canonical JSON digest binds both the requested contents and resolved registry authority.

The `linear.issue_id` field is the immutable provider identity for the Linear issue, while `linear.identifier` is its human-readable key (for example, `MHO-199`). Admission must verify that both values refer to the same issue; neither value is accepted as a substitute for the other.

Validation has three outcomes:

- `admitted`: the contract is complete and current.
- `not-admitted`: the shape, profile, duplicate identity, or declared value is invalid.
- `needs-replan`: the contract was valid, but its Linear revision, planning fingerprint, or base commit is no longer current.

`execution_failed` is deliberately not a contract outcome. It is a later runtime result after an admitted contract has entered execution.

Admission may supply the current revision/base and the supported profile registry to `validate_dispatch_contract`; it must persist the returned digest and outcome without reinterpreting prose.

An optional `factory_request` may request a credential profile, concurrency class,
model-policy key, escalation class, and explicit effect classes. Missing values normalize to the least
privileged v1 defaults. `factory_id` and `registry` are never accepted from issue
content; they come only from `factory/factory_registry.json`.
## Linear admission envelope

The Linear description must contain exactly one explicit envelope:

```text
<!-- mhoo-factory-dispatch:v1 -->
{complete v1 contract JSON}
<!-- /mhoo-factory-dispatch:v1 -->
```

`factory/admission.py` checks the exact configured Linear project, issue ID, and
identifier before calling the contract validator. The repository, profiles,
collision group, dependencies, authority, acceptance, scope, merge policy, base
revision, and planning fingerprint all come from the envelope. Missing,
duplicated, malformed, or mismatched fields are refused; no description prose
can fill a field.

The admission decision is pure and has no model or provider-write path. It
returns `admitted`, `not-admitted`, `needs-replan`, or `needs-human`. A stable
dispatch identity is bound to `IDENTIFIER@PLANNING_REVISION`; the canonical
contract digest is the identity of the exact admitted contents. Existing ledger
identities and replayed event IDs must be supplied by the caller before any
queue handoff.
