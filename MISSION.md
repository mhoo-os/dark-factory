# Mission

**Derived from:** Mhoo Dark Factory project brief in Linear (MHO-199 through MHO-223)
**Last reconciled with that brief:** 2026-09-02

## What Mhoo Dark Factory is

Mhoo Dark Factory is an internal execution system that turns already-planned,
machine-checkable Linear issues into bounded work in approved `mhoo-os/*` repositories.
It gives operators durable admission, scheduling, isolated execution, validation,
evidence, and a reviewable pull request without silently inventing product decisions.

Linear remains the planning and operational queue. The factory starts disabled and
begins at autonomy level 0; every increase in execution, concurrency, or merge authority
requires separate evidence and human approval.

## Who it is for

- Mhoo maintainers who need an approved Linear execution contract carried through a
  repository change with durable receipts.
- Operators who need to stop, inspect, reconcile, or recover factory work without
  granting an agent broad authority.

Mhoo Dark Factory is not a product-planning assistant, autonomous roadmap author, or
general-purpose coding service.

## Core capabilities (in scope)

The factory may accept issues in these areas.

**Contracted execution**
- materialize and validate Factory Dispatch Contract v1 without inference;
- bind repository, base, profile, dependencies, scope, risk, and merge policy.

**Durable operations**
- admit, schedule, execute, validate, reconcile, and preserve evidence for one issue;
- stop and recover work with explicit leases, idempotency, and human escalation.

## Out of scope (the factory must never build this)

Issues asking for any of these are rejected at triage, even when they are popular,
well argued, and easy to implement. This list is how drift gets recognised as drift.

**Never, not "not yet."** Everything here is rejected forever, including the quarter
it lands on the roadmap. Anything that is merely deferred belongs in the backlog, not
in this list. Copying a PRD's non-goals across without doing that sort is the most
common way this section quietly becomes wrong.

**Product and planning**
- inventing product requirements, roadmaps, PRDs, or Linear issues;
- replacing human/Sol planning or deciding unspecified product value.

**Authority and data**
- changing identity, permissions, credentials, Workspace authority, or provider ownership;
- migrating, deleting, or importing legacy/customer data without a separate decision.

**Execution effects**
- arbitrary repositories, non-`mhoo-os` targets, unapproved providers, or broad network access;
- automatic merge, production cutover, money movement, or irreversible external effects.

## Hard invariants (not tunable by any issue)

These are not features. They are properties that define what the factory is. The factory
cannot modify them even if an issue asks nicely, gives a good reason, or calls it a
bug. Changing one requires a human commit.

1. **Linear is the planning authority.** Dispatch fields come from the admitted contract;
   the factory never guesses missing repository, dependency, authority, or acceptance data.
2. **Every run is bounded and reviewable.** One issue binds one target, one base, one
   profile, one idempotency identity, and one durable evidence trail.
3. **The factory cannot modify governance files.** `MISSION.md`, `FACTORY_RULES.md`,
   `FACTORY.md`, and `CLAUDE.md` are human-owned constitution files.

## Allowed evolutions

Explicitly in scope, so the factory does not reject them as architectural drift:

- add an explicitly reviewed execution or validation profile for an existing repository;
- improve deterministic checks, receipts, recovery, and evidence without weakening authority.

## Definition of done

Every change the factory ships clears all three gates. A PR that skips any of them is
not done.

**Gate 1 - static checks and tests pass.** `python3 -m unittest discover -s tests -v`
and `python3 -m py_compile factory/*.py` pass.

**Gate 2 - the contract-level quality bar.** The selected issue's contract, scope,
authority, validation profile, and evidence requirements are explicit and fail closed.

**Gate 3 - the end-to-end path passes as a real user.**

1. Start from a clean checkout with the factory still disabled.
2. Run `bash factory/tick.sh --dry-run` against the approved Linear intake.
3. The dispatcher reads only an eligible, unambiguous contract and makes no mutation.
4. The output names the exact candidate or the exact fail-closed reason.

This runs on every change that touches runnable code, including ones that "seem
unrelated". It is not optional.

## Non-goals

Mhoo Dark Factory is explicitly not trying to be a platform, multi-tenant business
application, general assistant, provider credential vault, or autonomous merge authority.

When in doubt, the answer is "that is out of scope."

## Open questions - decisions nobody has made yet

<!--
  WORD THIS CAREFULLY, because the obvious wording breaks the factory.

  A generated MISSION wrote "Open questions - the factory must never answer these", and
  every rule downstream inherited it: any issue whose resolution touched one became
  needs-human. That directly contradicts FACTORY_RULES.md §7, which says an unspecified
  PRODUCT value is decided by the plan node, recorded, and held at the merge.

  Both files are protected, so the factory cannot reconcile them - and a genuine
  contradiction between two governance statements is itself on the stop list. The
  contradiction escalates the very issues the policy was rewritten to unblock.

  "Open" means I HAVE NOT DECIDED. It does not mean you may not propose.
-->

These are undecided, not forbidden. **The factory may propose an answer to any of them**,
build against it, and record what it assumed - the merge is then held for a human, so
nothing ships on a guess and nothing stops for one. See `FACTORY_RULES.md` §7.

- **Q1** Which approved execution profiles should be supported after the first held-out pilot?
- **Q2** What evidence threshold should permit any future concurrency increase?

**Except these, which do stop the factory** - they are on the irreversible list
(`FACTORY_RULES.md` §7.3) rather than open in the ordinary sense:

- identity, authentication, authorization, credential custody, or who may act as whom;
- importing, migrating, deleting, or destroying stored data.

Once answered, an entry moves to `.factory/decisions.md` with its answer and date, and
stops being asked. **A decision is asked once.**

## What the factory does NOT own - permanently human

<!--
  THE FACTORY'S SCOPE IS SMALLER THAN THE PRODUCT'S, and saying so here is what stops a
  green gate being read as "the product is good". It never meant that. It means the layer
  a machine can check is intact.

  These are the things no check will ever see. They are not a backlog and they are not
  "not yet" - they are a different kind of work, and it stays with a person.
-->

- whether a product decision is strategically or aesthetically right;
- whether an operator experience is clear beyond the deterministic checks;
- whether a proposed product change should exist at all.

The factory owns deterministic contract handling, bounded execution, validation,
reconciliation, and evidence. Humans retain product judgment and irreversible authority.
