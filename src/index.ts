import { getSandbox } from "@cloudflare/sandbox";
import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";

export { Sandbox } from "@cloudflare/sandbox";

const CONTRACT_OPEN = "<!-- mhoo-factory-dispatch:v1 -->";
const CONTRACT_CLOSE = "<!-- /mhoo-factory-dispatch:v1 -->";
const ISSUE_STATES = new Set(["unstarted", "started"]);
const STALE_CONDITIONS = new Set([
  "planning_revision_changed",
  "planning_fingerprint_changed",
  "base_sha_changed",
]);
const SHA40 = /^[0-9a-f]{40}$/i;
const REPOSITORY = /^mhoo-os\/[a-z0-9][a-z0-9._-]{0,99}$/;

type ObjectValue = Record<string, unknown>;
type Contract = {
  contract_version: "v1";
  dispatch_id: string;
  linear: {
    project_id: string;
    issue_id: string;
    identifier: string;
    planning_revision: string;
    planning_fingerprint: string;
  };
  target: {
    repository: string;
    work_type: string;
    execution_profile: string;
    collision_group: string;
    base_sha: string;
  };
  dependencies: Array<{ issue_id: string; required_state: "completed" }>;
  risk: { risk_class: "low" | "medium" | "high"; authority_class: "repository-local" | "cross-system" };
  acceptance_criteria: string[];
  validation_profile: string;
  allowed_scope: { paths: string[]; max_files: number; max_changed_lines: number };
  merge_policy: "human" | "auto-eligible";
  stale_conditions: string[];
};

type Job = { dispatchId: string; runId: string; contractDigest: string; contract: Contract };
type Run = {
  dispatch_id: string;
  run_id: string;
  contract_digest: string;
  contract_json: string;
  linear_issue_id: string;
  repository: string;
  collision_group: string;
  base_sha: string;
  current_state: string;
  workflow_id: string | null;
  lease_fence: number | null;
  lease_expires_at: string | null;
};

class AdmissionError extends Error {}

const response = (body: ObjectValue, status = 200) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

function secret(env: Env, name: string): string | undefined {
  const value = Reflect.get(env, name);
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    const object = value as ObjectValue;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stable(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

async function digest(value: unknown): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(stable(value)));
  return `sha256:${Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function object(value: unknown, keys: string[], label: string): ObjectValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AdmissionError(`${label}_object_required`);
  const actual = Object.keys(value as ObjectValue).sort();
  if (actual.join("\0") !== [...keys].sort().join("\0")) throw new AdmissionError(`${label}_fields_invalid`);
  return value as ObjectValue;
}

function text(value: unknown, label: string, max = 512): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max || /[\r\n]/.test(value)) {
    throw new AdmissionError(`${label}_invalid`);
  }
  return value;
}

function integer(value: unknown, label: string, max: number): number {
  if (!Number.isInteger(value) || typeof value !== "number" || value < 1 || value > max) {
    throw new AdmissionError(`${label}_invalid`);
  }
  return value;
}

function contractFromDescription(description: unknown, issue: ObjectValue, env: Env): Contract {
  const source = text(description, "description", 100_000);
  if (source.split(CONTRACT_OPEN).length - 1 !== 1 || source.split(CONTRACT_CLOSE).length - 1 !== 1) {
    throw new AdmissionError("contract_block_missing_or_ambiguous");
  }
  const start = source.indexOf(CONTRACT_OPEN) + CONTRACT_OPEN.length;
  const end = source.indexOf(CONTRACT_CLOSE);
  if (end <= start) throw new AdmissionError("contract_block_order_invalid");
  let parsed: unknown;
  try { parsed = JSON.parse(source.slice(start, end).trim()); } catch { throw new AdmissionError("contract_json_invalid"); }
  const root = object(parsed, ["contract_version", "dispatch_id", "linear", "target", "dependencies", "risk", "acceptance_criteria", "validation_profile", "allowed_scope", "merge_policy", "stale_conditions"], "contract");
  if (root.contract_version !== "v1") throw new AdmissionError("contract_version_unsupported");
  const projectId = text(env.LINEAR_PROJECT_ID, "linear_project_id");
  const linear = object(root.linear, ["project_id", "issue_id", "identifier", "planning_revision", "planning_fingerprint"], "linear");
  const issueId = text(issue.id, "issue_id");
  const identifier = text(issue.identifier, "identifier", 32);
  if (linear.project_id !== projectId || linear.issue_id !== issueId || linear.identifier !== identifier) throw new AdmissionError("contract_linear_identity_mismatch");
  if (!/^[A-Z][A-Z0-9]{1,9}-[1-9][0-9]*$/.test(identifier)) throw new AdmissionError("issue_identifier_invalid");
  const planningRevision = text(linear.planning_revision, "planning_revision");
  if (root.dispatch_id !== `${identifier}@${planningRevision}`) throw new AdmissionError("dispatch_id_not_bound_to_revision");
  if (!/^sha256:[0-9a-f]{64}$/.test(text(linear.planning_fingerprint, "planning_fingerprint", 71))) throw new AdmissionError("planning_fingerprint_invalid");
  const target = object(root.target, ["repository", "work_type", "execution_profile", "collision_group", "base_sha"], "target");
  if (!REPOSITORY.test(text(target.repository, "repository")) || !text(target.repository, "repository").startsWith(env.ALLOWED_REPOSITORY_PREFIX)) throw new AdmissionError("repository_not_allowed");
  text(target.work_type, "work_type");
  if (text(target.execution_profile, "execution_profile") !== text(root.validation_profile, "validation_profile")) throw new AdmissionError("profile_mismatch");
  text(target.collision_group, "collision_group");
  if (!SHA40.test(text(target.base_sha, "base_sha", 40))) throw new AdmissionError("base_sha_invalid");
  if (!Array.isArray(root.dependencies)) throw new AdmissionError("dependencies_invalid");
  for (const dependency of root.dependencies) {
    const item = object(dependency, ["issue_id", "required_state"], "dependency");
    text(item.issue_id, "dependency_issue_id");
    if (item.required_state !== "completed") throw new AdmissionError("dependency_state_invalid");
  }
  const risk = object(root.risk, ["risk_class", "authority_class"], "risk");
  if (!["low", "medium", "high"].includes(String(risk.risk_class)) || !["repository-local", "cross-system"].includes(String(risk.authority_class))) throw new AdmissionError("risk_invalid");
  if (!Array.isArray(root.acceptance_criteria) || root.acceptance_criteria.length === 0 || root.acceptance_criteria.some((item) => typeof item !== "string" || item.length === 0)) throw new AdmissionError("acceptance_criteria_invalid");
  const scope = object(root.allowed_scope, ["paths", "max_files", "max_changed_lines"], "allowed_scope");
  if (!Array.isArray(scope.paths) || scope.paths.length === 0 || scope.paths.some((item) => typeof item !== "string" || item.length === 0)) throw new AdmissionError("allowed_paths_invalid");
  integer(scope.max_files, "max_files", 12);
  integer(scope.max_changed_lines, "max_changed_lines", 500);
  if (!["human", "auto-eligible"].includes(String(root.merge_policy))) throw new AdmissionError("merge_policy_invalid");
  if (!Array.isArray(root.stale_conditions) || root.stale_conditions.length === 0 || root.stale_conditions.some((item) => typeof item !== "string" || !STALE_CONDITIONS.has(item))) throw new AdmissionError("stale_conditions_invalid");
  const contract: Contract = {
    contract_version: "v1",
    dispatch_id: text(root.dispatch_id, "dispatch_id", 192),
    linear: {
      project_id: text(linear.project_id, "contract_project_id"),
      issue_id: text(linear.issue_id, "contract_issue_id"),
      identifier: text(linear.identifier, "contract_identifier", 32),
      planning_revision: planningRevision,
      planning_fingerprint: text(linear.planning_fingerprint, "planning_fingerprint", 71),
    },
    target: {
      repository: text(target.repository, "repository"),
      work_type: text(target.work_type, "work_type"),
      execution_profile: text(target.execution_profile, "execution_profile"),
      collision_group: text(target.collision_group, "collision_group"),
      base_sha: text(target.base_sha, "base_sha", 40),
    },
    dependencies: (root.dependencies as unknown[]).map((dependency) => {
      const item = dependency as ObjectValue;
      return { issue_id: text(item.issue_id, "dependency_issue_id"), required_state: "completed" as const };
    }),
    risk: {
      risk_class: risk.risk_class as Contract["risk"]["risk_class"],
      authority_class: risk.authority_class as Contract["risk"]["authority_class"],
    },
    acceptance_criteria: root.acceptance_criteria as string[],
    validation_profile: text(root.validation_profile, "validation_profile"),
    allowed_scope: {
      paths: scope.paths as string[],
      max_files: scope.max_files as number,
      max_changed_lines: scope.max_changed_lines as number,
    },
    merge_policy: root.merge_policy as Contract["merge_policy"],
    stale_conditions: root.stale_conditions as string[],
  };
  return contract;
}

function issueFromPayload(payload: unknown): ObjectValue {
  if (!payload || typeof payload !== "object") throw new AdmissionError("payload_invalid");
  const root = payload as ObjectValue;
  const candidate = root.data ?? root.issue ?? root;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) throw new AdmissionError("issue_payload_missing");
  return candidate as ObjectValue;
}

function labels(issue: ObjectValue): string[] {
  const value = issue.labels;
  const entries: unknown[] = Array.isArray(value) ? value : value && typeof value === "object" && Array.isArray((value as ObjectValue).nodes) ? (value as ObjectValue).nodes as unknown[] : [];
  return entries.flatMap((entry: unknown) => entry && typeof entry === "object" && typeof (entry as ObjectValue).name === "string" ? [(entry as ObjectValue).name as string] : []);
}

async function admit(raw: string, env: Env): Promise<Job> {
  if (String(env.FACTORY_ENABLED) !== "true" || String(env.FACTORY_AUTONOMY) !== "1") throw new AdmissionError("factory_disabled");
  if (env.AUTO_MERGE !== "false") throw new AdmissionError("automatic_merge_must_be_disabled");
  let payload: unknown;
  try { payload = JSON.parse(raw); } catch { throw new AdmissionError("invalid_json"); }
  const issue = issueFromPayload(payload);
  const state = issue.state && typeof issue.state === "object" ? (issue.state as ObjectValue).type : undefined;
  if (typeof state !== "string" || !ISSUE_STATES.has(state)) throw new AdmissionError("issue_not_eligible");
  if (!labels(issue).includes("factory:accepted")) throw new AdmissionError("factory_acceptance_label_missing");
  const contract = contractFromDescription(issue.description, issue, env);
  const contractDigest = await digest(contract);
  const dispatchId = contract.dispatch_id;
  const runId = `run-v1-${(await digest({ dispatchId, contractDigest, baseSha: contract.target.base_sha })).slice(7, 39)}`;
  return { dispatchId, runId, contractDigest, contract };
}

async function eventId(raw: string, header: string | null): Promise<string> { return header?.trim() || `body-${(await digest(raw)).slice(7)}`; }
async function ingress(db: D1Database, id: string, provider: string, type: string, payloadDigest: string): Promise<boolean> {
  const result = await db.prepare("INSERT OR IGNORE INTO factory_ingress_events(event_id,provider,event_type,payload_digest,handoff_state,received_at) VALUES(?,?,?,?,?,?)")
    .bind(id, provider, type, payloadDigest, "received", new Date().toISOString()).run();
  return result.meta.changes === 1;
}

async function runById(db: D1Database, runId: string): Promise<Run | null> {
  return await db.prepare("SELECT dispatch_id,run_id,contract_digest,contract_json,linear_issue_id,repository,collision_group,base_sha,current_state,workflow_id,lease_fence,lease_expires_at FROM factory_runs WHERE run_id=?").bind(runId).first<Run>();
}

async function insertRun(db: D1Database, job: Job): Promise<boolean> {
  const c = job.contract;
  const result = await db.prepare("INSERT OR IGNORE INTO factory_runs(dispatch_id,run_id,contract_digest,contract_json,linear_project_id,linear_issue_id,linear_identifier,repository,collision_group,base_sha,current_state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?, ?, ?)")
    .bind(job.dispatchId, job.runId, job.contractDigest, stable(c), c.linear.project_id, c.linear.issue_id, c.linear.identifier, c.target.repository, c.target.collision_group, c.target.base_sha, "admitted", new Date().toISOString(), new Date().toISOString()).run();
  return result.meta.changes === 1;
}

async function updateRun(db: D1Database, runId: string, state: string, result?: ObjectValue): Promise<void> {
  await db.prepare("UPDATE factory_runs SET current_state=?, result_json=COALESCE(?,result_json), updated_at=? WHERE run_id=?").bind(state, result ? stable(result) : null, new Date().toISOString(), runId).run();
}

async function stopped(db: D1Database): Promise<boolean> { return (await db.prepare("SELECT value FROM control_flags WHERE key='stop'").first<{ value: string }>())?.value === "true"; }

async function dependenciesReady(job: Job, env: Env): Promise<boolean> {
  if (job.contract.dependencies.length === 0) return true;
  const token = secret(env, "LINEAR_API_KEY");
  if (!token) return false;
  const query = "query($ids:[ID!]!){issues(filter:{id:{in:$ids}}){nodes{id,state{type}}}}";
  const result = await fetch("https://api.linear.app/graphql", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ query, variables: { ids: job.contract.dependencies.map((item) => item.issue_id) } }) });
  if (!result.ok) return false;
  const body = await result.json() as ObjectValue;
  const nodes = (body.data as ObjectValue | undefined)?.issues && ((body.data as ObjectValue).issues as ObjectValue).nodes;
  return Array.isArray(nodes) && nodes.length === job.contract.dependencies.length && nodes.every((node) => node && typeof node === "object" && ((node as ObjectValue).state as ObjectValue | undefined)?.type === "completed");
}

async function acquireLease(db: D1Database, run: Run): Promise<number | null> {
  const key = `${run.repository}#${run.collision_group}`;
  const now = new Date();
  const current = await db.prepare("SELECT owner,dispatch_id,fence,expires_at FROM factory_leases WHERE lease_key=?").bind(key).first<{ owner: string; dispatch_id: string; fence: number; expires_at: string }>();
  if (current?.dispatch_id === run.run_id && new Date(current.expires_at) > now) return current.fence;
  if (current && new Date(current.expires_at) > now) return null;
  const expiry = new Date(now.getTime() + 30 * 60_000).toISOString();
  const result = await db.prepare("INSERT INTO factory_leases(lease_key,owner,dispatch_id,fence,expires_at) VALUES(?,?,?,?,?) ON CONFLICT(lease_key) DO UPDATE SET owner=excluded.owner,dispatch_id=excluded.dispatch_id,fence=factory_leases.fence+1,expires_at=excluded.expires_at WHERE factory_leases.expires_at<=?")
    .bind(key, "workflow", run.run_id, current?.fence ?? 0, expiry, now.toISOString()).run();
  if (result.meta.changes !== 1) return null;
  const lease = await db.prepare("SELECT fence FROM factory_leases WHERE lease_key=? AND dispatch_id=?").bind(key, run.run_id).first<{ fence: number }>();
  return lease?.fence ?? null;
}

async function releaseLease(db: D1Database, run: Run): Promise<void> {
  const key = `${run.repository}#${run.collision_group}`;
  await db.prepare("DELETE FROM factory_leases WHERE lease_key=? AND dispatch_id=? AND fence=?").bind(key, run.run_id, run.lease_fence).run();
}

async function schedule(env: Env, job: Job): Promise<string> {
  if (await stopped(env.DB)) return "stopped";
  const run = await runById(env.DB, job.runId);
  if (!run || !["admitted", "queued"].includes(run.current_state)) return run?.current_state ?? "missing";
  if (!(await dependenciesReady(job, env))) { await updateRun(env.DB, job.runId, "blocked-by-dependency"); return "blocked-by-dependency"; }
  const active = await env.DB.prepare("SELECT COUNT(*) AS count FROM factory_runs WHERE current_state IN ('leased','running','validating')").first<{ count: number }>();
  if ((active?.count ?? 0) >= Number(env.MAX_GLOBAL_CONCURRENCY)) return "global-busy";
  const leaseFence = await acquireLease(env.DB, run);
  if (leaseFence === null) return "repo-busy";
  await env.DB.prepare("UPDATE factory_runs SET current_state='leased',lease_fence=?,lease_expires_at=?,updated_at=? WHERE run_id=?").bind(leaseFence, new Date(Date.now() + 30 * 60_000).toISOString(), new Date().toISOString(), job.runId).run();
  try {
    const instance = await env.EXECUTION_WORKFLOW.create({ id: job.runId, params: job });
    await env.DB.prepare("UPDATE factory_runs SET workflow_id=?,current_state='running',updated_at=? WHERE run_id=?").bind(instance.id, new Date().toISOString(), job.runId).run();
    return "dispatched";
  } catch {
    await updateRun(env.DB, job.runId, "needs-human", { reason: "workflow_create_failed" });
    await releaseLease(env.DB, { ...run, lease_fence: leaseFence });
    return "needs-human";
  }
}

async function acceptLinear(request: Request, env: Env): Promise<Response> {
  const raw = await request.text();
  if (raw.length > Number(env.MAX_PAYLOAD_BYTES)) return response({ error: "payload_too_large" }, 413);
  const signature = request.headers.get("Linear-Signature");
  const secretValue = secret(env, "LINEAR_WEBHOOK_SECRET");
  if (!signature || !secretValue || !(await verifyHmac(secretValue, raw, signature))) return response({ error: "invalid_signature" }, 401);
  const id = await eventId(raw, request.headers.get("Linear-Delivery"));
  const first = await ingress(env.DB, id, "linear", "issue", await digest(raw));
  if (!first) return response({ accepted: true, duplicate: true }, 200);
  try {
    const job = await admit(raw, env);
    await insertRun(env.DB, job);
    await env.EXECUTION_QUEUE.send(job);
    await env.DB.prepare("UPDATE factory_ingress_events SET handoff_state='enqueued',enqueued_at=? WHERE event_id=?").bind(new Date().toISOString(), id).run();
    return response({ accepted: true, executionId: job.runId }, 202);
  } catch (error) {
    const reason = error instanceof AdmissionError ? error.message : "admission_failed";
    await env.DB.prepare("UPDATE factory_ingress_events SET handoff_state=? WHERE event_id=?").bind(`rejected:${reason}`, id).run();
    return response({ accepted: false, reason }, 202);
  }
}

async function verifyHmac(keyValue: string, body: string, signature: string): Promise<boolean> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(keyValue), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const expected = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
  const normalized = signature.trim().replace(/^sha256=/i, "");
  let supplied: Uint8Array;
  try { supplied = /^[0-9a-f]{64}$/i.test(normalized) ? new Uint8Array(normalized.match(/.{2}/g)!.map((pair) => parseInt(pair, 16))) : Uint8Array.from(atob(normalized), (char) => char.charCodeAt(0)); } catch { return false; }
  if (supplied.length !== expected.length) return false;
  let difference = 0;
  for (let index = 0; index < expected.length; index++) difference |= supplied[index] ^ expected[index];
  return difference === 0;
}

export class ExecutionWorkflow extends WorkflowEntrypoint<Env, Job> {
  async run(event: Readonly<WorkflowEvent<Job>>, step: WorkflowStep): Promise<ObjectValue> {
    const job = event.payload;
    type ExecutionResult = { status: "stopped" | "needs-human"; reason: string } | { success: boolean; stdout?: string; stderr?: string; exitCode?: number };
    const result = await step.do<ExecutionResult>("sandbox-execution", { retries: { limit: 1, delay: "30 seconds" }, timeout: "16 minutes" }, async (): Promise<ExecutionResult> => {
      if (await stopped(this.env.DB)) return { status: "stopped", reason: "stop_requested" };
      const token = secret(this.env, "GITHUB_TOKEN");
      if (!token || !secret(this.env, "OPENROUTER_API_KEY")) return { status: "needs-human", reason: "execution_credentials_missing" };
      const sandbox = getSandbox(this.env.Sandbox, `execution-${job.runId}`);
      const remote = `https://x-access-token:${token}@github.com/${job.contract.target.repository}.git`;
      await sandbox.gitCheckout(remote, { depth: 1, targetDir: "/workspace/project" });
      await sandbox.exec(`git -C /workspace/project remote set-url origin https://github.com/${job.contract.target.repository}.git`, { timeout: 30_000 });
      return await sandbox.exec(this.env.SANDBOX_COMMAND, { cwd: "/workspace/project", timeout: 15 * 60_000, env: { FACTORY_RUN_ID: job.runId, FACTORY_ISSUE: job.contract.linear.identifier, FACTORY_ISSUE_DESCRIPTION: "contract-bound; retrieve only through the job contract", FACTORY_REPOSITORY: job.contract.target.repository, FACTORY_BASE_SHA: job.contract.target.base_sha, FACTORY_MAX_ITERATIONS: "8", FACTORY_MAX_COMMANDS: "24", OPENROUTER_API_KEY: secret(this.env, "OPENROUTER_API_KEY"), OPENROUTER_MODEL: secret(this.env, "OPENROUTER_MODEL") } }) as ExecutionResult;
    });
    const namedStatus = "status" in result ? result.status : result.success ? "completed" : "failed";
    await step.do("record-result", async () => { await updateRun(this.env.DB, job.runId, namedStatus === "stopped" || namedStatus === "needs-human" ? namedStatus : namedStatus === "completed" ? "needs-human" : "failed", { reason: "status" in result ? result.reason : "sandbox_result", success: "success" in result ? result.success : false }); return { recorded: true }; });
    return { status: namedStatus, runId: job.runId };
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (url.pathname === "/health") return response({ ok: true, stopped: await stopped(env.DB), automaticMerge: false, source: "github-reviewable" });
      if (url.pathname === "/webhooks/linear" && request.method === "POST") return await acceptLinear(request, env);
      if (url.pathname === "/controls/stop" || url.pathname === "/controls/resume") {
        const admin = secret(env, "FACTORY_ADMIN_SECRET");
        if (request.method !== "POST" || !admin || request.headers.get("Authorization") !== `Bearer ${admin}`) return response({ error: "forbidden" }, 403);
        await env.DB.prepare("INSERT INTO control_flags(key,value,updated_at) VALUES('stop',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at").bind(String(url.pathname.endsWith("/stop")), new Date().toISOString()).run();
        return response({ stopped: await stopped(env.DB) });
      }
      return response({ error: "not_found" }, 404);
    } catch {
      return response({ error: "control_plane_unavailable" }, 503);
    }
  },
  async queue(batch: MessageBatch<Job>, env: Env): Promise<void> {
    for (const message of batch.messages) { const result = await schedule(env, message.body); if (["dispatched", "stopped", "blocked-by-dependency"].includes(result)) message.ack(); else message.retry(); }
  },
  async scheduled(_event: ScheduledEvent, env: Env): Promise<void> {
    if (await stopped(env.DB) || String(env.FACTORY_ENABLED) !== "true") return;
    const row = await env.DB.prepare("SELECT run_id,contract_json FROM factory_runs WHERE current_state IN ('admitted','queued') ORDER BY created_at LIMIT 1").first<{ run_id: string; contract_json: string }>();
    if (row) { const contract = JSON.parse(row.contract_json) as Contract; await schedule(env, { dispatchId: contract.dispatch_id, runId: row.run_id, contractDigest: await digest(contract), contract }); }
  },
};
