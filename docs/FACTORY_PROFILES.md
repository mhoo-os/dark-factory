# Factory execution and validation profiles v1

`factory/profile_registry.json` is the versioned registry for the execution,
validation, and collision-group contracts. The first concrete binding is
`mhoo-os/dark-factory` with `python-tests-v1` for both execution and validation.
Its shape is described by `factory/profile_registry.schema.json`.

Execution profiles declare the runtime, checkout preparation, allowed tools,
model policy key, limits, and evidence outputs. Validation profiles declare
independent quick/full checks, required positive markers, governance checks,
holdout hooks, and merge eligibility. A validator never consumes builder plans
or reasoning as evidence.

`resolve_profiles` requires an exact repository/profile tuple. Unknown profiles,
repositories, and collision groups fail closed. The resolved bundle is canonically
serialized and SHA-256 digested; that digest must be stored with every run.
Collision keys are sorted and share `unclassified` when a path has no declared
group, so the scheduler cannot accidentally run unknown scopes concurrently.
