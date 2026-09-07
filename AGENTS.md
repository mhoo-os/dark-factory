# Working in dark-factory

## Scope and authority

Read [MISSION.md](MISSION.md), [CLAUDE.md](CLAUDE.md),
[FACTORY_RULES.md](FACTORY_RULES.md) and [FACTORY.md](FACTORY.md) first. Their
scope, style and process hierarchy remains authoritative. This guide does not
change protected paths, admission rules, validation gates or autonomy.

This is the source repository for deterministic admission, bounded execution,
state, validation and evidence of approved Linear contracts. Human operators own
planning and governance. Workspace/provider authority and production cutover do
not move here. Reuse the existing state contract, ledger, leases and evidence
primitives; do not introduce a parallel scheduler, ledger or credential authority.
Preserve the copied upstream skill and attribution in [UPSTREAM.md](UPSTREAM.md).

## Before probes or edits

1. Verify origin, remote default branch and exact source/base heads. Inspect the
   selected checkout's dirty state and applicable instructions. A missing local
   file is not proof of its absence on remote main or another worker's branch.
2. Read the issue's existing run ledger, linked PRs and latest worker receipt.
   Reuse the coordinator checkpoint and retained evidence before any tests,
   builds or runtime probes. Identify the exact unfinished step and its owner.
3. Use an isolated checkout for authorized edits. Preserve shared dirty files,
   generated state, logs and other workers' branches. Neither a stale ref nor a
   worktree marked prunable proves its evidence is disposable.
4. Confirm scope and worker custody. The desk routing is user → voice coordinator
   → repository head → existing issue worker. A new repository head or project
   label is not a worker transfer. Transfer needs explicit ACK and notification
   to retained workers; do not duplicate, interrupt or resume them implicitly.

Local desk evidence, when available (machine-specific references, not required
repository files): `/Users/mhoooo/Documents/Codex/MHOO-DESK-SETUP.md` and
`/Users/mhoooo/Documents/Codex/2026-09-06/mhoo-coordinator/checkpoint.json`.
Use the existing issue ledger if these paths are unavailable; do not invent a
replacement status system or treat a missing local checkpoint as lost work.

At setup on 2026-09-07, transition coordinator
`01a0757d-0f0b-7713-9c4c-6541e67ed905` retained worker custody:

- MHO-253 source/native: `01a07545-81ee-7c61-b31e-a36ea9f80f2f`.
- MHO-219 readiness: `01a07544-0052-7e01-a609-1f6871844f3c`.

These are historical routing pointers. Check the subsequent explicit handoff
before using them. The [README evidence snapshot](README.md#evidence-snapshot--2026-09-07)
records the existing PR heads and remaining gates.

## Verification and evidence

Use the exact commands in [package.json](package.json) and
[CI](.github/workflows/verify.yml), summarized in [README.md](README.md#development-commands).
Do not infer a successful check from its configured existence. Follow the
constitution for runnable-code changes; inspect the final diff and run
`git diff --check` for every change. Documentation-only edits need no redundant
full build or runtime test. Preserve required CI and report its exact-head outcome.

Record scope, source/base, check result, evidence location, owner and next gate in
the existing issue/PR ledger. Invalidate only the affected receipt when its source,
base, configuration, runtime identity, contract or authorization changes. A prior
CI pass stays attributed to its old head; synthetic/local proof does not become
remote restore, containment, credential custody or release acceptance.

Do not manually edit generated context blocks. If central context enrollment or
architecture changes are required, send the exact catalog/checker change to the
coordination repository owner for reviewed regeneration. This local guide does
not claim central catalog enrollment.

## Finish, continue or escalate

- **Finish:** the authorized increment is reviewable, applicable checks have
  receipts, and remaining gates are named. Report exact commit/PR and availability
  to retained checkouts; an open PR is not installed guidance. Stop when the
  bounded assignment is complete.
- **Continue:** only a concrete unfinished step within the same accepted scope
  and custody remains. Reuse existing receipts and workers first.
- **Escalate:** ownership conflicts, changed protected authority, ambiguous
  claims, missing runtime custody or a new external effect need the existing
  coordinator's decision. Name the exact missing evidence/action; do not rerun
  unrelated checks or release held claims to manufacture progress.

Setup authorizes no pilot, live dispatch, claim release, remote D1 or Worker
mutation, credential handling, merge, deployment or deletion. Keep claim-aware
recovery fail-closed. Classify cleanup candidates from evidence only; unknown
files/resources stay preserved until a separate scoped decision.
