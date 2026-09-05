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
4. `COMPLETED` requires a SHA-256 output digest and at least one durable Linear or
   GitHub output URL before the lane returns to `IDLE`.
5. The scheduled handler moves expired active leases to `BLOCKED`; it never
   silently recycles a chat whose external work may still be running.

Every lease has an idempotency key, request digest, random token, monotonically
increasing fence, expiry, assignment metadata, and append-only events. Review
leases additionally require repository, PR number, and exact 40-character head
SHA. Reusing an idempotency key with different input fails closed.

## Phase 0 limits

- Manual authenticated calls only; no webhook is connected yet.
- No ChatGPT credential, token, or browser session is stored.
- No automatic merge, deploy, production configuration, or planning mutation.
- A blocked or expired lane needs an operator decision before it can be reused.
