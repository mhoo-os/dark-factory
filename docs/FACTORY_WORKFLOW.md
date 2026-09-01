# Durable per-issue Workflow v1

`factory/workflow.py` defines the fixed execution sequence after admission: acquire a
lease, ground the contract, implement in the sandbox, independently validate, review,
publish one PR, and release the lease. Every step has a stable `run_id:key` identity.
The store records the step before the side effect and retries an incomplete step with
the same provider idempotency key, so a crash after an external write cannot create a
second effect.

The validator receives only digest-bound implementation facts, never builder reasoning.
Protected-path and judgement-value flags always stop before PR publication. Fixes are
bounded, costs are capped, no merge operation exists, and stop/unreadable-stop states
park the run before lease acquisition. A real Worker must implement `WorkflowStore` on
D1/R2 and `WorkflowBackend` over the reviewed Sandbox, validation, GitHub, and lease
adapters; this PR proves the contract offline.
