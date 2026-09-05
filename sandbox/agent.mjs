import { createHash } from "node:crypto";
import { execFile as executeFile } from "node:child_process";
import { lstat, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(executeFile);
const root = process.env.FACTORY_PROJECT_ROOT || "/workspace/project";
const maxOutput = boundedPositiveNumber(process.env.FACTORY_MAX_OUTPUT_BYTES, 262144);
let commandCount = 0;

function boundedPositiveNumber(value, fallback) { const parsed = Number(value || fallback); return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback; }
function sha256(value) { return `sha256:${createHash("sha256").update(value).digest("hex")}`; }
function result(status, reason, extra = {}) { process.stdout.write(`${JSON.stringify({ status, reason, ...extra })}\n`); process.exitCode = status === "passed" ? 0 : 78; }
function validPath(value) { return typeof value === "string" && value.length > 0 && value.length <= 240 && !value.startsWith("/") && !value.includes("\0") && !value.split("/").some((part) => part === ".." || part === "."); }
function matchesScope(path, scopes) { return scopes.some((scope) => scope === path || (scope.endsWith("/**") && path.startsWith(`${scope.slice(0, -3)}/`)) || (scope.endsWith("/*") && path.startsWith(`${scope.slice(0, -2)}/`) && !path.slice(scope.length - 1).includes("/"))); }
function protectedPath(path) { return ["MISSION.md", "FACTORY.md", "FACTORY_RULES.md", "CLAUDE.md", "AGENTS.md"].includes(path) || path.startsWith("factory/") || path.startsWith(".github/") || path.startsWith(".factory/") || path.startsWith(".git/"); }

async function commandResult(name, args, options = {}) {
  commandCount += 1; if (commandCount > 24) throw new Error("command_limit_exceeded");
  const env = { ...process.env, ...(options.env || {}) };
  delete env.OPENROUTER_API_KEY; delete env.GITHUB_TOKEN; delete env.LINEAR_API_KEY;
  try { const run = await execFile(name, args, { cwd: root, env, maxBuffer: maxOutput, timeout: Number(options.timeout || 120000) }); return { stdout: run.stdout || "", stderr: run.stderr || "", code: 0 }; }
  catch (error) { return { stdout: error.stdout || "", stderr: error.stderr || "", code: typeof error.code === "number" ? error.code : 1 }; }
}

function proposalFiles(contract) {
  let parsed; try { parsed = JSON.parse(process.env.FACTORY_PROPOSAL_JSON || ""); } catch { throw new Error("proposal_json_invalid"); }
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > contract.allowed_scope.max_files) throw new Error("proposal_file_count_invalid");
  const paths = new Set();
  for (const file of parsed) {
    if (!file || !validPath(file.path) || paths.has(file.path) || !matchesScope(file.path, contract.allowed_scope.paths) || typeof file.content !== "string" || file.content.length > maxOutput || protectedPath(file.path)) throw new Error("proposal_file_scope_invalid");
    paths.add(file.path);
  }
  return parsed;
}

async function writeFiles(files) {
  for (const file of files) {
    const full = resolve(root, file.path);
    if (!full.startsWith(`${root}/`)) throw new Error("path_escape");
    const parts = full.slice(root.length + 1).split("/"); let current = root;
    for (const part of parts) { current = `${current}/${part}`; try { if ((await lstat(current)).isSymbolicLink()) throw new Error("symlink_path"); } catch (error) { if (error?.code !== "ENOENT") throw error; } }
    await mkdir(dirname(full), { recursive: true });
    try { if ((await lstat(full)).isSymbolicLink()) throw new Error("symlink_path"); } catch (error) { if (error?.code !== "ENOENT") throw error; }
    await writeFile(full, file.content, { encoding: "utf8", flag: "w" });
  }
}

async function main() {
  const contractText = process.env.FACTORY_CONTRACT_JSON; const repository = process.env.FACTORY_REPOSITORY; const baseSha = process.env.FACTORY_BASE_SHA; const issue = process.env.FACTORY_ISSUE; const sourceDigest = process.env.FACTORY_SOURCE_DIGEST;
  if (!contractText || !/^mhoo-os\/[a-z0-9][a-z0-9._-]{0,99}$/.test(repository) || !/^[0-9a-f]{40}$/i.test(baseSha || "") || !/^[A-Z][A-Z0-9]{1,9}-[1-9][0-9]*$/.test(issue || "") || !/^sha256:[0-9a-f]{64}$/.test(sourceDigest || "") || !/^run-v1-[a-z0-9-]{1,128}$/.test(process.env.FACTORY_RUN_ID || "")) return result("needs-human", "agent_input_invalid");
  let contract; try { contract = JSON.parse(contractText); } catch { return result("needs-human", "contract_json_invalid"); }
  if (!contract || typeof contract !== "object" || contract.contract_version !== "v1" || contract.linear?.identifier !== issue || contract.target?.repository !== repository || contract.target?.base_sha !== baseSha) return result("needs-human", "contract_identity_mismatch");
  try { if ((await lstat(resolve(root, ".git"))).isDirectory()) return result("needs-human", "candidate_git_state_forbidden"); } catch (error) { if (error?.code !== "ENOENT") return result("needs-human", "candidate_root_invalid"); }
  let files; try { files = proposalFiles(contract); await writeFiles(files); } catch (error) { return result("needs-human", error instanceof Error ? error.message : "proposal_apply_failed"); }
  if (files.reduce((sum, file) => sum + file.content.split(/\r?\n/).length, 0) > contract.allowed_scope.max_changed_lines) return result("needs-human", "changed_line_cap_exceeded");
  const validation = await commandResult("sh", ["-lc", process.env.FACTORY_VALIDATION_COMMAND || "python3 -m unittest discover -s tests -q"], { timeout: 15 * 60_000 });
  const validationText = `${validation.stdout}\n${validation.stderr}`;
  return result(validation.code === 0 ? "passed" : "failed", validation.code === 0 ? "candidate_validated" : "validation_failed", { source_digest: sourceDigest, changed_files: files.map((file) => file.path), files, diff_digest: sha256(JSON.stringify(files)), validation_digest: sha256(validationText), validation_bytes: validationText.length });
}

export { commandResult, proposalFiles };

if (process.env.FACTORY_AGENT_TEST !== "1") main().catch(() => result("needs-human", "agent_failed"));
