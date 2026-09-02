# Factory Dispatch Contract v1

The factory executes only a normalized contract produced from an already-planned
Linear issue. It never fills missing fields by guessing.

The machine-readable schema is [`factory/dispatch_contract.schema.json`](../factory/dispatch_contract.schema.json), and the pure validator is [`factory/dispatch_contract.py`](../factory/dispatch_contract.py).

Required data binds one Linear issue and planning revision to one `mhoo-os/<repository>`, base commit, execution/validation profiles, dependency list, risk and authority class, acceptance criteria, allowed scope, merge policy, and explicit stale conditions. `dispatch_id` is the idempotency identity; the canonical JSON digest binds the exact contract contents.

Validation has three outcomes:

- `admitted`: the contract is complete and current.
- `not-admitted`: the shape, profile, duplicate identity, or declared value is invalid.
- `needs-replan`: the contract was valid, but its Linear revision, planning fingerprint, or base commit is no longer current.

`execution_failed` is deliberately not a contract outcome. It is a later runtime result after an admitted contract has entered execution.

Admission may supply the current revision/base and the supported profile registry to `validate_dispatch_contract`; it must persist the returned digest and outcome without reinterpreting prose.

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
