# Dark Factory threat model and isolation contract

This document is the security boundary for the Mhoo Dark Factory control plane.
It is a design and admission prerequisite; it does not enable the factory or
authorize a live pilot.

The companion authority/data-flow diagram is the editable Archify source at
[`diagrams/factory-threat-model.architecture.json`](diagrams/factory-threat-model.architecture.json).
It was delivered and visually checked at 1440x900 and 2048x1320 in light and
dark themes. The generated HTML is a derived presentation and is intentionally
not committed because this repository's review guard caps a change at 500
lines; it can be regenerated from the specification with Archify.

## Trust and authority

Linear is the planning authority. GitHub is the repository and pull-request
state authority. The Worker is the deterministic admission authority: it may
accept or reject a complete versioned dispatch contract, but it may not invent
the repository, profiles, acceptance criteria, risk class, merge policy, or
base revision. Models and evaluators are not authorities.

Provider payloads, issue descriptions, repository files, tool output, PR text,
logs, and evaluator findings are untrusted data. They are never instructions
to the control plane. Only typed contracts, verified signatures, current
leases, and the state transition table may cause a state change.

High-risk effects are contract-only and human-controlled: changing repository
protection, merging, deleting data or branches, changing credentials or
bindings, crossing repository scope, deploying production code, or raising the
autonomy level. No model prompt, issue body, evaluator result, or sandbox
command can authorize one of these effects.

## Threat controls

| Threat | Control | Required failure behavior |
|---|---|---|
| Prompt injection in a Linear issue, PR, or file | Parse only the declared dispatch fields; keep all prose as data; do not give provider text control-plane verbs | Reject missing or ambiguous protected fields; never reinterpret prose |
| Malicious repository content or tool output | Run only the selected profile in an isolated sandbox with an explicit tool and path allowlist | Stop the attempt, preserve a redacted receipt, and do not publish a PR |
| Cross-repository secret leakage | Bind the run to one exact repository and profile digest; scope credentials to that repository and attempt | Deny the access before execution; do not fall back to a broader token |
| Secret exfiltration in output or artifacts | Scan outbound logs, PR material, and R2 evidence; redact only known-safe evidence classes | Block publication and escalate; never place secrets in D1, R2, logs, or comments |
| Confused deputy through a provider event | Verify project, issue, repository, profile, state, signature, idempotency identity, and current planning revision | Enter reconciliation-only or reject; never dispatch from an unverified event |
| Forged or replayed webhook | Verify the provider signature, event identity, timestamp/sequence policy, and D1 deduplication record | Reject without mutation; a replay is not a new run |
| Stale or fenced write | Require the current lease owner and fence token plus a strictly increasing event sequence | Reject the write as stale; do not overwrite newer state |
| Profile escalation | Resolve the exact repository/profile tuple from the versioned registry and persist its digest | Reject unknown or mismatched profiles; do not infer a stronger profile |
| Evaluator content becoming authority | Store product, PR-trajectory, and conversation-trajectory findings as separate observer evidence | Evaluator output may inform a human, never authorize a transition or merge |
| Cloudflare environment or operator confusion | Keep environment bindings explicit; default the factory and autonomy to disabled; retain a reversible stop control | Fail closed when environment identity or operator intent is unclear |

## Credential custody matrix

| Capability | Owner and source | Injection boundary | Permitted use | Persistence and revocation |
|---|---|---|---|---|
| Linear event verification | Operator-managed Worker secret | Worker ingress only | Verify signed planning and state events | Secret store only; rotate without writing it to D1/R2 |
| GitHub event verification | Operator-managed Worker secret | Worker ingress only | Verify webhook authenticity and reconcile repository/PR state | Secret store only; revoke at GitHub and replace the binding |
| GitHub repository access | Operator-managed GitHub credential | Sandbox adapter, exact repository and attempt | Read the declared base and publish the bounded branch/PR when separately authorized | Ephemeral injection; never expose to the model, logs, artifacts, or other repositories |
| OpenRouter access | Operator-managed Worker secret | Workflow model-call boundary | Make the selected, budgeted model call for the admitted run | Secret store only; usage and errors are redacted evidence |
| Cloudflare bindings | Cloudflare account configuration | Worker, Queue, Workflow, D1, and R2 bindings | Carry the already-deployed control-plane operation | Binding names and non-secret IDs may be recorded; credential material may not |
| Sandbox execution token | Run-scoped adapter | Isolated sandbox process | Perform only the selected profile's allowlisted operations | Destroy at attempt end or stop; never persist in receipts |
| Evaluator access | Read-only evidence input | Independent evaluator boundary | Read the bounded run evidence and produce a separate finding | Store redacted finding and run identity; no transition authority |

The D1 ledger stores contract identifiers, state, lease/fence metadata, hashes,
and redacted receipts. R2 stores approved evidence and provenance, not provider
secrets. A missing credential, ambiguous environment, or unavailable revocation
record is a denial, not a reason to widen scope.

## Isolation and default-deny rules

1. The admission allowlist is the exact Linear project, issue identity,
   `mhoo-os/dark-factory` repository binding, supported profile IDs, declared
   collision groups, and current base revision. Everything else is denied.
2. The sandbox may access only the declared repository checkout, the selected
   profile's tools, and the run's temporary evidence path. Network access and
   credentials are denied by default; any exception must be explicit in the
   profile and contract.
3. Queue messages contain a durable run reference and contract digest, not raw
   credentials or uncontrolled provider prose. The message is acknowledged
   only after the D1 handoff is durable.
4. A Workflow owns one issue/run identity and one attempt sequence. Duplicate
   deliveries, stale leases, and out-of-order events cannot create a second
   execution or overwrite the current owner.
5. External GitHub and Linear changes are observations first. They enter the
   reconciliation path and must match the stored run, branch, PR, contract
   digest, and state rules before any update is considered.
6. The emergency stop cancels queued work and prevents new work. In-flight
   work must observe the stop at its next safe boundary and finish with a
   durable stopped receipt. Cron may repair missed observations; it may not
   invent a dispatch.

## Contract fixtures and evidence boundary

[`tests/fixtures/threat_model_cases.json`](../tests/fixtures/threat_model_cases.json)
contains harmless, non-secret fixtures for prompt injection, secret-shaped
output, cross-repository access, forged and replayed webhooks, and stale lease
writes. [`tests/test_threat_model.py`](../tests/test_threat_model.py) checks the
fixture contract and its fail-closed expectations. These are source-level
security fixtures, not evidence that a live Worker has executed them.

Live activation remains blocked until the deterministic admission path consumes
this contract, the signed ingress test passes, and a held-out pilot proves the
same controls at runtime with the factory still immediately stoppable.
