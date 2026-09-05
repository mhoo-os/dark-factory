import test from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const script = new URL("../sandbox/agent.mjs", import.meta.url);
const sha = `sha256:${"a".repeat(64)}`;
const contract = { contract_version: "v1", linear: { identifier: "MHO-224" }, target: { repository: "mhoo-os/dark-factory", base_sha: "a".repeat(40) }, allowed_scope: { paths: ["src/**"], max_files: 1, max_changed_lines: 10 } };
const executeFile = promisify(execFile);

async function shell(command, options = {}) {
  try {
    const result = await executeFile("sh", ["-c", command], options);
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return { code: typeof error.code === "number" ? error.code : 1, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
  }
}

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

test("trusted publication handoff executes literal Git paths and blocks tampered state before dummy push", async () => {
  const root = await mkdtemp(join(tmpdir(), "factory-publication-"));
  const project = join(root, "project");
  const tools = join(root, "tools");
  const manifest = join(root, "candidate-paths");
  const pushRecord = join(root, "push-record");
  const sentinel = join(root, "shell-sentinel");
  const remote = "https://github.com/mhoo-os/dark-factory.git";
  const git = "/usr/bin/git";
  const paths = [
    `tests/semicolon;touch ${sentinel}`,
    `tests/newline\n$(touch ${sentinel})`,
    `tests/substitution-$(touch ${sentinel})`,
  ];
  const state = `test "$(git -C ${project} remote get-url --push origin)" = "${remote}" && test "$(git -C ${project} config --local --get-all credential.helper)" = "" && test "$(git -C ${project} config --local --get core.hooksPath)" = "/dev/null"`;
  const stage = `git --literal-pathspecs -C ${project} -c core.hooksPath=/dev/null add --pathspec-from-file=${manifest} --pathspec-file-nul`;
  const push = `git -C ${project} -c core.hooksPath=/dev/null -c credential.helper= -c http.extraHeader='Authorization: Basic ZHVtbXktcHVibGlzaC10b2tlbg==' push ${remote} HEAD:refs/heads/factory/mho-224-dummy`;
  const setup = async () => {
    await mkdir(project, { recursive: true });
    assert.equal((await shell(`git -C ${project} init && git -C ${project} config user.name test && git -C ${project} config user.email test@example.invalid && git -C ${project} remote add origin ${remote} && git -C ${project} config --local --replace-all credential.helper '' && git -C ${project} config --local --replace-all core.hooksPath /dev/null`)).code, 0);
    for (const path of paths) {
      const full = join(project, path);
      await mkdir(full.slice(0, full.lastIndexOf("/")), { recursive: true });
      await writeFile(full, "export const bounded = true;\n");
    }
    await writeFile(manifest, paths.join("\0"));
  };
  try {
    const worker = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
    assert.match(worker, /--literal-pathspecs -C \/workspace\/project -c core\.hooksPath=\/dev\/null add --pathspec-from-file=\/tmp\/factory-candidate-paths --pathspec-file-nul/);
    assert.match(worker, /remote get-url --push origin/);
    assert.match(worker, /config --local --get-all credential\.helper/);
    assert.match(worker, /config --local --get core\.hooksPath/);
    assert.match(worker, /push \$\{target\} HEAD:refs\/heads\/\$\{branch\}/);
    await setup();
    await mkdir(tools, { recursive: true });
    await writeFile(join(tools, "git"), `#!/bin/sh\nfor arg in "$@"; do\n  if [ "$arg" = push ]; then printf '%s\\n' "$@" > '${pushRecord}'; exit 0; fi\ndone\nexec '${git}' "$@"\n`);
    await chmod(join(tools, "git"), 0o755);
    const dummyEnv = { ...process.env, PATH: `${tools}:${process.env.PATH}` };

    assert.equal((await shell(stage, { env: dummyEnv })).code, 0);
    assert.equal((await shell(`git -C ${project} -c core.hooksPath=/dev/null commit -m dummy`, { env: dummyEnv })).code, 0);
    assert.equal((await shell(state, { env: dummyEnv })).code, 0);
    const pushed = await shell(push, { env: dummyEnv });
    assert.equal(pushed.code, 0, pushed.stderr);
    assert.equal((await readFile(pushRecord, "utf8")).includes(remote), true);
    await assert.rejects(readFile(sentinel));

    for (const tamper of [
      `git -C ${project} remote set-url --push origin https://github.com/mhoo-os/other.git`,
      `git -C ${project} config --local --replace-all credential.helper dummy-helper`,
      `git -C ${project} config --local --replace-all core.hooksPath ${root}/hooks`,
    ]) {
      await rm(pushRecord, { force: true });
      assert.equal((await shell(tamper)).code, 0);
      assert.notEqual((await shell(state, { env: dummyEnv })).code, 0);
      await assert.rejects(readFile(pushRecord));
      assert.equal((await shell(`git -C ${project} remote set-url --push origin ${remote} && git -C ${project} config --local --replace-all credential.helper '' && git -C ${project} config --local --replace-all core.hooksPath /dev/null`)).code, 0);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
