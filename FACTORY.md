# The factory

<!--
  Maintainer: whoever raises the autonomy dial. Update the level and the date on the
  same commit that changes the level - a stale level here is a lie about what is
  running unattended.
-->

**Current autonomy level: 0** - no issue dispatch; operators may run dry-run checks.
**Set to this level on:** 2026-09-02
**Stop button:** create `.factory/STOP`; the dispatcher checks it before any work.
**Built from project:** Mhoo Dark Factory project in Linear - `MISSION.md` is its
compression. Change one, change both.

## The process this encodes

The factory automates only the execution part of an approved Linear contract: deterministic
admission, dependency and lease checks, ground the contract against the selected base,
run isolated implementation, validate independently, review/fix within the cap, publish
one PR, and reconcile external state. Human planning, governance, and merge approval
remain outside the factory. The contract and constitution are read before execution;
models never choose the issue, repository, authority, or acceptance criteria.

## The five components, as built here

| # | Component | This repo's version |
|---|-----------|---------------------|
| 1 | Workflow-driven repo | Cloudflare Workflow per admitted issue |
| 2 | The trigger | signed Linear/GitHub events plus reconciliation Cron |
| 3 | Deployment | Cloudflare Worker/Queue/Workflow with reviewed source |
| 4 | Guidance layer | `MISSION.md` · `FACTORY_RULES.md` · `CLAUDE.md` |
| 5 | Validation harness | independent repository profile and held-out pilot evidence |

## The gates that are actually code

Everything else is a prompt instruction, which is a suggestion with good manners.
These are the ones a model cannot argue past:

1. `factory/gate.sh` - asserts every marker in `FACTORY_REQUIRED_MARKERS`, checks the
   counts, and refuses the merge when the raw output and the verdict disagree.
2. `factory/guard.py` - the protected list and the scope caps. Fails **closed**.
3. `factory/dispatch_contract.py` - validates and digests the dispatch contract.

## The end-to-end path

The single user journey that gates every merge:

1. Start from the approved repository checkout with the stop file absent.
2. Read the signed/declared Linear contract and run the deterministic admission checks.
3. Produce one explicit candidate decision and durable evidence without guessing or dispatching at level 0.

Required step count: **3** (`E2E_PASSED steps=3`).

**Last deliberately broken and confirmed failing:** not yet recorded. The first deliberate
fault drill is a prerequisite for leaving level 0.

## The autonomy ladder, and where we stop

| Level | Automatic | Reached |
|---|---|---|
| 1 | admitted issue → bounded PR opens | not reached |
| 2 | independent validator runs and posts a verdict | not reached |
| 3 | validator may auto-merge under a human-approved ratchet | not reached |
| 4 | self-triage and scheduled fault filing | not reached |
| 5 | writes its own issues from the mission | prohibited |

**Before the next notch, these must be true:**

- [ ] held-out single-issue pilot proves dispatch, recovery, stop, and reconciliation;
- [ ] a human records the evidence and explicitly approves the next autonomy level.

## Operating notes

- **Cost.** No live execution cost has been measured; level 0 intentionally dispatches nothing.
- **Model routing.** No model is selected by the control plane until a reviewed profile exists.
- **What reaches a human.** `factory:needs-human`, stop/failure receipts, and held-out evidence.
- **Known gotchas for this repo.** `factory/` is protected from autonomous edits; governance
  changes require a direct human-reviewed commit. Cloudflare deployment is not proof of readiness.

## Incident log

Append only. Every entry is a rule that now exists because of it.

| Date | What happened | What changed as a result |
|---|---|---|
| No incident recorded | Keep the table append-only when a real incident produces a new rule. | — |
