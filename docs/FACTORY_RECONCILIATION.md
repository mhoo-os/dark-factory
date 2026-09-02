# Linear/GitHub reconciliation v1

`factory/reconciliation.py` turns one observed Linear/GitHub snapshot into deterministic
write intents. It verifies the project/issue, repository, branch, PR, base, and head
identities before changing execution state. Merges and unmerged closes follow explicit
state transitions; reopens of terminal PRs stop for a human. Base/planning drift becomes
`needs-replan`, while a changed validated head becomes `reconciliation-only` rather
than a false pass.

The Linear write is one stable, marker-owned execution-receipt upsert per run. A GitHub
PR binding is also keyed by run. Applying the same intent digest is a no-op; a changed
state updates the same receipt key. No intent edits the Linear project, PRD, or planning
description. A real D1/Queue consumer must persist applied intent digests and apply
these intents idempotently.
