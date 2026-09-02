# Ground execution lowering v1

`factory/ground.py` is the deterministic replacement for an unconditional per-issue
planning/PIV call. It reconciles the admitted contract with a repository snapshot,
current base SHA, profile registry, declared scope, file movement, and explicit
contradictions. Its output contains the contract and profile digests, observed
touchpoints, any benign path map, executable acceptance/validation steps, and a
digest of the complete grounding result.

Grounding can accommodate a file moving inside the declared scope. It cannot rewrite
product intent, add acceptance criteria, widen scope, or invent a new plan. Repository
or base drift, unsupported profiles, and material contradictions return `needs-replan`
with no implementation steps. The function is pure and invokes no model, provider, or
write path; the live Workflow must persist the result before sandbox execution.
