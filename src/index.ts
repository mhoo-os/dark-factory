import { admitLinear, eventId, AdmissionError } from "./admission";
import { verifyHmac, sha256Hex } from "./crypto";
import { activeExecutions, getExecution, insertExecution, isStopped, nextReady, recordWebhook, releaseLease, setExecutionState, setStopped, tryLease, type ExecutionJob } from "./ledger";
import { ExecutionWorkflow } from "./workflow";

type SecretEnv = { LINEAR_WEBHOOK_SECRET?: string; GITHUB_WEBHOOK_SECRET?: string; FACTORY_ADMIN_SECRET?: string; GITHUB_TOKEN?: string; OPENROUTER_API_KEY?: string; OPENROUTER_MODEL?: string };

export { ExecutionWorkflow };
export { Sandbox } from "@cloudflare/sandbox";

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

async function scheduleOne(env: Env, job: ExecutionJob): Promise<string> {
  if (await isStopped(env.DB)) return "stopped";
  const existing = await getExecution(env.DB, job.executionId);
  if (!existing) return "missing";
  if (!["admitted", "queued"].includes(existing.state)) return existing.state;
  const authoritativeJob: ExecutionJob = {
    executionId: existing.executionId, linearIssueId: existing.linearIssueId, identifier: existing.identifier,
    title: existing.title, description: existing.description, url: existing.url, repository: existing.repository, priority: existing.priority
  };
  if (!(await tryLease(env.DB, authoritativeJob.repository, authoritativeJob.executionId))) return "repo-busy";
  try {
    await env.EXECUTION_WORKFLOW.create({ id: authoritativeJob.executionId, params: authoritativeJob });
    await setExecutionState(env.DB, authoritativeJob.executionId, "dispatched");
    return "dispatched";
  } catch (error) {
    await setExecutionState(env.DB, authoritativeJob.executionId, "needs-human", { error: "workflow creation failed" });
    await releaseLease(env.DB, authoritativeJob.repository, authoritativeJob.executionId);
    console.error(JSON.stringify({ event: "workflow_create_failed", executionId: authoritativeJob.executionId, error: String(error) }));
    return "needs-human";
  }
}

async function admitRequest(request: Request, env: Env, source: "linear" | "github"): Promise<Response> {
  const secrets = env as Env & SecretEnv;
  const raw = await request.text();
  const signature = source === "linear" ? request.headers.get("Linear-Signature") : request.headers.get("X-Hub-Signature-256");
  const secret = source === "linear" ? secrets.LINEAR_WEBHOOK_SECRET : secrets.GITHUB_WEBHOOK_SECRET;
  if (!(await verifyHmac(secret, raw, signature))) return json({ error: "invalid signature" }, 401);
  const id = await eventId(raw, request.headers.get(source === "linear" ? "Linear-Delivery" : "X-GitHub-Delivery"));
  if (source === "github") {
    const accepted = await recordWebhook(env.DB, id, source, await sha256Hex(raw), "recorded", null);
    return json({ accepted, source }, accepted ? 202 : 200);
  }
  let job: ExecutionJob;
  try { job = await admitLinear(raw, env); } catch (error) {
    const reason = error instanceof AdmissionError ? error.message : "admission failed";
    await recordWebhook(env.DB, id, source, await sha256Hex(raw), "rejected", reason);
    return json({ accepted: false, reason }, 202);
  }
  const first = await recordWebhook(env.DB, id, source, await sha256Hex(raw), "accepted", null);
  await insertExecution(env.DB, job);
  if (!first) return json({ accepted: true, duplicate: true, executionId: job.executionId });
  await env.EXECUTION_QUEUE.send(job);
  return json({ accepted: true, executionId: job.executionId }, 202);
}

async function reconcile(env: Env): Promise<void> {
  for (const execution of await activeExecutions(env.DB)) {
    try {
      const instance = await env.EXECUTION_WORKFLOW.get(execution.workflow_id!);
      const status = await instance.status();
      if (status.status === "complete") {
        await setExecutionState(env.DB, execution.executionId, "succeeded", status.output);
        await releaseLease(env.DB, execution.repository, execution.executionId);
      } else if (["errored", "terminated"].includes(status.status)) {
        await setExecutionState(env.DB, execution.executionId, "needs-human", { workflow: status });
        await releaseLease(env.DB, execution.repository, execution.executionId);
      }
    } catch (error) {
      console.error(JSON.stringify({ event: "reconcile_failed", executionId: execution.executionId, error: String(error) }));
    }
  }
  const ready = await nextReady(env.DB);
  if (ready) await scheduleOne(env, {
    executionId: ready.executionId, linearIssueId: ready.linearIssueId, identifier: ready.identifier,
    title: ready.title, description: ready.description, url: ready.url, repository: ready.repository, priority: ready.priority
  });
}

const app = {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (url.pathname === "/health") return json({ ok: true, stopped: await isStopped(env.DB), automaticMerge: false });
      if (url.pathname === "/webhooks/linear" && request.method === "POST") return await admitRequest(request, env, "linear");
      if (url.pathname === "/webhooks/github" && request.method === "POST") return await admitRequest(request, env, "github");
      if (url.pathname === "/controls/stop" || url.pathname === "/controls/resume") {
        const secrets = env as Env & SecretEnv;
        if (request.method !== "POST" || !secrets.FACTORY_ADMIN_SECRET || request.headers.get("Authorization") !== `Bearer ${secrets.FACTORY_ADMIN_SECRET}`) return json({ error: "forbidden" }, 403);
        await setStopped(env.DB, url.pathname.endsWith("/stop"));
        return json({ stopped: await isStopped(env.DB) });
      }
      return json({ error: "not found" }, 404);
    } catch (error) {
      console.error(JSON.stringify({ event: "request_failed", error: String(error) }));
      return json({ error: "control plane unavailable" }, 503);
    }
  },
  async queue(batch: MessageBatch<ExecutionJob>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      const job = message.body;
      const result = await scheduleOne(env, job);
      if (result === "needs-human") console.warn(JSON.stringify({ event: "queue_message_held", executionId: job.executionId }));
    }
  },
  async scheduled(_event: ScheduledEvent, env: Env): Promise<void> {
    if (await isStopped(env.DB)) return;
    await reconcile(env);
  }
};

export default app;
