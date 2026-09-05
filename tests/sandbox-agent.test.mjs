import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = new URL("../sandbox/agent.mjs", import.meta.url);
const sha = `sha256:${"a".repeat(64)}`;
const contract = { contract_version: "v1", linear: { identifier: "MHO-224" }, target: { repository: "mhoo-os/dark-factory", base_sha: "a".repeat(40) }, allowed_scope: { paths: ["src/**"], max_files: 1, max_changed_lines: 10 } };

function run(root, extra = {}) {
  const env = { PATH: process.env.PATH, FACTORY_PROJECT_ROOT: root, FACTORY_RUN_ID: "run-v1-test", FACTORY_CONTRACT_JSON: JSON.stringify(contract), FACTORY_REPOSITORY: contract.target.repository, FACTORY_BASE_SHA: contract.target.base_sha, FACTORY_ISSUE: "MHO-224", FACTORY_SOURCE_DIGEST: sha, FACTORY_PROPOSAL_JSON: JSON.stringify([{ path: "src/bounded.js", content: "export const bounded = true;\n" }]), FACTORY_VALIDATION_COMMAND: "test -f src/bounded.js", ...extra };
  return new Promise((resolve) => { const child = spawn(process.execPath, [script.pathname], { env }); let output = ""; child.stdout.on("data", (chunk) => { output += chunk; }); child.on("close", (code) => resolve({ code, output: JSON.parse(output) })); });
}

test("candidate refuses incomplete execution identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "factory-agent-"));
  try { const answer = await run(root, { FACTORY_SOURCE_DIGEST: "" }); assert.equal(answer.code, 78); assert.equal(answer.output.reason, "agent_input_invalid"); } finally { await rm(root, { recursive: true, force: true }); }
});

test("candidate is credential-free, rejects Git state, and returns an inert handoff", async () => {
  const root = await mkdtemp(join(tmpdir(), "factory-agent-"));
  try {
    await mkdir(join(root, "src"), { recursive: true });
    const answer = await run(root, { GITHUB_TOKEN: "dummy-github", OPENROUTER_API_KEY: "dummy-provider", LINEAR_API_KEY: "dummy-linear" });
    assert.equal(answer.code, 0); assert.equal(answer.output.source_digest, sha); assert.deepEqual(answer.output.changed_files, ["src/bounded.js"]); assert.equal(await readFile(join(root, "src/bounded.js"), "utf8"), "export const bounded = true;\n");
    const source = await readFile(script, "utf8");
    assert.doesNotMatch(source, /fetch\(/); assert.doesNotMatch(source, /git", \[/); assert.match(source, /delete env\.GITHUB_TOKEN/); assert.match(source, /delete env\.OPENROUTER_API_KEY/);
    await mkdir(join(root, ".git"));
    const rejected = await run(root); assert.equal(rejected.code, 78); assert.equal(rejected.output.reason, "candidate_git_state_forbidden");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("candidate refuses protected proposal paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "factory-agent-"));
  try { await mkdir(join(root, "src"), { recursive: true }); const answer = await run(root, { FACTORY_PROPOSAL_JSON: JSON.stringify([{ path: ".git/config", content: "x" }]) }); assert.equal(answer.code, 78); assert.equal(answer.output.reason, "proposal_file_scope_invalid"); } finally { await rm(root, { recursive: true, force: true }); }
});
