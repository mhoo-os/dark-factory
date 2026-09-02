# Factory state and authority contract v1

[`factory/state_contract.json`](../factory/state_contract.json) is the single
machine-readable transition table. [`factory/state_contract.py`](../factory/state_contract.py)
loads that table and performs a pure authorization decision; it does not mutate
the ledger.

The run lifecycle is explicit: proposal and admission, dependency blocking,
lease and execution, validation, PR lifecycle, and reconciliation. `needs-replan`
means the approved contract is stale or materially drifted. `failed` means an
admitted execution or validation reached terminal failure. They are not synonyms.

Every transition carries an actor. Agents cannot leave `needs-human`, `stopped`,
or terminal states. Human override is the only recovery authority for reserved
states. Linear and GitHub changes first enter `reconciliation-only` when the
external event needs deterministic reconciliation rather than direct trust.

Event IDs are deduplicated and event sequences must increase strictly. Replayed,
stale, unknown, illegal, or unauthorized events are rejected without mutation.

Autonomy is separate from issue state. The shipped default is level 0, and only a
human override can promote it after the evidence-backed ratchet is satisfied.
