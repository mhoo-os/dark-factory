# Independent PR trajectory binding v1

`factory/pr_trajectory.py` binds the private `trajectory-eval` observer to a factory
run without importing its runtime or granting it execution authority. A valid review
uses the exact key `(repository, PR, head, base, rubric digest)` and also carries the
base-pinned manifest and governing-source digests.

Tier 1 evidence and bounded Tier 2 results are digest/reference-only. A missing or
invalid base manifest becomes `NOT_CONFIGURED`; it never falls through to a generic
judgment. Valid observations map to the MHO-214 normalized `pr-trajectory` evaluator
shape with `authority: observer-only`.

The observation key changes with head/base/rubric, preserving historical evidence.
The GitHub comment intent has one stable marker-owned key per repository/PR, so a new
current observation updates one comment rather than creating a thread per retry. Duplicate
observations are no-ops, and only `upsert_marker_comment` is exposed. The adapter never
executes PR code, routes factory work, mutates factory state, approves, merges, or changes
branch protection.
