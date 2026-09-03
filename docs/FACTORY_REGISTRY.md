# Trusted Factory Registry v1

`factory/factory_registry.json` is the sole machine-readable authority for vertical
factory identity and ceilings. Both the Python reference implementation and the
Cloudflare Worker load this artifact directly. There is no second TypeScript
repository allowlist to keep in sync.

The registry is human-owned. The autonomous sandbox already treats every file in
`factory/` as protected, so a factory run cannot edit the registry, its schema, or
its promotion rules. A human-reviewed pull request must approve every registry
change. Promotion evidence is named by each entry; changing a state, ceiling,
project, repository, profile, credential boundary, or concurrency limit creates a
new registry version and entry version.

## Admission boundary

Admission resolves the Linear project and team from trusted provider fields. It
must find exactly one registry entry. Issue prose cannot declare `factory_id` or a
registry identity. The issue may request only a subset of the selected entry's
exact repository, work type, execution and validation profiles, collision group,
scope, risk, authority, merge, credential, model, escalation, and concurrency
ceilings.

Unknown projects, disabled factories, duplicate mappings, forged identity, stale
registry bindings, and over-authority requests return stable refusal reasons before
model or sandbox execution. The normalized Dispatch Contract v1 materializes:

```json
{
  "registry": {
    "factory_id": "foundation-pilot",
    "registry_version": "2026-09-03.1",
    "registry_digest": "sha256:...",
    "entry_version": "1"
  }
}
```

The digest covers the entire canonical registry, so an execution-significant
change makes older queued work stale. It must be explicitly re-admitted. If an
entry is disabled, new admission stops immediately and already-admitted work is
refused before dispatch. Existing run and evidence rows are retained.

## Initial state and rollback

`foundation-pilot` is the sole active entry. It maps exactly to the Mhoo Dark
Factory Linear project, the MHOO team, and `mhoo-os/dark-factory`. Its concurrency
is one, its issue request concurrency is one, its autonomy remains controlled by
the existing explicit pilot flags, and merge authority is human-only.

`dark-connector` and `finance` are disabled reservations with no project or
repository mapping and no execution capacity. Enabling either requires a separate
human-reviewed onboarding change. Rollback means publishing a new registry revision
with the affected entry set to `disabled`; it does not delete prior evidence.

The public `/health` response exposes only availability. Authenticated operators
may read `/ops/status` with the existing admin bearer secret to see stop state, the
effective registry version/digest, and active factory IDs.
