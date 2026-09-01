# Cloudflare control-plane MVP

This repository now contains a disabled-by-default Worker control plane for the Mhoo Dark Factory.

## Safety contract

- Linear admission requires a signed webhook, the configured project ID, the `factory:accepted` label, a live issue state, and a `Repository target: mhoo-os/<repo>` declaration.
- Every webhook delivery and Linear issue is idempotent in D1.
- Scheduling is deterministic: priority ascending, then creation time ascending.
- `repo_leases` permits one active execution per repository.
- Workflows use the execution ID as their instance ID, so retries cannot create a second run.
- The Sandbox adapter refuses to run until `SANDBOX_COMMAND` and `GITHUB_TOKEN` are configured.
- Automatic merge is hard-disabled in code and configuration.
- Stop/resume endpoints require the `FACTORY_ADMIN_SECRET` bearer token. A D1 stop flag is checked before admission and scheduling.

## First deployment

1. Create the D1 database, Queue, and Queue DLQ in Cloudflare, then replace `__SET_IN_CLOUDFLARE__` in `wrangler.jsonc` with the returned D1 ID.
2. Apply `migrations/0001_execution_ledger.sql` to the remote D1 database.
3. Set the four secrets from `.dev.vars.example` as Worker secrets. Never put values in `wrangler.jsonc` or Git.
4. Set `LINEAR_PROJECT_ID` to the Mhoo Dark Factory project UUID, or keep the checked-in `LINEAR_PROJECT_SLUG` if Linear webhook payloads include the project slug. Keep `FACTORY_ENABLED=false` and `FACTORY_AUTONOMY=0` until a signed webhook smoke test and a deliberate stop test pass.
5. Configure Linear and GitHub webhooks to `/webhooks/linear` and `/webhooks/github`, respectively, using the corresponding signing secrets.
6. Deploy the Worker and verify `/health` reports `automaticMerge: false` and `stopped: false` only after the stop control has been tested.

The first live issue should be a deliberately harmless, human-selected issue whose repository target has a bounded command such as `git status --short`. The command should be replaced only through an explicit reviewed configuration change.
