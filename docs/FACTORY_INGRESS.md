# Signed event ingress and Queue handoff v1

`factory/ingress.py` is the reference contract for the Cloudflare Worker
endpoints. Linear signatures are the hex HMAC-SHA256 of the exact raw body and
must have a current delivery timestamp. GitHub signatures use the
`sha256=`-prefixed HMAC-SHA256 form. Both providers require a delivery identity;
only the supported event types are normalized.

The normalizer emits a small envelope containing provider, delivery ID, event
type/action, payload digest, and safe selectors. Issue bodies, PR text, file
content, and other provider prose do not enter the envelope. Payloads are
bounded before parsing, and invalid signatures, timestamps, JSON, providers,
events, or repository scope never reach the queue.

The ledger's `factory_ingress_events` table is an outbox. A verified event is
reserved as `pending`, then the normalized envelope is enqueued, then the row is
marked `enqueued`; the webhook response is successful only after that handoff.
A crash leaves a pending row for reconciliation. Repeated delivery returns one
logical event by identity, and downstream processing remains idempotent.
Queue or ledger failures return a retryable response without synchronous
execution. `factory/ingress_replay.py` provides the bounded replay seam for
captured redacted fixtures.

This is source-level proof only. Live Worker endpoint deployment, D1 migration,
Queue binding, and signed admission acceptance remain separate gates.
