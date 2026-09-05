import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const config = JSON.parse(await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8"));
const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
const dispatchContractSchema = JSON.parse(await readFile(new URL("../factory/dispatch_contract.schema.json", import.meta.url), "utf8"));
const stateContract = JSON.parse(await readFile(new URL("../factory/state_contract.json", import.meta.url), "utf8"));
const migration = await readFile(new URL("../migrations/0001_factory.sql", import.meta.url), "utf8");
const retryMigration = await readFile(new URL("../migrations/0002_ingress-retry-state.sql", import.meta.url), "utf8");
const stateMigration = await readFile(new URL("../migrations/0003-state-history-and-active-issue.sql", import.meta.url), "utf8");
const dockerfile = await readFile(new URL("../Dockerfile", import.meta.url), "utf8");

test("production defaults keep the factory stopped", () => {
  assert.equal(config.vars.FACTORY_ENABLED, "false");
  assert.equal(config.vars.FACTORY_AUTONOMY, "0");
  assert.equal(config.vars.AUTO_MERGE, "false");
  assert.equal(config.vars.LINEAR_PROJECT_ID, "2dab9206-cb92-49a4-aeef-95ec45280098");
  assert.equal(config.vars.MAX_GLOBAL_CONCURRENCY, "1");
  assert.equal(config.vars.LINEAR_PROJECT_SLUG, undefined);
});

test("multiline Linear descriptions remain valid contract input", () => {
  assert.match(source, /function descriptionValue\(/);
  assert.match(source, /const source = descriptionValue\(description, "description", 100_000\)/);
  assert.doesNotMatch(source, /const source = text\(description, "description"/);
});

test("temporary dry-run authorization is sealed and rejected before durable ingress", () => {
  const authorization = dispatchContractSchema.properties.dry_run_authorization;
  assert.deepEqual(authorization.required, ["authorization_id", "mode", "non_executable", "expires_at", "checkout_head_sha"]);
  assert.equal(authorization.properties.mode.const, "approved-intake");
  assert.equal(authorization.properties.non_executable.const, true);
  assert.match(source, /const DRY_RUN_AUTHORIZATION_TTL_MS = 15 \* 60_000/);
  assert.match(source, /function dryRunContractReason\(/);
  assert.match(source, /function canonicalLinearIdentifier\(/);
  assert.match(source, /const LINEAR_MARKDOWN_ISSUE_LINK/);
  assert.match(source, /const LINEAR_RICH_ISSUE_LINK/);
  assert.match(source, /dry_run_authorization_non_executable/);
  const acceptLinear = source.slice(source.indexOf("async function acceptLinear"), source.indexOf("async function acceptGithub"));
  assert.ok(acceptLinear.indexOf("const dryRunReason = dryRunContractReason") < acceptLinear.indexOf("const receipt = await ingress"));
  assert.ok(acceptLinear.indexOf("const dryRunReason = dryRunContractReason") < acceptLinear.indexOf("env.EXECUTION_QUEUE.send(job)"));
});

test("reviewable source binds the safety boundaries", () => {
  for (const marker of ["Linear-Signature", "X-Hub-Signature-256", "factory:accepted", "mhoo-factory-dispatch:v1", "factory_ingress_events", "factory_leases", "ExecutionWorkflow", "getSandbox", "reconcileGithubEvent"]) {
    assert.match(source, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.match(source, /automatic_merge_must_be_disabled/);
  assert.match(source, /factory_disabled/);
});

test("durable migration has separate ingress, run, lease, and step state", () => {
  for (const table of ["factory_ingress_events", "factory_runs", "factory_leases", "factory_steps", "control_flags"]) {
    assert.match(migration, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
  }
  assert.match(migration, /INSERT OR IGNORE INTO control_flags/);
  assert.match(retryMigration, /ALTER TABLE factory_ingress_events ADD COLUMN updated_at/);
});

test("runtime state changes have append-only history and an atomic issue guard", () => {
  assert.match(stateMigration, /CREATE TABLE IF NOT EXISTS factory_transitions/);
  assert.match(stateMigration, /PRIMARY KEY \(dispatch_id, event_sequence\)/);
  assert.match(stateMigration, /CREATE UNIQUE INDEX IF NOT EXISTS factory_runs_active_issue_unique_idx/);
  assert.match(stateMigration, /WHERE current_state NOT IN \('not-admitted',\s*'failed',\s*'pr-merged',\s*'pr-canceled'\)/);
  assert.match(stateMigration, /VALUES \('factory-ledger', 3\)/);
  for (const marker of ["TRANSITION_ACTORS", "transitionRun", "state_transition_denied", "state_transition_raced", "lease_fenced"]) {
    assert.match(source, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.doesNotMatch(source, /UPDATE factory_runs SET current_state/);
});

test("worker actor permissions stay aligned with the canonical state contract", () => {
  const start = source.indexOf("const TRANSITION_ACTORS");
  const end = source.indexOf("};", start);
  assert.ok(start >= 0 && end > start);
  const actual = {};
  for (const line of source.slice(start, end).split("\n")) {
    const match = line.match(/"([^"]+)": \[(.*)\]/);
    if (match) actual[match[1]] = match[2].split(",").map((value) => value.trim().replaceAll('"', "")).filter(Boolean);
  }
  const expected = Object.fromEntries(stateContract.transitions.map((item) => [`${item.from}->${item.to}`, item.actors]));
  assert.deepEqual(actual, expected);
});

test("runtime carries the admitted identity through independent validation and publication", () => {
  for (const marker of ["FACTORY_CONTRACT_JSON", "GITHUB_TOKEN", "ground", "independent-validation", "independent-review", "publish-pr", "linear-receipt", "release-lease", "fetch --depth=1 origin"]) {
    assert.match(source, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.match(dockerfile, /apt-get install -y --no-install-recommends python3/);
  assert.match(source, /MAX_FIX_ATTEMPTS/);
});

test("PR reconciliation binds both head and base to the target repository", () => {
  assert.match(source, /function pullRequest\(value: unknown, expectedRepository: string\)/);
  assert.match(source, /headRepository !== expectedRepository/);
  assert.match(source, /baseRepository !== expectedRepository/);
  assert.match(source, /pullRequest\(value, job\.repository\)/);
});

test("Linear receipt lookup paginates and fails closed on an unbounded history", () => {
  assert.match(source, /comments\(first:50,after:\$after\)/);
  assert.match(source, /linear_receipts_pagination_invalid/);
  assert.match(source, /linear_receipts_pagination_limit/);
});

test("provider calls have an explicit timeout", () => {
  const timeouts = source.match(/signal: AbortSignal\.timeout\(PROVIDER_TIMEOUT_MS\)/g) ?? [];
  assert.equal(timeouts.length, 3);
});
