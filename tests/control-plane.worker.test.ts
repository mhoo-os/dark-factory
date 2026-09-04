import { env } from "cloudflare:workers";
import { createExecutionContext, createMessageBatch, getQueueResult } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import migration001 from "../migrations/0001_factory.sql?raw";
import migration002 from "../migrations/0002_ingress-retry-state.sql?raw";
import migration003 from "../migrations/0003-state-history-and-active-issue.sql?raw";
import migration004 from "../migrations/0004-trusted-factory-registry.sql?raw";
import migration005 from "../migrations/0005-runtime-capacity-leases.sql?raw";
import worker, { __TEST_ONLY__, ExecutionWorkflow } from "../src/index";

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

async function hmac(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return Array.from(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body))), (item) => item.toString(16).padStart(2, "0")).join("");
}

beforeAll(async () => {
  for (const migration of [migration001, migration002, migration003, migration004, migration005]) {
    for (const statement of migration.split(/;\s*(?:\r?\n|$)/).map((item) => item.trim()).filter(Boolean)) await env.DB.prepare(statement).run();
  }
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

  it("admits only registry-owned human, allowlisted authority and rejects broadened authority", async () => {
    const issue = {
      project: { id: contract.linear.project_id }, team: { id: "085d25a0-104f-4e80-82fb-b0ea7c476b0b" },
      state: { type: "started" }, labels: { nodes: [{ name: "factory:accepted" }] },
    };
    const binding = await __TEST_ONLY__.resolveFactory(issue as never, contract as never);
    expect(binding.identity.factory_id).toBe("foundation-pilot");
    await expect(__TEST_ONLY__.resolveFactory({ ...issue, labels: { nodes: [] } } as never, contract as never)).rejects.toThrow("registry_required_label_missing");
    const deployment = { ...contract, factory_request: { ...contract.factory_request, effect_classes: ["deployment"] } };
    await expect(__TEST_ONLY__.resolveFactory(issue as never, deployment as never)).rejects.toThrow("registry_effect_class_not_permitted");
    const automatic = { ...contract, merge_policy: "auto-eligible" };
    await expect(__TEST_ONLY__.resolveFactory(issue as never, automatic as never)).rejects.toThrow("registry_merge_ceiling_exceeded");
    const policyDrift = { ...contract, factory_request: { ...contract.factory_request, model_policy_key: "static:unapproved-v1" } };
    await expect(__TEST_ONLY__.resolveFactory(issue as never, policyDrift as never)).rejects.toThrow("registry_model_policy_not_allowed");
  });

  it("binds execution to the canonical OpenRouter model receipt and configured spend ceiling", () => {
    const receipt = { status: "passed", reason: "ok", branch: "factory/mho-224-run-v1-aaaaaaaaaaaa", head_sha: "a".repeat(40), cost_usd: 0.4, provider_usage: { provider: "openrouter", model: "z-ai/glm-5.3-flash", generation_id: "gen-provider-issued-123", provider_created_at: 1_725_000_000, prompt_tokens: 10, completion_tokens: 20, total_tokens: 30, cost_usd: 0.4 } };
    expect(__TEST_ONLY__.agentResult(receipt)).toMatchObject({ cost_usd: 0.4 });
    expect(() => __TEST_ONLY__.agentResult({ ...receipt, provider_usage: { ...receipt.provider_usage, cost_usd: 0.3 } })).toThrow("agent_provider_cost_mismatch");
    expect(() => __TEST_ONLY__.agentResult({ ...receipt, provider_usage: { ...receipt.provider_usage, provider: "other" } })).toThrow("agent_provider_usage_invalid");
    expect(() => __TEST_ONLY__.agentResult({ ...receipt, provider_usage: { ...receipt.provider_usage, generation_id: "" } })).toThrow("agent_provider_usage_invalid");
    expect(__TEST_ONLY__.canonicalModel(contract as never)).toEqual({ policyKey: "static:execution-default-v1", provider: "openrouter", model: "z-ai/glm-5.3-flash", version: "2026-09-03", outputTokenUsd: 0.001, requestOverheadUsd: 0.5 });
    expect(__TEST_ONLY__.providerReceiptMatchesCanonical(receipt.provider_usage, __TEST_ONLY__.canonicalModel(contract as never))).toBe(true);
    expect(__TEST_ONLY__.providerReceiptMatchesCanonical({ ...receipt.provider_usage, model: "provider-drift" }, __TEST_ONLY__.canonicalModel(contract as never))).toBe(false);
    expect(() => __TEST_ONLY__.canonicalModel({ ...contract, factory_request: { ...contract.factory_request, model_policy_key: "static:drift-v1" } } as never)).toThrow("registry_model_policy_not_canonical");
    expect(__TEST_ONLY__.runtimeExecutionLimits({ MAX_COST_USD: "1" } as never, contract as never).costUsd).toBe(1);
    expect(() => __TEST_ONLY__.runtimeExecutionLimits({ MAX_COST_USD: "9" } as never, contract as never)).toThrow("cost_cap_config_invalid");
  });

  it("accepts exactly one signed GitHub reconciliation webhook and rejects unsigned control-plane input", async () => {
    const raw = JSON.stringify({
      action: "synchronize", repository: { full_name: contract.target.repository },
      pull_request: { number: 41, body: `<!-- mhoo-dark-factory-run:v1 run=${runId} -->` },
    });
    const secret = "webhook-test-secret";
    const sent: unknown[] = [];
    const webhookEnv = Object.assign(Object.create(env), {
      GITHUB_WEBHOOK_SECRET: secret,
      EXECUTION_QUEUE: { send: async (job: unknown) => { sent.push(job); } },
    });
    const request = () => new Request("https://control.test/webhooks/github", {
      method: "POST",
      headers: { "X-Hub-Signature-256": `sha256=${awaitedSignature}`, "X-GitHub-Event": "pull_request", "X-GitHub-Delivery": "delivery-authority-1" },
      body: raw,
    });
    const awaitedSignature = await hmac(secret, raw);
    await expect(worker.fetch(request(), webhookEnv as never)).resolves.toMatchObject({ status: 202 });
    await expect(worker.fetch(request(), webhookEnv as never)).resolves.toMatchObject({ status: 200 });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ kind: "github-reconciliation", runId, repository: contract.target.repository, prNumber: 41 });
    await expect(worker.fetch(new Request("https://control.test/webhooks/github", { method: "POST", body: raw }), webhookEnv as never)).resolves.toMatchObject({ status: 401 });
    await expect(env.DB.prepare("SELECT handoff_state FROM factory_ingress_events WHERE provider='github' AND event_type='pull_request' ORDER BY received_at DESC LIMIT 1").first()).resolves.toMatchObject({ handoff_state: "enqueued" });
  });

  it("requires the admin bearer to change the protected stop control", async () => {
    const controlEnv = Object.assign(Object.create(env), { FACTORY_ADMIN_SECRET: "admin-test-secret" });
    await expect(worker.fetch(new Request("https://control.test/controls/stop", { method: "POST" }), controlEnv as never)).resolves.toMatchObject({ status: 403 });
    const stop = await worker.fetch(new Request("https://control.test/controls/stop", { method: "POST", headers: { Authorization: "Bearer admin-test-secret" } }), controlEnv as never);
    expect(await stop.json()).toEqual({ stopped: true });
    const resume = await worker.fetch(new Request("https://control.test/controls/resume", { method: "POST", headers: { Authorization: "Bearer admin-test-secret" } }), controlEnv as never);
    expect(await resume.json()).toEqual({ stopped: false });
  });

  it("publishes only a human-review PR with an auditable no-auto-merge marker", async () => {
    const binding = await __TEST_ONLY__.resolveFactory({ project: { id: contract.linear.project_id }, team: { id: "085d25a0-104f-4e80-82fb-b0ea7c476b0b" }, state: { type: "started" }, labels: { nodes: [{ name: "factory:accepted" }] } } as never, contract as never);
    const publicationContract = { ...contract, dispatch_id: "MHO-224@publication", linear: { ...contract.linear, issue_id: "issue-publication", identifier: "MHO-228" }, registry: binding.identity };
    const job = { kind: "dispatch", dispatchId: publicationContract.dispatch_id, runId: `run-v1-${"4".repeat(32)}`, contractDigest: await __TEST_ONLY__.digest(publicationContract), contract: publicationContract };
    const agent = { status: "passed", reason: "ok", branch: "factory/mho-228-publication", head_sha: "b".repeat(40), cost_usd: 0.4, provider_usage: { provider: "openrouter", model: "z-ai/glm-5.3-flash", generation_id: "gen-publication", provider_created_at: 1_725_000_000, prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cost_usd: 0.4 } };
    const requests: Array<{ url: string; method: string; body: string }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      requests.push({ url, method: init?.method ?? "GET", body: typeof init?.body === "string" ? init.body : "" });
      if (url.endsWith("/repos/mhoo-os/dark-factory")) return Response.json({ default_branch: "main" });
      if (url.endsWith("/repos/mhoo-os/dark-factory/branches/main")) return Response.json({ commit: { sha: publicationContract.target.base_sha } });
      if (url.includes("/pulls?state=all")) return Response.json([]);
      return Response.json({ number: 77, html_url: "https://github.com/mhoo-os/dark-factory/pull/77", state: "open", merged: false, head: { ref: agent.branch, sha: agent.head_sha, repo: { full_name: contract.target.repository } }, base: { ref: "main", sha: publicationContract.target.base_sha, repo: { full_name: contract.target.repository } } });
    };
    try {
      await expect(__TEST_ONLY__.publishPullRequest({ GITHUB_TOKEN: "test-token" } as never, job as never, agent as never)).resolves.toMatchObject({ number: 77 });
      expect(requests.at(-1)).toMatchObject({ method: "POST" });
      expect(requests.at(-1)?.body).toContain("Automatic merge is disabled; human review is required.");
      expect(requests.at(-1)?.body).toContain(`run=${job.runId}`);
      await expect(__TEST_ONLY__.publishPullRequest({ GITHUB_TOKEN: "test-token" } as never, { ...job, contract: { ...publicationContract, merge_policy: "auto-eligible" } } as never, agent as never)).rejects.toThrow("registry_merge_ceiling_exceeded");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("isolates global, factory, repository, and collision D1 capacity ceilings through migrations 0004/0005", async () => {
    const makeRun = (suffix: string, factory = registry.factory_id, repository = contract.target.repository, collision = contract.target.collision_group) => ({
      run_id: `run-v1-${suffix.repeat(32)}`, factory_id: factory, repository, collision_group: collision, registry_version: registry.registry_version,
      registry_digest: registry.registry_digest, registry_entry_version: registry.entry_version,
      lease_fence: null, created_at: new Date().toISOString(),
    });
    const add = async (run: ReturnType<typeof makeRun>) => env.DB.prepare("INSERT INTO factory_runs(dispatch_id,run_id,contract_digest,profile_digest,factory_id,registry_version,registry_digest,registry_entry_version,contract_json,linear_project_id,linear_issue_id,linear_identifier,repository,collision_group,base_sha,current_state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").bind(run.run_id, run.run_id, "digest", "profile", run.factory_id, run.registry_version, run.registry_digest, run.registry_entry_version, JSON.stringify(contract), "project", `${run.run_id}-issue`, run.run_id, run.repository, run.collision_group, contract.target.base_sha, "queued", run.created_at, run.created_at).run();
    const release = async (run: ReturnType<typeof makeRun>, reservation: number) => {
      const held = { ...run, lease_fence: reservation };
      await env.DB.prepare("UPDATE factory_runs SET lease_fence=? WHERE run_id=?").bind(reservation, run.run_id).run();
      await __TEST_ONLY__.releaseLease(env.DB, held as never);
    };
    const cases = [
      { name: "global", first: makeRun("b", "factory-a", "repo-a", "collision-a"), blocked: makeRun("c", "factory-b", "repo-b", "collision-b"), limits: { global: 1, factory: 2, repository: 2, collision: 2 } },
      { name: "factory", first: makeRun("d", "factory-c", "repo-c", "collision-c"), blocked: makeRun("e", "factory-c", "repo-d", "collision-d"), limits: { global: 2, factory: 1, repository: 2, collision: 2 } },
      { name: "repository", first: makeRun("f", "factory-d", "repo-e", "collision-e"), blocked: makeRun("g", "factory-e", "repo-e", "collision-f"), limits: { global: 2, factory: 2, repository: 1, collision: 2 } },
      { name: "collision", first: makeRun("h", "factory-f", "repo-f", "collision-g"), blocked: makeRun("i", "factory-g", "repo-g", "collision-g"), limits: { global: 2, factory: 2, repository: 2, collision: 1 } },
    ];
    for (const item of cases) {
      await add(item.first); await add(item.blocked);
      const reservation = await __TEST_ONLY__.acquireLease(env.DB, item.first as never, item.limits);
      expect(reservation?.fence, item.name).toBeTypeOf("number");
      expect(await __TEST_ONLY__.acquireLease(env.DB, item.blocked as never, item.limits), item.name).toBeNull();
      await expect(env.DB.prepare("SELECT COUNT(*) AS count FROM factory_leases WHERE dispatch_id=?").bind(item.blocked.run_id).first<{ count: number }>()).resolves.toMatchObject({ count: 0 });
      await release(item.first, reservation?.fence as number);
    }
  });

  it("renews a live D1 reservation, fences expiry takeovers, and removes every exact lease member", async () => {
    const makeRun = (suffix: string) => ({
      run_id: `run-v1-${suffix.repeat(32)}`, factory_id: "lease-factory", repository: "lease-repository", collision_group: "lease-collision",
      registry_version: registry.registry_version, registry_digest: registry.registry_digest, registry_entry_version: registry.entry_version,
      lease_fence: null, created_at: new Date().toISOString(),
    });
    const add = async (run: ReturnType<typeof makeRun>) => env.DB.prepare("INSERT INTO factory_runs(dispatch_id,run_id,contract_digest,profile_digest,factory_id,registry_version,registry_digest,registry_entry_version,contract_json,linear_project_id,linear_issue_id,linear_identifier,repository,collision_group,base_sha,current_state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").bind(run.run_id, run.run_id, "digest", "profile", run.factory_id, run.registry_version, run.registry_digest, run.registry_entry_version, JSON.stringify(contract), "project", `${run.run_id}-issue`, run.run_id, run.repository, run.collision_group, contract.target.base_sha, "queued", run.created_at, run.created_at).run();
    const limits = { global: 1, factory: 1, repository: 1, collision: 1 };
    const original = makeRun("j");
    const successor = makeRun("k");
    await add(original); await add(successor);
    const originalFence = await __TEST_ONLY__.acquireLease(env.DB, original as never, limits);
    expect(originalFence?.fence).toBeTypeOf("number");
    const heldOriginal = { ...original, lease_fence: originalFence?.fence as number };
    await env.DB.prepare("UPDATE factory_runs SET lease_fence=? WHERE run_id=?").bind(originalFence?.fence, original.run_id).run();
    await __TEST_ONLY__.renewLeaseWithinRunDeadline(env.DB, heldOriginal as never, { timeoutSeconds: 60 });
    const liveExpiry = await env.DB.prepare("SELECT lease_expires_at FROM factory_runs WHERE run_id=?").bind(original.run_id).first<{ lease_expires_at: string }>();
    expect(Date.parse(liveExpiry?.lease_expires_at ?? "")).toBeGreaterThan(Date.now());
    expect(Date.parse(liveExpiry?.lease_expires_at ?? "")).toBeLessThanOrEqual(Date.parse(original.created_at) + 60_000);
    await env.DB.prepare("UPDATE factory_leases SET expires_at=? WHERE dispatch_id=?").bind(new Date(0).toISOString(), original.run_id).run();
    const successorFence = await __TEST_ONLY__.acquireLease(env.DB, successor as never, limits);
    expect(successorFence?.fence).toBeTypeOf("number");
    const heldSuccessor = { ...successor, lease_fence: successorFence?.fence as number };
    await env.DB.prepare("UPDATE factory_runs SET lease_fence=? WHERE run_id=?").bind(successorFence?.fence, successor.run_id).run();
    await expect(__TEST_ONLY__.renewLease(env.DB, heldOriginal as never)).rejects.toThrow("lease_fenced");
    await __TEST_ONLY__.renewLease(env.DB, heldSuccessor as never);
    await __TEST_ONLY__.releaseLease(env.DB, heldSuccessor as never);
    await expect(env.DB.prepare("SELECT COUNT(*) AS count FROM factory_leases WHERE dispatch_id=?").bind(successor.run_id).first<{ count: number }>()).resolves.toMatchObject({ count: 0 });
    await expect(env.DB.prepare("SELECT COUNT(*) AS count FROM factory_lease_members WHERE reservation_id=?").bind(successorFence?.fence).first<{ count: number }>()).resolves.toMatchObject({ count: 0 });
    await expect(env.DB.prepare("SELECT lease_owner,lease_fence,lease_expires_at FROM factory_runs WHERE run_id=?").bind(successor.run_id).first()).resolves.toMatchObject({ lease_owner: null, lease_fence: null, lease_expires_at: null });
  });

  it("terminalizes a failed authority workflow and releases every D1 lease member", async () => {
    const binding = await __TEST_ONLY__.resolveFactory({ project: { id: contract.linear.project_id }, team: { id: "085d25a0-104f-4e80-82fb-b0ea7c476b0b" }, state: { type: "started" }, labels: { nodes: [{ name: "factory:accepted" }] } } as never, contract as never);
    const workflowContract = { ...contract, dispatch_id: "MHO-224@workflow-cleanup", linear: { ...contract.linear, issue_id: "issue-workflow-cleanup", identifier: "MHO-229" }, registry: binding.identity };
    const workflowRunId = `run-v1-${"5".repeat(32)}`;
    const digest = await __TEST_ONLY__.digest(workflowContract);
    const profile = await __TEST_ONLY__.profileDigest(workflowContract);
    const createdAt = new Date().toISOString();
    await env.DB.prepare("INSERT INTO factory_runs(dispatch_id,run_id,contract_digest,profile_digest,factory_id,registry_version,registry_digest,registry_entry_version,contract_json,linear_project_id,linear_issue_id,linear_identifier,repository,collision_group,base_sha,current_state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").bind(workflowContract.dispatch_id, workflowRunId, digest, profile, binding.identity.factory_id, binding.identity.registry_version, binding.identity.registry_digest, binding.identity.entry_version, JSON.stringify(workflowContract), workflowContract.linear.project_id, workflowContract.linear.issue_id, workflowContract.linear.identifier, workflowContract.target.repository, workflowContract.target.collision_group, workflowContract.target.base_sha, "queued", createdAt, createdAt).run();
    const lease = await __TEST_ONLY__.acquireLease(env.DB, { run_id: workflowRunId, factory_id: binding.identity.factory_id, repository: workflowContract.target.repository, collision_group: workflowContract.target.collision_group, registry_version: binding.identity.registry_version, registry_digest: binding.identity.registry_digest, registry_entry_version: binding.identity.entry_version, lease_fence: null, created_at: createdAt } as never, { global: 1, factory: 1, repository: 1, collision: 1 });
    await env.DB.prepare("UPDATE factory_runs SET current_state='running',lease_owner='workflow',lease_fence=?,lease_expires_at=? WHERE run_id=?").bind(lease?.fence, lease?.expiresAt, workflowRunId).run();
    const steps: string[] = [];
    const step = { do: async (name: string, _options: unknown, callback: () => Promise<unknown>) => { steps.push(name); return await callback(); } };
    const instance = Object.create(ExecutionWorkflow.prototype) as ExecutionWorkflow;
    Object.defineProperty(instance, "env", { value: Object.assign(Object.create(env), { MAX_COST_USD: "8", MAX_FIX_ATTEMPTS: "0", OPENROUTER_MODEL: "z-ai/glm-5.3-flash" }) });
    await expect(instance.run({ payload: { kind: "dispatch", dispatchId: workflowContract.dispatch_id, runId: workflowRunId, contractDigest: digest, contract: workflowContract } } as never, step as never)).resolves.toMatchObject({ status: "needs-human", reason: "workflow_step_failed" });
    expect(steps).toEqual(expect.arrayContaining(["ground", "finalize", "release-lease"]));
    await expect(env.DB.prepare("SELECT current_state,lease_fence FROM factory_runs WHERE run_id=?").bind(workflowRunId).first()).resolves.toMatchObject({ current_state: "needs-human", lease_fence: null });
    await expect(env.DB.prepare("SELECT COUNT(*) AS count FROM factory_leases WHERE dispatch_id=?").bind(workflowRunId).first<{ count: number }>()).resolves.toMatchObject({ count: 0 });
  });

  it("reconciles a registered human-review PR and writes one Linear receipt", async () => {
    const binding = await __TEST_ONLY__.resolveFactory({ project: { id: contract.linear.project_id }, team: { id: "085d25a0-104f-4e80-82fb-b0ea7c476b0b" }, state: { type: "started" }, labels: { nodes: [{ name: "factory:accepted" }] } } as never, contract as never);
    const reconciliationContract = { ...contract, dispatch_id: "MHO-230@reviewed", linear: { ...contract.linear, issue_id: "issue-reconciliation", identifier: "MHO-230" }, registry: binding.identity };
    const reconciliationRunId = `run-v1-${"6".repeat(32)}`;
    const headSha = "c".repeat(40);
    const branch = `factory/mho-230-${reconciliationRunId.slice(-12)}`;
    const contractDigest = await __TEST_ONLY__.digest(reconciliationContract);
    const profile = await __TEST_ONLY__.profileDigest(reconciliationContract);
    const createdAt = new Date().toISOString();
    await env.DB.prepare("INSERT INTO factory_runs(dispatch_id,run_id,contract_digest,profile_digest,factory_id,registry_version,registry_digest,registry_entry_version,contract_json,linear_project_id,linear_issue_id,linear_identifier,repository,collision_group,base_sha,current_state,branch,head_sha,pr_number,pr_url,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").bind(reconciliationContract.dispatch_id, reconciliationRunId, contractDigest, profile, binding.identity.factory_id, binding.identity.registry_version, binding.identity.registry_digest, binding.identity.entry_version, JSON.stringify(reconciliationContract), reconciliationContract.linear.project_id, reconciliationContract.linear.issue_id, reconciliationContract.linear.identifier, reconciliationContract.target.repository, reconciliationContract.target.collision_group, reconciliationContract.target.base_sha, "pr-open", branch, headSha, 88, "https://github.com/mhoo-os/dark-factory/pull/88", createdAt, createdAt).run();
    const { registry: _registry, ...planningContract } = reconciliationContract;
    const issue = { id: reconciliationContract.linear.issue_id, identifier: reconciliationContract.linear.identifier, description: `<!-- mhoo-factory-dispatch:v1 -->\n${JSON.stringify(planningContract)}\n<!-- /mhoo-factory-dispatch:v1 -->`, project: { id: reconciliationContract.linear.project_id }, team: { id: "085d25a0-104f-4e80-82fb-b0ea7c476b0b" }, state: { type: "started" }, labels: { nodes: [{ name: "factory:accepted" }] } };
    const pull = { number: 88, html_url: "https://github.com/mhoo-os/dark-factory/pull/88", state: "open", merged: false, head: { ref: branch, sha: headSha, repo: { full_name: reconciliationContract.target.repository } }, base: { ref: "main", sha: reconciliationContract.target.base_sha, repo: { full_name: reconciliationContract.target.repository } } };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith("/pulls/88")) return Response.json(pull);
      if (url === "https://api.linear.app/graphql") {
        const request = JSON.parse(String(init?.body));
        if (request.query.includes("comments(first:50")) return Response.json({ data: { issue: { comments: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } });
        if (request.query.includes("commentCreate")) return Response.json({ data: { commentCreate: { success: true } } });
        return Response.json({ data: { issue } });
      }
      throw new Error(`unexpected request ${url}`);
    };
    try {
      await expect(__TEST_ONLY__.reconcileGithubEvent({ DB: env.DB, GITHUB_TOKEN: "github-test", LINEAR_API_KEY: "linear-test" } as never, { kind: "github-reconciliation", eventId: "reconcile-authority-1", runId: reconciliationRunId, repository: reconciliationContract.target.repository, prNumber: 88, action: "synchronize" } as never)).resolves.toBe("processed");
      await expect(env.DB.prepare("SELECT current_state,head_sha,pr_number FROM factory_runs WHERE run_id=?").bind(reconciliationRunId).first()).resolves.toMatchObject({ current_state: "pr-open", head_sha: headSha, pr_number: 88 });
      await expect(env.DB.prepare("SELECT status FROM factory_steps WHERE run_id=? AND step_key='reconciliation'").bind(reconciliationRunId).first()).resolves.toMatchObject({ status: "pr-open" });
      await expect(env.DB.prepare("SELECT COUNT(*) AS count FROM factory_linear_reconciliations WHERE run_id=?").bind(reconciliationRunId).first<{ count: number }>()).resolves.toMatchObject({ count: 1 });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("rejects expired workflow callbacks and bounds terminal cleanup separately", () => {
    const expired = { created_at: new Date(Date.now() - 2_000).toISOString() };
    expect(() => __TEST_ONLY__.remainingRunSeconds(expired as never, { timeoutSeconds: 1 })).toThrow("workflow_deadline_exceeded");
    const cleanup = { created_at: new Date(Date.now() - 1_005_000).toISOString() };
    expect(__TEST_ONLY__.terminalCleanupSeconds(cleanup as never, { timeoutSeconds: 1_000 })).toBeLessThanOrEqual(30);
    const exhaustedCleanup = { created_at: new Date(Date.now() - 1_031_000).toISOString() };
    expect(() => __TEST_ONLY__.terminalCleanupSeconds(exhaustedCleanup as never, { timeoutSeconds: 1_000 })).toThrow("terminal_cleanup_deadline_exceeded");
  });

  it("does not enter an expired callback or renew its lease", async () => {
    let callbackRan = false;
    const observedSteps: Array<{ name: string; options: { retries: { limit: number }; timeout: string } }> = [];
    const fakeStep = { do: async (name: string, options: { retries: { limit: number }; timeout: string }, callback: () => Promise<string>) => { observedSteps.push({ name, options }); return await callback(); } };
    const live = { created_at: new Date().toISOString() };
    await expect(__TEST_ONLY__.activeWorkflowStep(fakeStep as never, "live-callback", live as never, { timeoutSeconds: 30 } as never, async () => "ran")).resolves.toBe("ran");
    expect(observedSteps).toMatchObject([{ name: "live-callback", options: { retries: { limit: 0 } } }]);
    const expired = { created_at: new Date(Date.now() - 2_000).toISOString() };
    await expect(__TEST_ONLY__.activeWorkflowStep(fakeStep as never, "expired-callback", expired as never, { timeoutSeconds: 1 } as never, async () => {
      callbackRan = true;
      return "should-not-run";
    })).rejects.toThrow("workflow_deadline_exceeded");
    expect(callbackRan).toBe(false);

    const run = { run_id: `run-v1-${"l".repeat(32)}`, factory_id: "deadline-factory", repository: "deadline-repository", collision_group: "deadline-collision", registry_version: registry.registry_version, registry_digest: registry.registry_digest, registry_entry_version: registry.entry_version, lease_fence: null, created_at: new Date().toISOString() };
    await env.DB.prepare("INSERT INTO factory_runs(dispatch_id,run_id,contract_digest,profile_digest,factory_id,registry_version,registry_digest,registry_entry_version,contract_json,linear_project_id,linear_issue_id,linear_identifier,repository,collision_group,base_sha,current_state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").bind(run.run_id, run.run_id, "digest", "profile", run.factory_id, run.registry_version, run.registry_digest, run.registry_entry_version, JSON.stringify(contract), "project", `${run.run_id}-issue`, run.run_id, run.repository, run.collision_group, contract.target.base_sha, "queued", run.created_at, run.created_at).run();
    const fence = await __TEST_ONLY__.acquireLease(env.DB, run as never, { global: 1, factory: 1, repository: 1, collision: 1 });
    const held = { ...run, lease_fence: fence?.fence as number };
    const before = await env.DB.prepare("SELECT expires_at FROM factory_leases WHERE dispatch_id=? LIMIT 1").bind(run.run_id).first<{ expires_at: string }>();
    await expect(__TEST_ONLY__.renewLeaseWithinRunDeadline(env.DB, { ...held, created_at: new Date(Date.now() - 2_000).toISOString() } as never, { timeoutSeconds: 1 })).rejects.toThrow("workflow_deadline_exceeded");
    await expect(env.DB.prepare("SELECT expires_at FROM factory_leases WHERE dispatch_id=? LIMIT 1").bind(run.run_id).first<{ expires_at: string }>()).resolves.toEqual(before);
    await __TEST_ONLY__.releaseLease(env.DB, held as never);
  });

  it("schedules only a live queued job, persists its capped initial expiry, and leaves an expired job lease-free", async () => {
    const issue = {
      project: { id: contract.linear.project_id }, team: { id: "085d25a0-104f-4e80-82fb-b0ea7c476b0b" },
      state: { type: "started" }, labels: { nodes: [{ name: "factory:accepted" }] },
    };
    const binding = await __TEST_ONLY__.resolveFactory(issue as never, contract as never);
    const schedulerEnv = Object.assign(Object.create(env), {
      FACTORY_ENABLED: "true", FACTORY_AUTONOMY: "1", MAX_COST_USD: "8", MAX_GLOBAL_CONCURRENCY: "1",
      EXECUTION_WORKFLOW: { create: async () => ({ id: "local-workflow" }) },
    });
    const add = async (suffix: string, createdAt: string) => {
      const dispatch = `MHO-224@scheduler-${suffix}`;
      const runId = `run-v1-${suffix.repeat(32)}`;
      const liveContract = { ...contract, dispatch_id: dispatch, linear: { ...contract.linear, issue_id: `issue-scheduler-${suffix}`, identifier: `MHO-${suffix === "0" ? "225" : "226"}` }, registry: binding.identity };
      const contractDigest = await __TEST_ONLY__.digest(liveContract);
      const profileDigest = await __TEST_ONLY__.profileDigest(liveContract);
      await env.DB.prepare("INSERT INTO factory_runs(dispatch_id,run_id,contract_digest,profile_digest,factory_id,registry_version,registry_digest,registry_entry_version,contract_json,linear_project_id,linear_issue_id,linear_identifier,repository,collision_group,base_sha,current_state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").bind(dispatch, runId, contractDigest, profileDigest, binding.identity.factory_id, binding.identity.registry_version, binding.identity.registry_digest, binding.identity.entry_version, JSON.stringify(liveContract), liveContract.linear.project_id, liveContract.linear.issue_id, liveContract.linear.identifier, liveContract.target.repository, liveContract.target.collision_group, liveContract.target.base_sha, "queued", createdAt, createdAt).run();
      return { dispatch, runId, contract: liveContract, contractDigest, createdAt };
    };
    const live = await add("0", new Date().toISOString());
    await expect(__TEST_ONLY__.schedule(schedulerEnv as never, { kind: "dispatch", dispatchId: live.dispatch, runId: live.runId, contractDigest: live.contractDigest, contract: live.contract })).resolves.toBe("dispatched");
    const leased = await env.DB.prepare("SELECT lease_fence,lease_expires_at FROM factory_runs WHERE run_id=?").bind(live.runId).first<{ lease_fence: number; lease_expires_at: string }>();
    const lease = await env.DB.prepare("SELECT expires_at FROM factory_leases WHERE dispatch_id=? LIMIT 1").bind(live.runId).first<{ expires_at: string }>();
    expect(leased?.lease_expires_at).toBe(lease?.expires_at);
    expect(Date.parse(leased?.lease_expires_at ?? "")).toBeLessThanOrEqual(Date.parse(live.createdAt) + 900_000);
    await __TEST_ONLY__.releaseLease(env.DB, { ...(await env.DB.prepare("SELECT dispatch_id,run_id,contract_digest,profile_digest,factory_id,registry_version,registry_digest,registry_entry_version,contract_json,linear_issue_id,repository,collision_group,base_sha,current_state,workflow_id,lease_owner,lease_fence,lease_expires_at,branch,head_sha,pr_number,pr_url,created_at FROM factory_runs WHERE run_id=?").bind(live.runId).first()), lease_fence: leased?.lease_fence } as never);
    await expect(env.DB.prepare("SELECT COUNT(*) AS count FROM factory_leases WHERE dispatch_id=?").bind(live.runId).first<{ count: number }>()).resolves.toMatchObject({ count: 0 });

    const expired = await add("1", new Date(Date.now() - 901_000).toISOString());
    await expect(__TEST_ONLY__.schedule(schedulerEnv as never, { kind: "dispatch", dispatchId: expired.dispatch, runId: expired.runId, contractDigest: expired.contractDigest, contract: expired.contract })).resolves.toBe("needs-human");
    await expect(env.DB.prepare("SELECT current_state,result_json FROM factory_runs WHERE run_id=?").bind(expired.runId).first<{ current_state: string; result_json: string }>()).resolves.toMatchObject({ current_state: "needs-human" });
    await expect(env.DB.prepare("SELECT COUNT(*) AS count FROM factory_leases WHERE dispatch_id=?").bind(expired.runId).first<{ count: number }>()).resolves.toMatchObject({ count: 0 });
    await expect(env.DB.prepare("SELECT COUNT(*) AS count FROM factory_lease_reservations WHERE run_id=?").bind(expired.runId).first<{ count: number }>()).resolves.toMatchObject({ count: 0 });
  });

  it("fences a deterministic deadline expiry during D1 acquisition before Workflow creation", async () => {
    const now = new Date("2030-01-01T00:00:00.000Z");
      const issue = {
        project: { id: contract.linear.project_id }, team: { id: "085d25a0-104f-4e80-82fb-b0ea7c476b0b" },
        state: { type: "started" }, labels: { nodes: [{ name: "factory:accepted" }] },
      };
      const binding = await __TEST_ONLY__.resolveFactory(issue as never, contract as never);
      const createdAt = new Date(now.getTime() - 899_000).toISOString();
      const deadline = now.getTime() + 1_000;
      let clock = now.getTime();
      const dispatch = "MHO-224@scheduler-race";
      const raceRunId = `run-v1-${"2".repeat(32)}`;
      const raceContract = { ...contract, dispatch_id: dispatch, linear: { ...contract.linear, issue_id: "issue-scheduler-race", identifier: "MHO-227" }, registry: binding.identity };
      const contractDigest = await __TEST_ONLY__.digest(raceContract);
      const profileDigest = await __TEST_ONLY__.profileDigest(raceContract);
      await env.DB.prepare("INSERT INTO factory_runs(dispatch_id,run_id,contract_digest,profile_digest,factory_id,registry_version,registry_digest,registry_entry_version,contract_json,linear_project_id,linear_issue_id,linear_identifier,repository,collision_group,base_sha,current_state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").bind(dispatch, raceRunId, contractDigest, profileDigest, binding.identity.factory_id, binding.identity.registry_version, binding.identity.registry_digest, binding.identity.entry_version, JSON.stringify(raceContract), raceContract.linear.project_id, raceContract.linear.issue_id, raceContract.linear.identifier, raceContract.target.repository, raceContract.target.collision_group, raceContract.target.base_sha, "queued", createdAt, createdAt).run();

      let advanced = false;
      const deadlineDb = new Proxy(env.DB as object, {
        get(target, property) {
          const value = Reflect.get(target, property, target);
          if (property === "batch" && typeof value === "function") {
            return async (...args: unknown[]) => {
              const result = await value.apply(target, args);
              if (!advanced) {
                advanced = true;
                clock = deadline + 1;
              }
              return result;
            };
          }
          if (property !== "prepare" || typeof value !== "function") return typeof value === "function" ? value.bind(target) : value;
          return value.bind(target);
        },
      });
      let workflowCreates = 0;
      const schedulerEnv = Object.assign(Object.create(env), {
        DB: deadlineDb, FACTORY_ENABLED: "true", FACTORY_AUTONOMY: "1", MAX_COST_USD: "8", MAX_GLOBAL_CONCURRENCY: "1",
        __TEST_CLOCK_NOW: () => clock,
        EXECUTION_WORKFLOW: { create: async () => { workflowCreates += 1; return { id: "must-not-start" }; } },
      });

      const outcome = await __TEST_ONLY__.schedule(schedulerEnv as never, { kind: "dispatch", dispatchId: dispatch, runId: raceRunId, contractDigest, contract: raceContract });
      expect(advanced).toBe(true);
      expect(outcome).toBe("needs-human");
      expect(workflowCreates).toBe(0);
      await expect(env.DB.prepare("SELECT current_state,lease_fence,lease_expires_at FROM factory_runs WHERE run_id=?").bind(raceRunId).first()).resolves.toMatchObject({ current_state: "needs-human", lease_fence: null, lease_expires_at: null });
      await expect(env.DB.prepare("SELECT COUNT(*) AS count FROM factory_leases WHERE dispatch_id=?").bind(raceRunId).first<{ count: number }>()).resolves.toMatchObject({ count: 0 });
      await expect(env.DB.prepare("SELECT COUNT(*) AS count FROM factory_lease_members WHERE reservation_id IN (SELECT reservation_id FROM factory_lease_reservations WHERE run_id=?)").bind(raceRunId).first<{ count: number }>()).resolves.toMatchObject({ count: 0 });
  });
});
