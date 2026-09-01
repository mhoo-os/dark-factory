import { promises as fs } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const repo = "/workspace/project";
const maxIterations = Number(process.env.FACTORY_MAX_ITERATIONS || 8);
const maxCommands = Number(process.env.FACTORY_MAX_COMMANDS || 24);
let commandCount = 0;

function redact(value) {
  return String(value)
    .replace(/sk-or-v1-[A-Za-z0-9_-]+/g, "[REDACTED_OPENROUTER_KEY]")
    .replace(/gh[pousr]_[A-Za-z0-9_]+/g, "[REDACTED_GITHUB_TOKEN]")
    .replace(/x-access-token:[^@\s]+@/g, "x-access-token:[REDACTED]@");
}

function safePath(input, { writable = false } = {}) {
  if (typeof input !== "string" || input.length === 0 || input.length > 240 || input.includes("\0")) throw new Error("path is invalid");
  const relative = path.posix.normalize(input.replaceAll("\\", "/"));
  if (relative === "." && writable) throw new Error("a file path is required");
  if (relative.startsWith("/") || relative === ".." || relative.startsWith("../")) throw new Error("path must stay inside the repository");
  const parts = relative.split("/");
  const protectedNames = new Set(["Dockerfile", "wrangler.json", "wrangler.jsonc", "CLAUDE.md", "MISSION.md", "FACTORY.md", "FACTORY_RULES.md"]);
  if (parts.some((part) => part === ".git" || part === ".dev.vars" || part.startsWith(".env"))) throw new Error("path is protected");
  if (writable && parts.some((part) => protectedNames.has(part))) throw new Error("governance or deployment files are protected");
  return path.join(repo, relative);
}

async function listFiles(input = ".") {
  const root = safePath(input);
  const output = [];
  async function walk(directory, prefix) {
    if (output.length >= 200) return;
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (output.length >= 200) return;
      if (entry.name === ".git" || entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(absolute, relative);
      else output.push(relative);
    }
  }
  await walk(root, input === "." ? "" : input);
  return output;
}

async function readFile(input) {
  const filename = safePath(input);
  const content = await fs.readFile(filename, "utf8");
  return { path: input, content: redact(content.slice(0, 20000)), truncated: content.length > 20000 };
}

function commandAllowed(command) {
  if (typeof command !== "string" || command.length === 0 || command.length > 240) return false;
  if (/[;&|<>`$\n\r]/.test(command)) return false;
  if (/\b(rm|sudo|curl|wget|ssh|scp|nc|ncat|telnet|printenv|env|git\s+(push|commit|config|checkout|branch))\b/i.test(command)) return false;
  return /^(pwd|ls(?:\s+[-./A-Za-z0-9_*]+)?|git\s+(status|diff)(?:\s+[-./A-Za-z0-9_*]+)?|git\s+diff\s+--check|npm\s+(test|run\s+(test|lint|build|check|typecheck))|npm\s+ci\s+--ignore-scripts(?:\s+--(?:no-audit|no-fund))+|npx\s+(tsc|vitest)(?:\s+[-./A-Za-z0-9_=]+)*|pytest(?:\s+[-./A-Za-z0-9_=]+)*|python\s+-m\s+pytest(?:\s+[-./A-Za-z0-9_=]+)*|go\s+test(?:\s+[-./A-Za-z0-9_=]+)*|cargo\s+test(?:\s+[-./A-Za-z0-9_=]+)*)$/i.test(command.trim());
}

async function runCommand(command) {
  if (!commandAllowed(command)) throw new Error("command is outside the bounded execution policy");
  if (++commandCount > maxCommands) throw new Error("command budget exhausted");
  return await new Promise((resolve) => {
    const child = spawn("sh", ["-lc", command], {
      cwd: repo,
      env: { PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin", HOME: "/tmp/factory-home", CI: "1" },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    const timer = setTimeout(() => child.kill("SIGTERM"), 90_000);
    child.on("close", (exitCode, signal) => {
      clearTimeout(timer);
      resolve({ command, exitCode, signal, stdout: redact(stdout.slice(-12000)), stderr: redact(stderr.slice(-12000)) });
    });
  });
}

async function writeFile(input, content) {
  if (typeof content !== "string" || content.length > 50000) throw new Error("file content exceeds the bounded write limit");
  const filename = safePath(input, { writable: true });
  await fs.mkdir(path.dirname(filename), { recursive: true });
  await fs.writeFile(filename, content, "utf8");
  return { path: input, bytes: Buffer.byteLength(content) };
}

const tools = [
  { type: "function", function: { name: "list_files", description: "List repository files under a relative directory. Hidden metadata and dependencies are omitted.", parameters: { type: "object", properties: { path: { type: "string" } }, additionalProperties: false } } },
  { type: "function", function: { name: "read_file", description: "Read a repository text file. Paths must be relative and protected governance/secrets files cannot be read.", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false } } },
  { type: "function", function: { name: "write_file", description: "Replace a repository text file with complete new content. Do not modify governance, deployment, credential, or merge-control files.", parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"], additionalProperties: false } } },
  { type: "function", function: { name: "run_command", description: "Run one bounded test or inspection command in the repository. Package installation ignores lifecycle scripts. Network, credential, git push, git commit, and shell composition are prohibited.", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"], additionalProperties: false } } }
];

async function callOpenRouter(messages) {
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: process.env.OPENROUTER_MODEL, messages, tools, tool_choice: "auto", parallel_tool_calls: false, temperature: 0.1, max_tokens: 4000 })
  });
  const body = await response.json();
  if (!response.ok) throw new Error(`OpenRouter request failed (${response.status}): ${redact(body?.error?.message || "unknown provider error")}`);
  return body;
}

async function executeTool(name, args) {
  if (name === "list_files") return await listFiles(args.path || ".");
  if (name === "read_file") return await readFile(args.path);
  if (name === "write_file") return await writeFile(args.path, args.content);
  if (name === "run_command") return await runCommand(args.command);
  throw new Error(`unknown tool: ${name}`);
}

const title = process.env.FACTORY_ISSUE_TITLE || process.env.FACTORY_ISSUE || "admitted issue";
const description = process.env.FACTORY_ISSUE_DESCRIPTION || "";
const issueUrl = process.env.FACTORY_ISSUE_URL || "";
const messages = [
  { role: "system", content: "You are the bounded ground-execution agent for Mhoo Dark Factory. The issue has already been planned and admitted upstream. Do not perform PIV planning. Ground yourself in the current repository, make only the smallest implementation needed for the issue, run relevant checks, and stop when the bounded task is complete. Never modify governance, deployment, credential, merge-control, or factory-control files. Never push, commit, merge, or create external resources. If the issue is ambiguous or exceeds the available tools, stop and explain what requires a human." },
  { role: "user", content: `Issue: ${title}\nURL: ${issueUrl}\nRepository: ${process.env.FACTORY_REPOSITORY}\n\nAdmitted issue description:\n${description}\n\nBegin by inspecting the repository and then execute the bounded issue directly.` }
];

let finalMessage = "";
for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
  const response = await callOpenRouter(messages);
  const message = response?.choices?.[0]?.message;
  if (!message) throw new Error("OpenRouter returned no assistant message");
  messages.push(message);
  const calls = message.tool_calls || [];
  if (calls.length === 0) {
    finalMessage = redact(message.content || "Agent stopped without a final summary.");
    break;
  }
  for (const call of calls) {
    let args;
    try { args = JSON.parse(call.function.arguments || "{}"); } catch { args = {}; }
    let result;
    try { result = await executeTool(call.function.name, args); }
    catch (error) { result = { error: String(error) }; }
    messages.push({ role: "tool", tool_call_id: call.id, name: call.function.name, content: JSON.stringify(result) });
  }
}

if (!finalMessage) finalMessage = "Agent stopped at the iteration budget before producing a final summary.";
const status = await runCommand("git status --short");
console.log(JSON.stringify({ status: "completed", issue: process.env.FACTORY_ISSUE, iterations: messages.filter((message) => message.role === "assistant").length, changedFiles: redact(status.stdout), summary: finalMessage }));
