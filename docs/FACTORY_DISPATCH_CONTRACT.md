# Factory Dispatch Contract v1

The factory executes only a normalized contract produced from an already-planned
Linear issue. It never fills missing fields by guessing.

The machine-readable schema is [`factory/dispatch_contract.schema.json`](../factory/dispatch_contract.schema.json), and the pure validator is [`factory/dispatch_contract.py`](../factory/dispatch_contract.py).

Required data binds one Linear issue and planning revision to one `mhoo-os/<repository>`, base commit, execution/validation profiles, dependency list, risk and authority class, acceptance criteria, allowed scope, merge policy, and explicit stale conditions. `dispatch_id` is the idempotency identity; the canonical JSON digest binds the exact contract contents.

The `linear.issue_id` field is the immutable provider identity for the Linear issue, while `linear.identifier` is its human-readable key (for example, `MHO-199`). Admission must verify that both values refer to the same issue; neither value is accepted as a substitute for the other.

Linear may automatically serialize a bare issue key as its own Markdown or rich-text
`<issue …>` self-link when it stores a description. The validators canonicalize only
those exact forms back to the identifier in `linear.identifier`, `dispatch_id`, and a
temporary authorization ID before identity comparison and digesting. Other Markdown,
rich text, or URLs remain invalid contract identifiers.

Validation has three outcomes:

- `admitted`: the contract is complete and current.
- `not-admitted`: the shape, profile, duplicate identity, or declared value is invalid.
- `needs-replan`: the contract was valid, but its Linear revision, planning fingerprint, or base commit is no longer current.

`execution_failed` is deliberately not a contract outcome. It is a later runtime result after an admitted contract has entered execution.

Admission may supply the current revision/base and the supported profile registry to `validate_dispatch_contract`; it must persist the returned digest and outcome without reinterpreting prose.

## Temporary approved-intake dry run

A narrowly authorized Gate-3 verification may add exactly one optional
`dry_run_authorization` object. It is not a normal execution capability. The object
requires an authorization identity, `mode: "approved-intake"`,
`non_executable: true`, an RFC3339 UTC expiry no more than fifteen minutes ahead, and
the exact repository, PR number, Linear issue identifier, review ID, and clean checkout
head. It also requires an empty allowed scope (`paths: []`,
`max_files: 0`, `max_changed_lines: 0`), no dependencies, low repository-local risk,
and human merge policy.

The Python intake accepts this object only when explicitly called with `--dry-run` from
the exact clean checkout. Its only result is an `approved-intake-dry-run` receipt that
repeats the repository, PR, Linear issue, review ID, and checkout head with
`normal_dispatch: false` and `provider_mutations: false`; it does not create or update
Linear/GitHub resources. A replay before expiry is another no-mutation receipt; expiry,
head mismatch, missing mode, or any scope/constraint mismatch is not admitted.

The Worker parses the same shape but rejects it before ingress persistence, queue handoff,
run creation, or provider execution. The authorization is therefore usable only by the
local disabled-factory Gate-3 path and cannot become a Cloudflare dispatch capability.
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
