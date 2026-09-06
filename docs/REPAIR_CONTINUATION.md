# MHO-253 synthetic repair continuation

Source-only, on PR36 `e19f3733fcef4b2b94500d32e174feb14d6514dd`. No real
provider, model, publication, merge or deployment is wired into this composition.

The trusted Workflow wrapper derives cost/time ceilings from existing runtime
limits and the run's original creation time. It counts previously used fix rounds
and verified canonical execution-cost receipts. Missing accounting, including the
current native UNKNOWN path, is refused. Caller policy cannot replace these caps.
The current stricter MAX_FIX_ATTEMPTS ceiling still applies.

One immutable plan in existing factory_steps retains that original budget, review
assignment, required-check producers, authorized blocker IDs and canonical identity.
Migration0010 protects these plan/claim/result records. There is no new database,
queue, scheduler or state authority. All migrations exercised here are local only.

The bounded loop reads the completed paired review, verifies fresh exact-head CI
and producer identity, then atomically inserts one round claim against run state,
contract, base/head/branch/PR/issue, STOP, fence and all four capacity reservations.
Claim/result counts and a full round cost reservation prevent duplicate/racing
admission, changed-review budget resets and overspend. No refund creates another
attempt. The full reservation covers both repair and re-review.

After one synthetic repair, trusted accounting and simulated publisher head
readback must agree before canonical head advances. Required CI is checked again
before a fresh independent request, whose result is stored through the existing
paired lane interface. A durable result permits continuation under the same plan;
at most three rounds, or the stricter original cap, may occur. PASS only produces
human-review-ready with execution/publication/merge denied. Completed attempt grant
callbacks are revoked. Replayed readiness is rechecked against current CI/head.

Unknown cost, missing acknowledgment, stale authority, invalid/absent CI or an
unconfirmed process stop holds the existing run and capacity. Claims are not resent.
Existing lease recovery and release/takeover guards retain claimed repair capacity.
Human reconciliation remains required to release it; no release override is added.

The synthetic trusted-provider adapters in tests simulate the entire sequence,
including repairs, changed heads, CI, paired artifact readback and accounting.
They are not genuine artifact publication or subscription/custody evidence. Real
runtime dependencies are an approved isolated executor, verified stop/custody,
supported subscription accounting, authenticated provider/CI/publisher readers,
and explicit runtime/pilot approval. The running Workflow must select this bounded
continuation with its existing lease; no live PR-to-Workflow dispatch is enabled.
