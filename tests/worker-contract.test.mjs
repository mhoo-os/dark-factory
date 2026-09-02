import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const config = JSON.parse(await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8"));
const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
const migration = await readFile(new URL("../migrations/0001_factory.sql", import.meta.url), "utf8");

test("production defaults keep the factory stopped", () => {
  assert.equal(config.vars.FACTORY_ENABLED, "false");
  assert.equal(config.vars.FACTORY_AUTONOMY, "0");
  assert.equal(config.vars.AUTO_MERGE, "false");
  assert.equal(config.vars.LINEAR_PROJECT_ID, "2dab9206-cb92-49a4-aeef-95ec45280098");
  assert.equal(config.vars.MAX_GLOBAL_CONCURRENCY, "1");
  assert.equal(config.vars.LINEAR_PROJECT_SLUG, undefined);
});

test("reviewable source binds the safety boundaries", () => {
  for (const marker of ["Linear-Signature", "factory:accepted", "mhoo-factory-dispatch:v1", "factory_ingress_events", "factory_leases", "ExecutionWorkflow", "getSandbox"]) {
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
});
