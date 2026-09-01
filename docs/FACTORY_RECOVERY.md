# Factory recovery and reconciliation contract v1

`factory/recovery.py` is a pure reconciliation planner. It inspects durable
run/lease/workflow snapshots and returns stable actions; it does not invent a
dispatch and a healthy snapshot returns no action. Cron can safely rerun the
planner because the later ledger transition and event identities remain
idempotent.

The planner detects missing workflows, expired or ownerless leases, missed
webhooks, newly completed dependencies, external PR state changes, stop
requests, and retry exhaustion. Retryable failures are requeued below the cap;
terminal or unknown failures become actionable `needs-human`/dead-letter
actions. Notifications are only marked for those actionable states or system
faults.

Dead-letter replay carries the original dispatch and event identities and is
deduplicated by the ledger. Stop-state reads fail closed when the remote state
cannot be read. Queued work is parked/stopped, while in-flight loss is surfaced
for human recovery. This is source-level proof; live Cron, Workflow, Queue,
and D1 reconciliation remain deployment/runtime gates.
