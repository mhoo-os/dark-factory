# Normalized factory run evidence v1

`factory/evidence.py` seals one canonical, versioned record for a run. The retry-stable
`run_id` is derived from the dispatch, contract, Linear issue/project, repository, and
base SHA; an attempt or provider retry does not create a second run identity.

The envelope binds planning identity, repository/base/head/PR identity, execution and
validation profile digests, model/provider/version/reasoning/routing metadata, normalized
turn and tool-call metadata, sandbox command/output digests and redacted artifact refs,
validation markers, fix attempts, measured resource usage, outcome causes, and separate
product/PR/conversation evaluator observations. Evaluations are hard-coded as
`observer-only`; they cannot authorize a transition, dispatch, approval, merge, or rule
change.

D1 stores the identity, state/outcome, digests, measured usage, derived metrics, evaluator
summaries, and R2 references. R2 stores only bounded, redacted trace/artifact content with
an explicit retention class. Raw message/tool content is never a field in the envelope;
retained content is a redacted R2 reference plus a digest. Private builder reasoning is
excluded. The serialized trace is parsed as data and is never evaluated as code.

`evaluator_view()` gives observers normalized facts without retained turn metadata by
default; `d1_projection()` contains the small index-safe projection. Metrics are derived
from structured records, not ad-hoc logs. A null measured cost is reported as incomplete,
never estimated. This is source-level custody proof; D1/R2 wiring and live pilot evidence
remain separate deployment gates.
