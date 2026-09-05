# Native Codex candidate adapter: first source increment

MHO-253, 2026-09-05. **Mock-only source proof; runtime activation is NO-GO.**
This wraps the existing Cloudflare ledger/lease boundary. It adds no scheduler,
run database, ingress endpoint, publication credential, or live executor route.
The Worker entrypoint does not import this module.

Authority: the current native decision in [MHO-253](https://linear.app/mhoo/issue/MHO-253/implement-isolated-native-codex-adapter-and-bounded-pro-review-loop)
and [Production Architecture v2.0, section 7](https://linear.app/mhoo/document/mhoo-production-architecture-v20-oracle-cloudflare-and-isolated-f2baa3b3702d)
supersede historical mandatory-hosted wording. Cloudflare alone owns scheduling,
budgets, leases/fences, stop/cancel, retries and canonical transitions. Native
Codex is candidate-only; a separate trusted publisher and human merge remain.

## Reuse and bounded behavior

`src/native-candidate.ts` uses existing D1 `factory_runs`, `factory_steps`,
`control_flags`, and the four-domain lease reservations. Migration 0008 adds
receipt guards to existing steps, not another state machine. It records its own
schema capability without changing the existing factory-ledger version.

1. A trusted Cloudflare caller admits and grounds the run through existing
   primitives, then calls `reserveMockAttempt`. The source fixture allows one
   attempt per canonical run, concurrency one, and at most 30 seconds. The
   request digest binds the caller's approved task. It cannot be substituted or
   used to reset a deadline, fence, or attempt after restart.
2. `deliverMockAttempt` verifies the persisted intent and calls the trusted
   `revalidate` callback for current external head/registry/contract observations.
   The launch claim uses a conditional D1 insert, checking running state, exact
   bindings, stop explicitly false, unexpired run lease and all four lease slots.
3. A persisted launch is never resent. A crash before spawn, after process start,
   or before receipt storage has the same conservative result: ambiguous, with
   no independent retry. Duplicate delivery returns `ambiguous-no-resend` even
   after a recorded completion; consumers can inspect the immutable receipts.
4. The mock runner checks the current grant before spawn, during execution and
   after exit. It has a bounded deadline and output size, empty environment/homes,
   and kills the process group on stop/expiry/grant loss. It executes only bytes
   matching the pinned mock SHA-256, in a disposable directory. No arbitrary
   executable, repository command or model prompt is accepted by this runner.
5. Results append an immutable receipt, including the full intent identity,
   launch and output digests, observation time, candidate head and stop status.
   Unknown usage stays `null`/`UNKNOWN`; it is never zero cost or proof of account
   entitlement. Receipt columns retain the original registry identity even when
   current authority has changed. Raw output and errors are not stored in D1.

All return values and receipts have `publicationAllowed: false`. A late, cancelled,
stale, malformed or uncertain result is quarantined as an observation. This module
does not advance canonical run state, release a lease, allocate a replacement lane,
or publish. Future Workflow integration must consume the disposition through the
existing transition/reconciliation APIs to park the canonical run and retain any
uncertain assignment; it must not treat this helper's return as that integration.
The current executable mock emits a synthetic head, not a real Git commit or diff.

The existing `recordStep` upsert and `DurableWorkflow._step` retry behavior are
intentionally not used for native receipts/launches. UPDATE, DELETE and REPLACE
of native receipt keys are rejected by migration 0008. Canonical run/step keys
and hashes provide immutable observations, not a claim of exactly-once remote
execution or protection against a database administrator dropping the guards.

## Native CLI and remaining gates

Read-only local discovery returned `codex-cli 0.145.0`; no `exec`, authentication
operation or account inspection was performed. This is a version candidate for
later validation, not an approved live executable/image pin. The only executable
pin tested here is the mock fixture SHA-256 exported by the runner and recorded
in the persisted intent. Replacing it requires explicit source review.

[Official noninteractive documentation](https://learn.chatgpt.com/docs/non-interactive-mode)
documents `codex exec --json` and `--sandbox workspace-write`. The
[authentication documentation](https://learn.chatgpt.com/docs/auth) distinguishes
ChatGPT subscription access from API-key billing. Those interfaces do not prove
MHOO entitlement, credential containment, process containment or cancellation.

Before any real native execution or publication:

- Prove a separate isolated execution environment outside the production Coolify
  host and personal credential-bearing homes. Select and verify the real CLI and
  environment artifact digests and supported subscription-account permissions.
- Prove candidate code cannot read Codex account auth, production secrets, host
  management credentials or publisher App keys. Empty mock homes and process
  groups are not a security boundary for hostile descendants that can detach;
  prove OS/VM containment, resource/network limits and descendant kill/readback.
- Integrate authenticated outbound grant/readback with Cloudflare Workflow
  transition/recovery APIs, persist original run-owned budgets and accounting,
  quarantine uncertain tasks/lanes, and test crash recovery without blind retries.
  The callback and injected runner here are trusted test boundaries, not an
  authenticated network protocol. No API/OpenRouter fallback is implemented.
- Reuse the trusted publisher after exact head/scope/grant revalidation and
  reconcile [PR #31](https://github.com/mhoo-os/dark-factory/pull/31)'s App-auth
  boundary. This increment does not modify its authentication or publisher code.
- Complete required exact-head CI, independent Pro request/result review and
  the later trusted Critical/High-only repair loop (at most three rounds within
  original budgets). Human merge/deployment remain separate decisions.
- Supply current MHO-219 runtime/schema/backup/rollback evidence and separately
  authorize any pilot. Source preparation does not wait for those runtime gates.

## Verification and rollback

`npm run test:native` exercises real SQLite with the D1-shaped API and disposable
subprocesses. The existing migration-sequence suite also applies 0008 using local
Wrangler/D1 from fresh and partially migrated fixtures. These are synthetic local
proofs, not deployed D1 or a live account-backed task.

No migration is applied remotely by this change. Reverting source is safe because
the module has no live entrypoint. If migration 0008 is later applied, retain its
receipt guards and evidence on rollback; do not erase receipts or recycle an
uncertain run to restore availability.
