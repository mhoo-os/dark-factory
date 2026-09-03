import { env } from "cloudflare:workers";
import { createExecutionContext, createMessageBatch, getQueueResult } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import worker, { __TEST_ONLY__ } from "../src/index";

const registry = {
  factory_id: "foundation-pilot",
  registry_version: "2026-09-03.1",
  registry_digest: `sha256:${"0".repeat(64)}`,
  entry_version: "1",
};
const runId = `run-v1-${"a".repeat(32)}`;
const dispatchId = "MHO-224@reviewed";
const contract = {
  contract_version: "v1",
  dispatch_id: dispatchId,
  linear: {
    project_id: "2dab9206-cb92-49a4-aeef-95ec45280098",
    issue_id: "issue-224",
    identifier: "MHO-224",
    planning_revision: "reviewed",
    planning_fingerprint: `sha256:${"1".repeat(64)}`,
  },
  target: {
    repository: "mhoo-os/dark-factory",
    work_type: "test",
    execution_profile: "python-tests-v1",
    collision_group: "dark-factory-runtime",
    base_sha: "a".repeat(40),
  },
  dependencies: [],
  risk: { risk_class: "low", authority_class: "repository-local" },
  acceptance_criteria: ["fails closed"],
  validation_profile: "python-tests-v1",
  allowed_scope: { paths: ["tests/**"], max_files: 1, max_changed_lines: 1 },
  merge_policy: "human",
  stale_conditions: ["planning_revision_changed"],
  factory_request: {
    credential_profile: "none",
    concurrency: 1,
    model_policy_key: "static:execution-default-v1",
    escalation_class: "human",
    effect_classes: [],
  },
  registry,
};

beforeAll(async () => {
  for (const statement of [
    `CREATE TABLE factory_runs (dispatch_id TEXT PRIMARY KEY, run_id TEXT UNIQUE, contract_digest TEXT, profile_digest TEXT, factory_id TEXT, registry_version TEXT, registry_digest TEXT, registry_entry_version TEXT, contract_json TEXT, linear_project_id TEXT, linear_issue_id TEXT, linear_identifier TEXT, repository TEXT, collision_group TEXT, base_sha TEXT, current_state TEXT, workflow_id TEXT, lease_owner TEXT, lease_fence INTEGER, lease_expires_at TEXT, branch TEXT, head_sha TEXT, pr_number INTEGER, pr_url TEXT, result_json TEXT, created_at TEXT, updated_at TEXT)`,
    `CREATE TABLE factory_events (event_id TEXT PRIMARY KEY, dispatch_id TEXT, event_sequence INTEGER, event_type TEXT, factory_id TEXT, registry_version TEXT, registry_digest TEXT, registry_entry_version TEXT, payload_digest TEXT, accepted INTEGER, reason TEXT, received_at TEXT)`,
    `CREATE TABLE factory_transitions (dispatch_id TEXT, event_sequence INTEGER, event_id TEXT, from_state TEXT, to_state TEXT, actor TEXT, factory_id TEXT, registry_version TEXT, registry_digest TEXT, registry_entry_version TEXT, created_at TEXT)`,
    `CREATE TABLE factory_leases (lease_key TEXT PRIMARY KEY, owner TEXT, dispatch_id TEXT, factory_id TEXT, registry_version TEXT, registry_digest TEXT, registry_entry_version TEXT, fence INTEGER, expires_at TEXT)`,
    `CREATE TABLE factory_lease_reservations (reservation_id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT, created_at TEXT)`,
    `CREATE TABLE factory_lease_members (reservation_id INTEGER, lease_key TEXT, PRIMARY KEY (reservation_id, lease_key))`,
  ]) await env.DB.prepare(statement).run();
  await env.DB.prepare(`INSERT INTO factory_runs(
    dispatch_id,run_id,contract_digest,profile_digest,factory_id,registry_version,registry_digest,registry_entry_version,
    contract_json,linear_project_id,linear_issue_id,linear_identifier,repository,collision_group,base_sha,current_state,
    created_at,updated_at
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
    dispatchId, runId, `sha256:${"2".repeat(64)}`, `sha256:${"3".repeat(64)}`,
    registry.factory_id, registry.registry_version, registry.registry_digest, registry.entry_version,
    JSON.stringify(contract), contract.linear.project_id, contract.linear.issue_id, contract.linear.identifier,
    contract.target.repository, contract.target.collision_group, contract.target.base_sha, "queued",
    new Date(0).toISOString(), new Date(0).toISOString(),
  ).run();
});

describe("local Worker control-plane behavior", () => {
  it("acknowledges a stale queued run after recording the legal needs-replan transition", async () => {
    const batch = createMessageBatch("mhoo-dark-factory-execution", [{
      id: "queued-stale-registry",
      timestamp: new Date(),
      attempts: 1,
      body: { kind: "dispatch", dispatchId, runId, contractDigest: `sha256:${"2".repeat(64)}`, contract },
    }]);
    const context = createExecutionContext();

    await worker.queue(batch, env);
    const result = await getQueueResult(batch, context);

    expect(result.explicitAcks).toEqual(["queued-stale-registry"]);
    const run = await env.DB.prepare("SELECT current_state,result_json FROM factory_runs WHERE run_id=?").bind(runId).first<{ current_state: string; result_json: string }>();
    expect(run).toMatchObject({ current_state: "needs-replan" });
    await expect(env.DB.prepare("SELECT from_state,to_state,actor FROM factory_transitions WHERE dispatch_id=?").bind(dispatchId).first()).resolves.toMatchObject({ from_state: "queued", to_state: "needs-replan", actor: "reconciler" });
  });

  it("keeps the none credential profile empty", () => {
    expect(__TEST_ONLY__.sandboxCredentials({ GITHUB_TOKEN: "must-not-leak", OPENROUTER_API_KEY: "must-not-leak" } as never, contract)).toEqual({});
    expect(__TEST_ONLY__.inherentEffectClasses(contract)).toEqual(["repository-write"]);
  });

  it("uses local D1 to contend, roll back partial claims, renew, and release all four capacity domains", async () => {
    const makeRun = (suffix: string) => ({
      run_id: `run-v1-${suffix.repeat(32)}`, factory_id: registry.factory_id, repository: contract.target.repository,
      collision_group: contract.target.collision_group, registry_version: registry.registry_version,
      registry_digest: registry.registry_digest, registry_entry_version: registry.entry_version,
      lease_fence: null, created_at: new Date().toISOString(),
    });
    const first = makeRun("b");
    const second = makeRun("c");
    for (const run of [first, second]) await env.DB.prepare("INSERT INTO factory_runs(dispatch_id,run_id,current_state,created_at,updated_at) VALUES(?,?,?,?,?)").bind(run.run_id, run.run_id, "queued", run.created_at, run.created_at).run();
    const oneEach = { global: 1, factory: 1, repository: 1, collision: 1 };
    const firstReservation = await __TEST_ONLY__.acquireLease(env.DB, first as never, oneEach);
    expect(firstReservation).toBeTypeOf("number");
    expect(await __TEST_ONLY__.acquireLease(env.DB, second as never, oneEach)).toBeNull();
    await expect(env.DB.prepare("SELECT COUNT(*) AS count FROM factory_leases WHERE dispatch_id=?").bind(first.run_id).first<{ count: number }>()).resolves.toMatchObject({ count: 4 });

    const rollback = makeRun("d");
    await env.DB.prepare("INSERT INTO factory_runs(dispatch_id,run_id,current_state,created_at,updated_at) VALUES(?,?,?,?,?)").bind(rollback.run_id, rollback.run_id, "queued", rollback.created_at, rollback.created_at).run();
    expect(await __TEST_ONLY__.acquireLease(env.DB, rollback as never, { global: 2, factory: 1, repository: 2, collision: 2 })).toBeNull();
    await expect(env.DB.prepare("SELECT COUNT(*) AS count FROM factory_leases WHERE dispatch_id=?").bind(rollback.run_id).first<{ count: number }>()).resolves.toMatchObject({ count: 0 });

    const held = { ...first, lease_fence: firstReservation as number };
    await env.DB.prepare("UPDATE factory_runs SET lease_fence=? WHERE run_id=?").bind(firstReservation, first.run_id).run();
    const before = await env.DB.prepare("SELECT MIN(expires_at) AS expiry FROM factory_leases WHERE dispatch_id=?").bind(first.run_id).first<{ expiry: string }>();
    await __TEST_ONLY__.renewLease(env.DB, held as never);
    const after = await env.DB.prepare("SELECT MIN(expires_at) AS expiry FROM factory_leases WHERE dispatch_id=?").bind(first.run_id).first<{ expiry: string }>();
    expect(Date.parse(after!.expiry)).toBeGreaterThanOrEqual(Date.parse(before!.expiry));
    await __TEST_ONLY__.releaseLease(env.DB, held as never);
    await expect(env.DB.prepare("SELECT COUNT(*) AS count FROM factory_leases WHERE dispatch_id=?").bind(first.run_id).first<{ count: number }>()).resolves.toMatchObject({ count: 0 });
    await expect(env.DB.prepare("SELECT COUNT(*) AS count FROM factory_lease_members WHERE reservation_id=?").bind(firstReservation).first<{ count: number }>()).resolves.toMatchObject({ count: 0 });
  });
});
