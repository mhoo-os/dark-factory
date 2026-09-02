# Deterministic scheduler and lease contract v1

`factory/scheduler.py` answers only which admitted work is eligible now. It
sorts by Linear priority, identifier, and dispatch identity, then applies state,
stop, retry, dependency, global-capacity, repository-capacity, and collision
checks. It never asks a model to choose work and it returns explicit blocking
reasons.

`factory/leases.py` uses a single serialized SQLite/D1 transaction as the
reference coordinator boundary. A run holds both its exact repository key and
all declared collision-group keys. Acquisition is all-or-nothing; active
owners deny competing acquisitions. Expiry increments a fence, and renew,
release, and state writers must present owner, dispatch identity, and fence.
Stale owners receive `lease_fenced` and cannot continue committing state.

The initial policy is one active run per repository and one global run unless a
human-reviewed configuration explicitly changes the caps. A run blocked on a
dependency or lease does not consume unrelated capacity. Durable Objects or an
equivalent strongly consistent coordinator remain required for the live
Cloudflare deployment; the SQLite implementation is the deterministic reference
and test double.
