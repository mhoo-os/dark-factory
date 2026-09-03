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

  it("keeps the none credential profile empty and reserves every independent capacity domain", () => {
    expect(__TEST_ONLY__.sandboxCredentials({ GITHUB_TOKEN: "must-not-leak", OPENROUTER_API_KEY: "must-not-leak" } as never, contract)).toEqual({});
    expect(__TEST_ONLY__.inherentEffectClasses(contract)).toEqual(["repository-write"]);
    expect(__TEST_ONLY__.capacityLeaseScopes({ repository: contract.target.repository, factory_id: registry.factory_id, collision_group: contract.target.collision_group } as never, { global: 1, factory: 2, repository: 3, collision: 4 })).toEqual([
      ["global:1"],
      ["factory:foundation-pilot:1", "factory:foundation-pilot:2"],
      ["repository:mhoo-os/dark-factory:1", "repository:mhoo-os/dark-factory:2", "repository:mhoo-os/dark-factory:3"],
      ["collision:dark-factory-runtime:1", "collision:dark-factory-runtime:2", "collision:dark-factory-runtime:3", "collision:dark-factory-runtime:4"],
    ]);
  });
});
