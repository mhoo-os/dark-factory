import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";

const script = new URL("../sandbox/agent.mjs", import.meta.url);

const modelContract = {
  acceptance_criteria: ["write the bounded file"],
  allowed_scope: { paths: ["src/**"], max_files: 1, max_changed_lines: 10 },
};

async function testAgent() {
  process.env.FACTORY_AGENT_TEST = "1";
  process.env.FACTORY_PROJECT_ROOT = process.cwd();
  process.env.OPENROUTER_API_KEY = "receipt-test-key";
  process.env.OPENROUTER_MODEL = "test-model";
  process.env.FACTORY_MODEL_PROVIDER = "openrouter";
  process.env.FACTORY_REPOSITORY = "mhoo-os/dark-factory";
  process.env.FACTORY_ISSUE = "MHO-224";
  process.env.FACTORY_MAX_COST_USD = "1.00";
  process.env.FACTORY_MAX_OUTPUT_TOKENS = "4096";
  process.env.FACTORY_OUTPUT_TOKEN_USD = "0.01";
  process.env.FACTORY_REQUEST_OVERHEAD_USD = "0.20";
  process.env.FACTORY_TIMEOUT_SECONDS = "30";
  return await import(`../sandbox/agent.mjs?test=${Date.now()}-${Math.random()}`);
}

function run(env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script.pathname], { env: { PATH: process.env.PATH, ...env } });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.on("close", (code) => resolve({ code, output: JSON.parse(output) }));
  });
}

test("agent refuses incomplete execution identity", async () => {
  const answer = await run({ FACTORY_RUN_ID: "run-v1-test" });
  assert.equal(answer.code, 78);
  assert.deepEqual(answer.output, { status: "needs-human", reason: "agent_input_invalid" });
});

test("agent source has no raw-output or credential logging path", async () => {
  const source = await readFile(script, "utf8");
  assert.doesNotMatch(source, /console\.log\((?:validation|body|process\.env)/);
  assert.match(source, /delete env\.OPENROUTER_API_KEY/);
  assert.match(source, /delete env\.GITHUB_TOKEN/);
  assert.match(source, /remote", "set-url", "origin", `https:\/\/github\.com\/\$\{repository\}\.git`/);
  assert.match(source, /ls-files/);
  assert.match(source, /lstat/);
  assert.match(source, /finally/);
  assert.doesNotMatch(source, /--no-verify/);
  assert.match(source, /protected_path/);
});

test("agent sends a pricing-derived provider max_tokens and returns the provider receipt", async () => {
  const { modelFiles } = await testAgent();
  let request;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options) => {
    request = JSON.parse(options.body);
    return new Response(JSON.stringify({
      id: "gen-provider-issued-123",
      created: 1_725_000_000,
      model: "provider-returned-model",
      choices: [{ message: { content: JSON.stringify({ files: [{ path: "src/bounded.ts", content: "export const bounded = true;\n" }] }) } }],
      usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30, cost: 0.40 },
    }), { status: 200 });
  };
  try {
    const result = await modelFiles(modelContract);
    assert.equal(request.max_tokens, 80);
    assert.deepEqual(result.providerUsage, { provider: "openrouter", model: "provider-returned-model", generation_id: "gen-provider-issued-123", provider_created_at: 1_725_000_000, prompt_tokens: 10, completion_tokens: 20, total_tokens: 30, cost_usd: 0.40 });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("agent refuses an over-budget provider receipt before files can be applied", async () => {
  const { modelFiles } = await testAgent();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    id: "gen-over-budget-123",
    created: 1_725_000_001,
    model: "provider-returned-model",
    choices: [{ message: { content: JSON.stringify({ files: [{ path: "src/never.ts", content: "no" }] }) } }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cost: 1.01 },
  }), { status: 200 });
  try {
    await assert.rejects(() => modelFiles(modelContract), /provider_usage_or_cost_invalid/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("agent refuses a provider response without provider-issued identity evidence", async () => {
  const { modelFiles } = await testAgent();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    choices: [{ message: { content: JSON.stringify({ files: [{ path: "src/never.ts", content: "no" }] }) } }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cost: 0.01 },
  }), { status: 200 });
  try {
    await assert.rejects(() => modelFiles(modelContract), /provider_usage_or_cost_invalid/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("agent strips execution credentials from child command environments", async () => {
  const { commandResult } = await testAgent();
  const result = await commandResult(process.execPath, ["-e", "process.stdout.write(`${process.env.OPENROUTER_API_KEY}|${process.env.GITHUB_TOKEN}`)"], { env: { OPENROUTER_API_KEY: "secret-a", GITHUB_TOKEN: "secret-b" } });
  assert.equal(result.code, 0);
  assert.equal(result.stdout, "undefined|undefined");
});
