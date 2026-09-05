import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { unstable_dev } from "wrangler";

const PROJECT_ID = "2dab9206-cb92-49a4-aeef-95ec45280098";
const SECRET = "test-linear-webhook-secret";
const HEAD = "fedcba9876543210fedcba9876543210fedcba98";

function contract() {
  return {
    contract_version: "v1",
    dispatch_id: "MHO-250@b5-dry-run",
    linear: {
      project_id: PROJECT_ID,
      issue_id: "issue-mho-250",
      identifier: "MHO-250",
      planning_revision: "b5-dry-run",
      planning_fingerprint: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    },
    target: {
      repository: "mhoo-os/dark-factory",
      work_type: "verification",
      execution_profile: "python-tests-v1",
      collision_group: "dark-factory-runtime",
      base_sha: "0123456789abcdef0123456789abcdef01234567",
    },
    dependencies: [],
    risk: { risk_class: "low", authority_class: "repository-local" },
    acceptance_criteria: ["Gate 3 receives an authenticated non-executable receipt"],
    validation_profile: "python-tests-v1",
    allowed_scope: { paths: [], max_files: 0, max_changed_lines: 0 },
    merge_policy: "human",
    stale_conditions: ["planning_revision_changed", "planning_fingerprint_changed", "base_sha_changed"],
    dry_run_authorization: {
      authorization_id: "MHO-250-pr29-b5-receipt",
      mode: "approved-intake",
      non_executable: true,
      expires_at: new Date(Date.now() + 10 * 60_000).toISOString().replace(/\.\d{3}Z$/, "Z"),
      repository: "mhoo-os/dark-factory",
      pr_number: 29,
      linear_issue: "MHO-250",
      review_id: "MHOO-RX5-MHO-250-PR29-a17d38323813-FINAL",
      checkout_head_sha: HEAD,
    },
  };
}

test("an authenticated approved-intake dry run reaches the real Worker and cannot touch ingress or queue bindings", async () => {
  const worker = await unstable_dev("src/index.ts", {
    compatibilityDate: "2026-09-01",
    compatibilityFlags: ["nodejs_compat"],
    local: true,
    logLevel: "error",
    vars: {
      ALLOWED_REPOSITORY_PREFIX: "mhoo-os/",
      AUTO_MERGE: "false",
      FACTORY_AUTONOMY: "0",
      FACTORY_ENABLED: "false",
      LINEAR_PROJECT_ID: PROJECT_ID,
      MAX_PAYLOAD_BYTES: "262144",
      LINEAR_WEBHOOK_SECRET: SECRET,
    },
    experimental: { forceLocal: true, enableContainers: false },
  });
  try {
    const timestamp = Date.now();
    const description = [
      "<!-- mhoo-factory-dispatch:v1 -->",
      JSON.stringify(contract()),
      "<!-- /mhoo-factory-dispatch:v1 -->",
    ].join("\n");
    const raw = JSON.stringify({
      type: "Issue",
      webhookTimestamp: timestamp,
      data: {
        id: "issue-mho-250",
        identifier: "MHO-250",
        description,
        project: { id: PROJECT_ID },
      },
    });
    const signature = createHmac("sha256", SECRET).update(raw).digest("hex");
    const response = await worker.fetch("https://factory.test/webhooks/linear", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Linear-Event": "Issue",
        "Linear-Signature": signature,
        "Linear-Timestamp": String(timestamp),
        "Linear-Delivery": "mho250-dry-run-execution",
      },
      body: raw,
    });
    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), { accepted: false, reason: "dry_run_authorization_non_executable" });
  } finally {
    await worker.stop();
  }
});
