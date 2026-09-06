# MHO-219 remaining runtime recovery packet — 2026-09-06

ARCHITECTURE IMPACT: LOCAL

**NOT EXECUTED; pilot NO-GO.** This is an operator review packet, not a new
recovery service, an approved resource allocation, or proof of remote recovery.
Cloudflare remains control-plane authority. Dispatch/autonomy/automatic merge
remain disabled under the current hold; merging is a human action.

## Reuse and provenance

Source anchor: PR31 `cd1a439d44017cbde1733f4334dc747577557aa7`.
[Existing evidence](https://linear.app/mhoo/issue/MHO-219/provision-cloudflare-factory-environments-secrets-bindings#comment-4ef187d9-3917-46a5-afa3-3dea1d92cce1)
records serving JavaScript identity and real retained backup LOCAL recovery at
03:21 UTC September 6. These completed proofs were not rerun here.

- Serving deployment `09b95eeb-9f49-43df-aedd-8d88d3fcb4aa`, version
  `a9f3c283-31f3-4ed6-8679-a3cb69826555`, matched PR31 JavaScript SHA256
  `2c9525c885f275ebd43191a4019c3901f5e1d6429e0e3292803efff8b281789d`.
- Exact retained backup is identified in `manifest.json`: 22,104 bytes, pre-v7,
  four migration receipts, schema 4, 59 historical webhook rows. Prior local
  verification preserved original data through schema 7. No backup was retrieved
  or copied in this increment; row classification is not inferred from its name.
- The 03:21 D1 inventory found no named isolated Factory recovery destination.
  This dated observation must be refreshed before any allocation.
- The manifest pins all nine source SQL files and identifies the five pending
  files. Hashes were recomputed from the exact PR31 checkout in this increment.

Disposition is **USE** existing D1, retained backup, Wrangler migrations, source
checks and infrastructure monitoring. No optional Sandbox, AI, R2 Worker binding,
new monitoring service or executor allocation is added by this packet.

## Decision needed before remote execution

Approve one new empty, unbound D1 named `mhoo-dark-factory-recovery-mho219` in
account `faca04363f6ba617faedaae7d3493769`, including its exact resource/cost
scope, retention owner and permitted retained-backup data scope. Allocation and
import are separate checkpoints: record the newly returned UUID, independently
read back account/name/UUID/empty state, then bind the import approval to it.

The protected live ledger is `e76d5f65-a33c-41cf-9f82-622c1d53cf43`.
It is never an allowed destination. Reject missing UUIDs, any existing unrelated
DB, name-only target selection, changed identity or nonempty destination.
An automation, if later introduced, must enforce these refusals before remote
calls; this document and manifest do not implement an execution guard.

The backup's 59 webhook rows require classification by the existing authorized
custodian without printing their contents. No customer-data copy is authorized
by the current assignment. If this export includes customer data, stop and obtain
an explicit data-scope decision; substituting synthetic data cannot prove recovery
of this retained export. No fresh live-ledger export is included.

## Bounded procedure after those approvals only

1. Reuse any recovered identity-bound remote restore receipt before allocating.
   Verify current account inventory and allowance/cost scope. Create at most the
   single named destination; if identity or creation result is uncertain, stop
   and inspect rather than retrying creation. Keep it unbound and undiscoverable
   by Factory dispatch. Do not use the repository's live `wrangler.jsonc`.
2. Use a private scratch configuration containing only the exact account, one D1
   entry with binding `RECOVERY_DB`, approved database name/UUID, and a copied
   directory of the nine pinned migrations. No Worker entry point, routes,
   Queues, Workflow, Cron, DO, Sandbox, R2 binding or provider/publisher credentials.
   Inspect the configuration before each write phase; never deploy this config.
3. The authorized custodian retrieves only the exact retained object. Check size
   and SHA256 against `manifest.json` before import. Keep SQL and payloads private,
   outside Git/logs/model context. A mismatched export is not repaired or accepted.
4. Reconfirm the approved UUID is empty and is not the protected ledger. Import
   the SQL once using pinned Wrangler 4.128.0, explicit scratch config, binding
   `RECOVERY_DB`, `d1 execute --remote --file`. Retain timestamp, target UUID and
   sanitized result metadata. On failure preserve the partial target; no replay,
   overwrite, deletion or automatic cleanup follows an uncertain outcome.
5. Execute `before-migrations.sql` against that same approved UUID. Expect schema
   4 and precisely the four initial manifest migration names. Compare every
   original table's row count and canonical content digest with the custodian's
   existing local baseline. The public packet does not contain those row digests;
   obtain the private baseline before claiming full preservation. The 59-row
   historical webhook total alone is insufficient. No payload SELECTs in logs.
6. Run `d1 migrations list --remote` with the explicit scratch config. Require
   exactly the five manifest entries marked pending, in manifest order. Then
   `d1 migrations apply --remote` with that same binding/config. Do not apply
   individual SQL files directly and fabricate migration receipts afterward.
7. Execute `after-migrations.sql`. Require schema 7, all nine migration names,
   the allocation trigger and the two v2 transition triggers, ten REPLACE lanes,
   zero assignments/events/unexpected lane states. Require original rows and
   control flags unchanged except the intended schema-version update; migration
   ledger additions and seeded new tables are expected. Compare exact private
   table digests again. Record provider-supported integrity and foreign-key
   checks separately; any unsupported check remains unknown.
8. Record account/UUID/name, source SHA, nine migration hashes, backup digest,
   every import/migration/readback result, before/after invariants, observer/time
   and final unbound target identity. Publish only sanitized evidence and private
   evidence references. Leave the target quarantined for its approved retention;
   cleanup needs its own exact target authorization. Live ledger and R2 objects
   must remain unchanged. No live binding, traffic or disabled-flag change occurs.

CLI procedure checked against Cloudflare's
[D1 commands](https://developers.cloudflare.com/d1/wrangler-commands/) and
[import/export guidance](https://developers.cloudflare.com/d1/best-practices/import-export-data/)
on September 6. Revalidate the pinned CLI's help at execution time. No CLI install,
credential use, remote call or migration was performed to prepare this document.
The included SQL files are metadata readbacks, not restore or migration scripts.

## Remaining gates and their precise evidence

| Gate | Current limit | Next required evidence / owner |
| --- | --- | --- |
| Remote D1 recovery | Only retained-export LOCAL restore proved | Above approved destination/import/migration receipt; MHO219 owner |
| Current schema-7 backup | Pre-v7 backup is not a current-state snapshot | Separate approved current backup scope and restore identity; MHO219 owner |
| Binding authority | Source configuration and idle inventory do not prove intended/denied runtime access | Approved isolated runtime resource map plus positive read and negative wrong-identity/environment tests; MHO219 owner |
| Stop/rollback | Disabled flags and schema compatibility do not prove a runtime drill | Named isolated runtime with exact old/new source/config/schema artifacts, synthetic in-flight owner, stop rejection and stale-owner fence receipts, unchanged evidence and disabled final readback; MHO219 owner |
| Native executor | PR32/33 source/mock/policy only | Assigned non-serving guest, immutable runner, account-auth isolation, descendant cancellation, authenticated grant/quarantine, attempt/accounting and review linkage; MHO253 |
| Publisher and human-only merge | Protection/App metadata are partial evidence | Bind actual scoped installation used by publisher and approved denial tests; no live push/merge test under this packet |
| Factory alerts/cost | USD10 policy is a historical configuration observation; PR37 collection is source-only | Real Factory signals, independent watcher, effective budget/accounting policy and authorized delivery/acknowledgement receipt; MHO244 + owner |
| Source acceptance | PR31/32/33 remain open as checked for this increment | Independent human source acceptance; no merge by this task |

The binding/stop drill is a later authorization packet. Exact isolated Worker,
Queue/Workflow identities and approved runtime deployment do not yet exist in
this assignment. D1 import must not silently widen into that drill. Restoring an
old database over the live ledger is not a rollback strategy.

MHO244's current PR37 `a089e29b1bfbd2dc5a43bf6634f2c72fca681377` has successful
source CI per its September 6 comment. Its activation checkpoint targets fresh
Oracle monitoring and needs real producers/identity/delivery; it does not prove
Factory Queue/DLQ/Workflow/stop/backup health. Reuse that owner rather than adding
a competing monitor. MHO219 need not wait for unrelated Oracle backup work to
prepare or, once separately approved, perform its isolated D1 recovery.

## Validation of this increment

Only documentation, pinned metadata and read-only SQL were added. Verify manifest
paths/hashes against PR31, JSON syntax, SQL read-only behavior on synthetic schema,
local links and `git diff --check`. This is packet validation only: no repeated
serving bundle build, real backup restore, provider mutation, new runtime acceptance
or operational-readiness claim follows from it.

Native owner follow-up: [PR34](https://github.com/mhoo-os/dark-factory/pull/34)
adds source identity-coercion rejection above PR33. Its
`docs/NATIVE_CODEX_RUNTIME_PACKET.md` orders allocation, immutable guest, fake
canaries, teardown, separate login approval, then canonical grant/accounting/
publication proof. Passing synthetic/source checks does not replace any native
runtime gate above.
