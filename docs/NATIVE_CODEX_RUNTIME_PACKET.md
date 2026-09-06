# MHO-253 isolated runtime verification handoff

Status: NOT EXECUTED. No environment is allocated by this packet. Live execution
and publication remain disabled. This continues PR #32 at
`886a59de22ef7e7be7c8550b26db83d66b77b0e8` and PR #33 at
`72bec3cd0698f9f0fcbb8d6ffae4f8cb853a69c6`; both had exact-head CI SUCCESS
when checked on 2026-09-06. Those proofs concern mock execution and inert policy,
not real Codex containment or account custody.

## Required allocation decision

The owner must name an existing approved, disposable, non-serving VM/environment
and its custodian. Record environment ID, host/platform, resource/time ceiling,
permitted fake-only setup and teardown, and the approval reference. Do not infer
allocation from Mac mini login, spare capacity, mesh access or the Oracle serving
baseline. No purchase, real login or production-host execution is included.

Acceptance requires no personal or production mounts, host management sockets,
SSH-agent forwarding, publisher material, production credentials or customer data.
The environment custodian must supply independently observed mount, process,
network and teardown evidence. A self-reported candidate receipt is insufficient.

## Ordered verification packet

1. **Inventory and pin.** In the named guest only, record OS/architecture, exact
   controller and candidate identities, immutable Codex executable bytes/version
   and provenance. The Darwin discovery pin in `native/launch-policy.mjs` is not
   a verified guest install or a Linux pin. Record actual rendered config bytes,
   their digest and enforcement/precedence evidence. `PROFILE_DIGEST` describes
   requirements; it does not hash an installed permission configuration.
2. **Fake-only containment.** Place the public fake canary named in
   `native/containment-contract.mjs` in the proposed controller auth location.
   Execute each of its 20 cases through every enabled candidate tool surface.
   Record attempted operation, expected denial, independently observed result,
   exact environment/config/intent binding and a sanitized evidence digest.
   Explicitly disabled surfaces need independent proof that invocation is denied;
   absence of a test is not a pass. The existing synthetic checker accepts only
   synthetic evidence and must not be repurposed as real attestation.
3. **Stop and teardown.** Exercise normal and detached descendants, ignored
   termination, loss of grant, deadline expiry and guest shutdown. An independent
   custodian must confirm no remaining candidate processes or accessible workspace
   before reuse. Unknown stopped state quarantines the same attempt and environment.
   Ordinary process-group cleanup from PR #32 does not establish this result.
4. **Custody decision after containment.** Present the exact verified guest,
   config, controller identity and auth-store boundary for explicit account-login
   approval. Use a supported direct login only after that decision; no personal
   credential copying, custom subscription proxy or API/OpenRouter fallback.
5. **One authorized runtime attempt.** After current MHO-219 readiness and a
   separate execution grant, reuse the existing Cloudflare run/step/lease and
   immutable NativeIntent identity. Persist intent before launch and revalidate
   current grant, fence, head, deadline and STOP at boundaries. Lost delivery or
   receipt acknowledgment parks that same attempt; do not resend or invent a
   local retry. Bind independently observed task identity and result digest.
6. **Accounting and publication holds.** Record supported account/workspace and
   subscription mode without credential bytes. Token observations are not allowance
   debits or a billing receipt. Missing accounting remains UNKNOWN and requires
   Cloudflare disposition, never zero. Candidate output cannot publish. Trusted
   publication, required exact-head CI, independent Pro paired outputs and bounded
   Critical/High repair integration need their own acceptance before loop readiness.

## Evidence ownership and stop conditions

Infrastructure owns the named environment and isolation/teardown observations.
MHO-253 owns adapter source and binding to canonical attempts. MHO-219 owns
Cloudflare runtime readiness and recovery/binding receipts. Cloudflare remains
sole scheduling, lease/fence, budget, cancellation, retry and state authority.
Humans retain merge, deployment and pilot approval.

Any credential reachability, widened tool access, unverified guest pin, ambiguous
stop, stale grant or unsupported accounting stops dependent work. Preserve the
original attempt and evidence. A new environment or head does not reset budgets.
The automated review loop is distinct from the manually assisted baseline.

## Continuation source review

The source validators previously accepted single-element JSON arrays where a
string digest, environment/model selector or result head was expected: JavaScript
regular expressions coerced arrays to strings. The continuation requires primitive
strings before pattern checks. Nine new array regressions fail against PR #33;
all ten new type regressions pass after the correction. The full focused policy
suite passes 122 tests with 100% line/branch/function coverage in its three modules.

This change does not seal JavaScript objects against arbitrary in-process code or
make digests attestations. Inputs still require trusted canonical readback, and
returned proposals remain inert mutable data with execution/publication disabled.
No guest tests, credential operations, model calls or runtime activation occurred.

## Canonical recovery source continuation

`readNativeAttempt` now reconstructs only persisted intent/launch/receipt bytes,
checks their identity and digests, and distinguishes missing acknowledgment,
unconfirmed stop, quarantined result and unknown accounting. The Worker reconciler
uses the existing `transitionRun` to record one fenced `needs-human` event without
resetting the native attempt, changing its head, or releasing its capacity.

Existing expiry recovery calls this seam for claimed native attempts. Lease
acquisition refuses both a new reservation for that run and takeover of its
expired slots; ordinary lease release also refuses a native launch claim. These
checks use existing immutable steps and lease records, without a schema change.
They apply even when Factory dispatch is disabled. Unclaimed intents retain the
ordinary expiry recovery path. A malformed readback fails closed with capacity
retained; it does not authorize a replacement attempt.

All claimed native capacity remains held, including a stopped mock candidate,
until separately governed human reconciliation. This increment provides no release
API, real executor, authenticated relay transport or review dispatch. Native
accounting remains UNKNOWN. The mock delivery composition invokes the same canonical reconciler in a finally
block, including delivery errors; scheduled recovery handles expired attempts.
Neither adds a dispatch route or real transport. Source tests do not prove deployed behavior.
