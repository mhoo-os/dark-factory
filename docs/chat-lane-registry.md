# Chat lane registry (MHO-250 Phase 0)

The registry is the durable allocation layer for five independent review chats
and five independent planning chats. It does not send prompts, create chats,
modify pull requests, or change Linear. Those side effects remain outside this
Phase 0 boundary.

All routes require the existing `FACTORY_ADMIN_SECRET` bearer credential.
Chat IDs and the credential are runtime data and must not be committed.

## Lifecycle

1. `PUT /chat-lanes/{review|planning}-{1..5}` binds a chat ID and makes the lane `IDLE`.
2. `POST /chat-lanes/lease` atomically leases the lowest numbered compatible lane.
3. `POST /chat-lane-assignments/{assignment-id}` moves the lease to `PUBLISHING`,
   `COMPLETED`, `BLOCKED`, or `REPLACE`.
4. `COMPLETED` requires an authenticated operator attestation, a SHA-256 output
   digest, and a typed completion manifest before the lane returns to `IDLE`.
   A review manifest must exactly repeat the stored repository, PR, head SHA,
   Linear issue, stable review ID, and unambiguous verdict, plus both exact
   durable comment URLs: the linked Linear issue comment and the GitHub PR
   conversation comment. A planning manifest must bind its stored Linear issue
   or bounded objective and a durable output. Homepage URLs, arbitrary output
   digests, partial review artifacts, and mismatched identities fail closed.
5. The scheduled handler moves expired active leases to `BLOCKED`; it never
   silently recycles a chat whose external work may still be running.

Every lease has an idempotency key, request digest, random token, monotonically
increasing fence, expiry, assignment metadata, and append-only events. Review
leases additionally require repository, PR number, exact 40-character head SHA,
linked Linear issue, stable review ID, and verdict. Planning leases require one
explicit Linear issue or bounded objective. Reusing an idempotency key with
different input fails closed.

## Mutation and recovery safety

The assignment row is the authoritative mutation boundary. Additive migration
`0005_chat_lane_transition_guards.sql` plus schema-6/7 activation migrations install SQLite guards and after-update
triggers so a status transition, matching lane state, and its one audit event
commit together or roll back together. Token/fence/state and lease liveness are
checked inside that transaction. An expired token cannot publish completion or
release a lane; recovery alone changes it to `BLOCKED` and records
`LEASE_EXPIRED`. A rebind or replacement is then required and receives a new
fence, so old token/fence pairs remain fenced.

## Upgrade, readiness, and rollback

Apply migrations in numerical order, including 0007, to a local/staging database
before enabling any registry route or relying on scheduled registry recovery.
Until the registry tables are ready, registry endpoints fail closed. The
scheduled handler isolates a registry-readiness failure, records it, and still
runs the pre-existing factory recovery sequence; it never reports a registry
recovery success for an unready schema.

The migrations are additive. A populated schema-4 upgrade preserves assignments
and events; a fresh install runs 0004 through 0007. If source is rolled back, leave
the registry tables, assignment history, and audit events in place. Schema 7
activates only while the new source writes its explicit v2 `transition_reason`;
the migration clears markers retained by schema 6, and the replacement trigger
clears each new marker in the same transaction after recording the durable event.
A later pre-0005 source rollback therefore uses its original
statement batch without inheriting the marker, trigger abort, or duplicate event,
including for rows already transitioned by v2. That preserves an
old-code rollback path, but it intentionally restores the old source's weaker
registry guarantees: keep registry calls disabled and treat external active
chats as blocked until an operator reconciles them. Do not apply remote D1
migrations as part of this Phase 0 procedure.

## Phase 0 limits

- Manual authenticated calls only; no webhook is connected yet.
- No ChatGPT credential, token, or browser session is stored.
- No automatic merge, deploy, production configuration, or planning mutation.
- A blocked or expired lane needs an operator decision before it can be reused.

## MHO-253 request/result interface (source only)

Migration `0009_review_result_receipts.sql` adds an immutable completion manifest
column to existing assignments and a separate `chat-review-receipts` capability
marker. Existing Phase 0 requests keep their original behavior. The new
`review_request_version: mho253-v1` requires canonical run, contract and fence,
prior review ID (or null), and the existing repository/issue/PR/head/review binding.
It forbids a requested verdict. Without the new capability it fails closed.

Completion independently supplies PASS or REQUEST CHANGES, the exact request
digest, unchanged canonical/prior-review binding, both output digests and links,
and the existing authenticated operator attestation. The winning lane transition
stores that result separately from the request and writes the existing completion
event in the same transaction. Request/result rewrite, deletion and replacement
are refused. Legacy source cannot complete new requests without a preselected
verdict: on rollback keep new assignments held and retain migration/evidence.

`readReviewPair` is a read-only adapter interface tested with synthetic providers.
The trusted reader must obtain author IDs, URLs and byte digests from authenticated
provider readback, never from review prose. Canonical context must come from
Cloudflare. No real reader, model, dispatch or publication implementation is wired.
The interface snapshots context before awaiting its reader; it requires matching
request/head/review/issue/PR, trusted authors, reciprocal concrete artifact links,
matching verdicts and bounded finding lists. A repair proposal requires an in-scope
Critical/High blocker, unchanged canonical run/contract/fence/head, an unexpired
budget, positive known remaining cost and fewer than the original maximum of at
most three completed repair rounds. PASS, Medium/Low-only, exhausted, unknown or
stale context cannot propose repair. Every output denies execution, publication
and merge. This predicate does not consume/reset counters or authorize an attempt;
a later canonical repair claim must re-read and atomically enforce those budgets.

Synthetic end-to-end tests drive readback through lane completion and immutable
result readback for both verdicts. This is not Pro acceptance or runtime proof.
Remaining integration includes authenticated provider readers, canonical required-CI
readback and atomic repair-attempt admission/publication under the original run.
