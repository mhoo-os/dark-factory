# Sandbox adapter v1

`factory/sandbox.py` defines the execution boundary that a Cloudflare Sandbox/Container
implementation must satisfy. A request is bound to one dispatch, run, repository, exact
base SHA, declared profile, scope, command budget, and opaque short-lived credential
lease. Credential values never enter the request receipt, events, artifacts, or logs.

The adapter validates command tools and limits, records durable-safe events before each
provider side effect, verifies the checkout and final diff identity, bounds captured
output, and rejects unredacted output. Timeout, out-of-memory, provider loss, contract,
and cleanup failures are separate outcomes. Cleanup is attempted after every sandbox
start attempt; sandbox loss returns the events already persisted so the outer ledger can
reconcile rather than silently restart the work.

The provider is intentionally a protocol. The live Worker still needs a reviewed
Cloudflare SDK implementation and deployment proof; this PR is offline contract and
fixture evidence only.
