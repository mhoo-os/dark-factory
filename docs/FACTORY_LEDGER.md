# Factory execution ledger v1

[`factory/ledger_schema.sql`](../factory/ledger_schema.sql) is the D1-compatible
schema. [`factory/ledger.py`](../factory/ledger.py) provides the reference
implementation against Python's SQLite library, whose transaction and SQL
types match the Worker-side D1 contract.

The ledger has one durable run row per dispatch identity, append-only event and
transition history, and append-only evidence references. The run row stores the
normalized contract identity, planning snapshot, repository/profile/collision
binding, state, attempt and lease fields, PR binding, model/rules digests,
cost/latency summary, escalation, and reconciliation timestamps. It stores no
credential material or raw provider payloads.

Admission is idempotent: the same dispatch and digest returns the original run,
while a changed digest or a second active run for the same Linear issue raises a
conflict. State writes use the v1 state/authority table, event identity, and
strictly increasing sequence. Replayed events do not mutate the run; stale or
illegal events receive a durable rejection receipt without changing current
state. Accepted transitions are the only writes to the current-state snapshot.

Evidence must be explicitly marked redacted and is represented by a digest and
artifact reference rather than embedded content. Schema version 1 is recorded
in `factory_schema_meta`; future migrations must add a versioned migration
before changing the live D1 schema.

This is source-level ledger proof. The live Cloudflare D1 binding remains a
separate deployment and runtime evidence layer.
