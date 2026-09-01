export type RuntimeEnv = Pick<Env, "DB" | "EXECUTION_QUEUE" | "EXECUTION_WORKFLOW">;

export type ExecutionJob = {
  executionId: string;
  linearIssueId: string;
  identifier: string;
  title: string;
  description: string;
  url: string;
  repository: string;
  priority: number;
};

export type ExecutionRow = ExecutionJob & {
  state: string;
  workflow_id: string | null;
  lease_expires_at: string | null;
  attempt_count: number;
};

export async function recordWebhook(db: D1Database, eventId: string, source: "linear" | "github", bodySha256: string, decision: string, reason: string | null): Promise<boolean> {
  const result = await db.prepare(
    "INSERT OR IGNORE INTO webhook_events (event_id, source, body_sha256, decision, reason, received_at) VALUES (?, ?, ?, ?, ?, ?)"
  ).bind(eventId, source, bodySha256, decision, reason, new Date().toISOString()).run();
  return result.meta.changes === 1;
}

export async function insertExecution(db: D1Database, job: ExecutionJob): Promise<void> {
  const now = new Date().toISOString();
  await db.prepare(`INSERT OR IGNORE INTO executions
    (execution_id, linear_issue_id, linear_identifier, linear_url, title, description, repository, priority, state, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'admitted', ?, ?)`)
    .bind(job.executionId, job.linearIssueId, job.identifier, job.url, job.title, job.description, job.repository, job.priority, now, now).run();
}

export async function getExecution(db: D1Database, executionId: string): Promise<ExecutionRow | null> {
  return await db.prepare(`SELECT execution_id as executionId, linear_issue_id as linearIssueId,
    linear_identifier as identifier, linear_url as url, title, description, repository, priority,
    state, workflow_id, lease_expires_at, attempt_count
    FROM executions WHERE execution_id = ?`).bind(executionId).first<ExecutionRow>();
}

export async function setExecutionState(db: D1Database, executionId: string, state: string, result?: unknown): Promise<void> {
  await db.prepare("UPDATE executions SET state = ?, result_json = COALESCE(?, result_json), updated_at = ? WHERE execution_id = ?")
    .bind(state, result === undefined ? null : JSON.stringify(result), new Date().toISOString(), executionId).run();
}

export async function tryLease(db: D1Database, repository: string, executionId: string, leaseMinutes = 30): Promise<boolean> {
  const now = new Date().toISOString();
  const expiry = new Date(Date.now() + leaseMinutes * 60_000).toISOString();
  await db.prepare("INSERT OR IGNORE INTO repo_leases (repository, execution_id, lease_expires_at) VALUES (?, '', ?)").bind(repository, "1970-01-01T00:00:00.000Z").run();
  const result = await db.prepare(`UPDATE repo_leases SET execution_id = ?, lease_expires_at = ?
    WHERE repository = ? AND lease_expires_at <= ?`).bind(executionId, expiry, repository, now).run();
  if (result.meta.changes === 1) {
    await db.prepare("UPDATE executions SET lease_expires_at = ?, state = 'queued', updated_at = ? WHERE execution_id = ?").bind(expiry, now, executionId).run();
    return true;
  }
  return false;
}

export async function releaseLease(db: D1Database, repository: string, executionId: string): Promise<void> {
  await db.prepare("DELETE FROM repo_leases WHERE repository = ? AND execution_id = ?").bind(repository, executionId).run();
  await db.prepare("UPDATE executions SET lease_expires_at = NULL, updated_at = ? WHERE execution_id = ?").bind(new Date().toISOString(), executionId).run();
}

export async function nextReady(db: D1Database): Promise<ExecutionRow | null> {
  return await db.prepare(`SELECT execution_id as executionId, linear_issue_id as linearIssueId,
    linear_identifier as identifier, linear_url as url, title, description, repository, priority,
    state, workflow_id, lease_expires_at, attempt_count
    FROM executions WHERE state IN ('admitted','queued') ORDER BY priority ASC, created_at ASC LIMIT 1`).first<ExecutionRow>();
}

export async function activeExecutions(db: D1Database): Promise<ExecutionRow[]> {
  const result = await db.prepare(`SELECT execution_id as executionId, linear_issue_id as linearIssueId,
    linear_identifier as identifier, linear_url as url, title, description, repository, priority,
    state, workflow_id, lease_expires_at, attempt_count
    FROM executions WHERE state IN ('dispatched','running') AND workflow_id IS NOT NULL
    ORDER BY updated_at ASC LIMIT 50`).all<ExecutionRow>();
  return result.results;
}

export async function isStopped(db: D1Database): Promise<boolean> {
  const row = await db.prepare("SELECT value FROM control_flags WHERE key = 'stop'").first<{ value: string }>();
  return row?.value === "true";
}

export async function setStopped(db: D1Database, stopped: boolean): Promise<void> {
  await db.prepare("INSERT INTO control_flags (key, value, updated_at) VALUES ('stop', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
    .bind(String(stopped), new Date().toISOString()).run();
}
