# Independent product gate v1

`factory/product_gate.py` runs the admitted validation profile in a fresh context. The
request binds the run to exact contract, repository, base, head, validation-profile,
acceptance, and base-pinned governance digests. The runner receives no builder plan,
reasoning, or claimed verdict.

The profile is a sealed canonical copy. Its quick, full, governance, and holdout checks
run in deterministic order. Every observation must repeat the exact identity, carry a
bounded evidence digest, and report a real status. A skipped check, missing evidence,
missing required positive marker, stale identity, or changed profile cannot produce
`pass`. Failures are classified as `fixable`, `auto-reject`, or `needs-human`.

The verdict is explicitly `gate_kind: product` and carries the check evidence needed to
attach a validation observation to the normalized run record from MHO-214. It is not a
PR-trajectory or conversation-trajectory result. The source contract does not publish,
merge, change governance, or change branch protection; a real runner and D1/R2 evidence
writer remain deployment gates.
