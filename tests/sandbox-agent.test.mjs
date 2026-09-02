import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";

const script = new URL("../sandbox/agent.mjs", import.meta.url);

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
  assert.match(source, /ls-files/);
  assert.match(source, /lstat/);
  assert.match(source, /finally/);
  assert.doesNotMatch(source, /--no-verify/);
  assert.match(source, /protected_path/);
});
