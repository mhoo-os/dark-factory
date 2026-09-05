type Json = Record<string, unknown>;

const LANE_TYPES = new Set(["review", "planning"]);
const ACTIVE_STATUSES = new Set(["RUNNING", "PUBLISHING"]);
const SHA40 = /^[0-9a-f]{40}$/i;
const REPOSITORY = /^mhoo-os\/[a-z0-9][a-z0-9._-]{0,99}$/;
const ISSUE = /^MHO-[1-9][0-9]*$/;
const SAFE_ID = /^[A-Za-z0-9._:@/-]{1,256}$/;

function json(body: Json, status = 200): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

async function body(request: Request): Promise<Json> {
  const length = Number(request.headers.get("Content-Length") ?? "0");
  if (Number.isFinite(length) && length > 16_384) throw new Error("payload_too_large");
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > 16_384) throw new Error("payload_too_large");
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error("invalid_json"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid_json");
  return parsed as Json;
}

function requiredText(value: unknown, label: string, pattern = SAFE_ID): string {
  if (typeof value !== "string" || !pattern.test(value)) throw new Error(`${label}_invalid`);
  return value;
}

function optionalText(value: unknown, label: string, pattern: RegExp, maximum = 512): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.length > maximum || !pattern.test(value)) throw new Error(`${label}_invalid`);
  return value;
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    const item = value as Json;
    return `{${Object.keys(item).sort().map((key) => `${JSON.stringify(key)}:${stable(item[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

async function digest(value: unknown): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(stable(value)));
  return `sha256:${Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

async function list(db: D1Database): Promise<Response> {
  const lanes = await db.prepare(
    "SELECT lane_id,lane_type,slot,chat_id,status,lease_fence,lease_expires_at,current_assignment_id,updated_at FROM chat_lanes ORDER BY lane_type,slot",
  ).all();
  return json({ lanes: lanes.results ?? [] });
}

async function register(request: Request, db: D1Database, laneId: string): Promise<Response> {
  const payload = await body(request);
  const chatId = requiredText(payload.chat_id, "chat_id", /^[A-Za-z0-9_-]{8,128}$/);
  const now = new Date().toISOString();
  const result = await db.prepare(
    "UPDATE chat_lanes SET chat_id=?,status='IDLE',updated_at=? WHERE lane_id=? AND status IN ('REPLACE','BLOCKED','IDLE') AND current_assignment_id IS NULL",
  ).bind(chatId, now, laneId).run();
  if (result.meta.changes !== 1) return json({ error: "lane_not_registerable" }, 409);
  return json({ lane_id: laneId, chat_id: chatId, status: "IDLE" });
}

async function lease(request: Request, db: D1Database): Promise<Response> {
  const payload = await body(request);
  const laneType = requiredText(payload.lane_type, "lane_type");
  if (!LANE_TYPES.has(laneType)) throw new Error("lane_type_invalid");
  const idempotencyKey = requiredText(payload.idempotency_key, "idempotency_key");
  const assignment = payload.assignment;
  if (!assignment || typeof assignment !== "object" || Array.isArray(assignment)) throw new Error("assignment_invalid");
  const metadata = assignment as Json;
  const repository = optionalText(metadata.repository, "repository", REPOSITORY);
  const prNumber = metadata.pr_number === undefined || metadata.pr_number === null ? null : Number(metadata.pr_number);
  if (prNumber !== null && (!Number.isSafeInteger(prNumber) || prNumber < 1)) throw new Error("pr_number_invalid");
  const linearIssueId = optionalText(metadata.linear_issue_id, "linear_issue_id", ISSUE);
  const targetHeadSha = optionalText(metadata.target_head_sha, "target_head_sha", SHA40);
  if (laneType === "review" && (!repository || !prNumber || !targetHeadSha)) throw new Error("review_identity_incomplete");

  const requestDigest = await digest({ lane_type: laneType, assignment: metadata });
  const existing = await db.prepare(
    "SELECT assignment_id,request_digest,lane_id,lease_token,lease_fence,lease_expires_at,status FROM chat_lane_assignments WHERE idempotency_key=?",
  ).bind(idempotencyKey).first<Record<string, unknown>>();
  if (existing) {
    if (existing.request_digest !== requestDigest) return json({ error: "idempotency_conflict" }, 409);
    return json({ duplicate: true, ...existing });
  }

  const now = new Date();
  const requestedSeconds = Number(payload.lease_seconds ?? 1_800);
  if (!Number.isSafeInteger(requestedSeconds) || requestedSeconds < 60 || requestedSeconds > 3_600) throw new Error("lease_seconds_invalid");
  const assignmentId = `assignment-${crypto.randomUUID()}`;
  const leaseToken = crypto.randomUUID();
  const expiresAt = new Date(now.getTime() + requestedSeconds * 1_000).toISOString();
  try {
    await db.prepare(
      "INSERT INTO chat_lane_assignments(assignment_id,idempotency_key,request_digest,lane_type,lease_token,lease_expires_at,status,repository,pr_number,linear_issue_id,target_head_sha,assignment_json,created_at,updated_at) VALUES(?,?,?,?,?,?,'RUNNING',?,?,?,?,?,?,?)",
    ).bind(assignmentId, idempotencyKey, requestDigest, laneType, leaseToken, expiresAt, repository, prNumber, linearIssueId, targetHeadSha, stable(metadata), now.toISOString(), now.toISOString()).run();
  } catch (error) {
    const raced = await db.prepare(
      "SELECT assignment_id,request_digest,lane_id,lease_token,lease_fence,lease_expires_at,status FROM chat_lane_assignments WHERE idempotency_key=?",
    ).bind(idempotencyKey).first<Record<string, unknown>>();
    if (raced) {
      if (raced.request_digest !== requestDigest) return json({ error: "idempotency_conflict" }, 409);
      return json({ duplicate: true, ...raced });
    }
    if (error instanceof Error && error.message.includes("chat_lane_unavailable")) return json({ error: "no_lane_available" }, 409);
    throw error;
  }
  const created = await db.prepare(
    "SELECT assignment_id,lane_id,lease_token,lease_fence,lease_expires_at,status FROM chat_lane_assignments WHERE assignment_id=?",
  ).bind(assignmentId).first<Record<string, unknown>>();
  if (!created?.lane_id) throw new Error("lane_allocation_not_confirmed");
  return json({ duplicate: false, ...created }, 201);
}

async function transition(request: Request, db: D1Database, assignmentId: string): Promise<Response> {
  const payload = await body(request);
  const leaseToken = requiredText(payload.lease_token, "lease_token", /^[0-9a-f-]{36}$/i);
  const requested = requiredText(payload.status, "status", /^[A-Z]+$/);
  if (!["PUBLISHING", "COMPLETED", "BLOCKED", "REPLACE"].includes(requested)) throw new Error("status_invalid");
  const current = await db.prepare(
    "SELECT lane_id,status,lease_fence FROM chat_lane_assignments WHERE assignment_id=? AND lease_token=?",
  ).bind(assignmentId, leaseToken).first<{ lane_id: string; status: string; lease_fence: number }>();
  if (!current || !ACTIVE_STATUSES.has(current.status)) return json({ error: "lease_fenced" }, 409);
  if (requested === "PUBLISHING" && current.status !== "RUNNING") return json({ error: "transition_denied" }, 409);

  const linearUrl = optionalText(payload.linear_output_url, "linear_output_url", /^https:\/\/linear\.app\//, 2_048);
  const githubUrl = optionalText(payload.github_output_url, "github_output_url", /^https:\/\/github\.com\//, 2_048);
  const outputDigest = optionalText(payload.output_digest, "output_digest", /^sha256:[0-9a-f]{64}$/i, 71);
  const now = new Date().toISOString();
  if (requested === "COMPLETED" && (!outputDigest || (!linearUrl && !githubUrl))) return json({ error: "completion_evidence_required" }, 422);
  const laneStatus = requested === "COMPLETED" ? "IDLE" : requested;
  const assignmentStatus = requested === "REPLACE" ? "BLOCKED" : requested;
  const release = requested !== "PUBLISHING";
  const eventDigest = await digest(payload);
  const results = await db.batch([
    db.prepare(
      release
        ? "UPDATE chat_lanes SET status=?,chat_id=CASE WHEN ?='REPLACE' THEN NULL ELSE chat_id END,lease_token=NULL,lease_expires_at=NULL,current_assignment_id=NULL,updated_at=? WHERE lane_id=? AND current_assignment_id=? AND lease_token=? AND lease_fence=?"
        : "UPDATE chat_lanes SET status='PUBLISHING',updated_at=? WHERE lane_id=? AND current_assignment_id=? AND lease_token=? AND lease_fence=?",
    ).bind(...(release ? [laneStatus, requested, now, current.lane_id, assignmentId, leaseToken, current.lease_fence] : [now, current.lane_id, assignmentId, leaseToken, current.lease_fence])),
    db.prepare(
      "UPDATE chat_lane_assignments SET status=?,linear_output_url=COALESCE(?,linear_output_url),github_output_url=COALESCE(?,github_output_url),output_digest=COALESCE(?,output_digest),verified_at=CASE WHEN ?='COMPLETED' THEN ? ELSE verified_at END,completed_at=CASE WHEN ?='COMPLETED' THEN ? ELSE completed_at END,updated_at=? WHERE assignment_id=? AND lease_token=? AND lease_fence=? AND status=?",
    ).bind(assignmentStatus, linearUrl, githubUrl, outputDigest, requested, now, requested, now, now, assignmentId, leaseToken, current.lease_fence, current.status),
    db.prepare("INSERT INTO chat_lane_events(event_id,assignment_id,event_type,payload_digest,created_at) VALUES(?,?,?,?,?)")
      .bind(`transition:${assignmentId}:${current.lease_fence}:${requested}`, assignmentId, requested, eventDigest, now),
  ]);
  if (results[0].meta.changes !== 1 || results[1].meta.changes !== 1) throw new Error("lane_transition_raced");
  return json({ assignment_id: assignmentId, lane_id: current.lane_id, status: assignmentStatus, lane_status: laneStatus });
}

export async function recoverExpiredChatLanes(db: D1Database, now = new Date()): Promise<number> {
  const timestamp = now.toISOString();
  const expired = await db.prepare(
    "SELECT lane_id,current_assignment_id,lease_token,lease_fence FROM chat_lanes WHERE status IN ('RUNNING','PUBLISHING') AND lease_expires_at<=? ORDER BY lane_id LIMIT 25",
  ).bind(timestamp).all<{ lane_id: string; current_assignment_id: string; lease_token: string; lease_fence: number }>();
  let recovered = 0;
  for (const lane of expired.results ?? []) {
    const eventDigest = await digest({ reason: "lease_expired", lease_fence: lane.lease_fence });
    const results = await db.batch([
      db.prepare("UPDATE chat_lanes SET status='BLOCKED',lease_token=NULL,lease_expires_at=NULL,current_assignment_id=NULL,updated_at=? WHERE lane_id=? AND current_assignment_id=? AND lease_token=? AND lease_fence=? AND lease_expires_at<=?")
        .bind(timestamp, lane.lane_id, lane.current_assignment_id, lane.lease_token, lane.lease_fence, timestamp),
      db.prepare("UPDATE chat_lane_assignments SET status='BLOCKED',updated_at=? WHERE assignment_id=? AND lease_token=? AND lease_fence=? AND status IN ('RUNNING','PUBLISHING')")
        .bind(timestamp, lane.current_assignment_id, lane.lease_token, lane.lease_fence),
      db.prepare("INSERT OR IGNORE INTO chat_lane_events(event_id,assignment_id,event_type,payload_digest,created_at) VALUES(?,?,?,?,?)")
        .bind(`expiry:${lane.current_assignment_id}:${lane.lease_fence}`, lane.current_assignment_id, "LEASE_EXPIRED", eventDigest, timestamp),
    ]);
    if (results[0].meta.changes === 1 && results[1].meta.changes === 1) recovered += 1;
  }
  return recovered;
}

export async function handleChatLaneRequest(request: Request, db: D1Database): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname === "/chat-lanes" && request.method === "GET") return await list(db);
  if (url.pathname === "/chat-lanes/lease" && request.method === "POST") return await lease(request, db);
  if (url.pathname === "/chat-lanes/recover" && request.method === "POST") return json({ recovered: await recoverExpiredChatLanes(db) });
  const registerMatch = url.pathname.match(/^\/chat-lanes\/(review|planning)-([1-5])$/);
  if (registerMatch && request.method === "PUT") return await register(request, db, `${registerMatch[1]}-${registerMatch[2]}`);
  const transitionMatch = url.pathname.match(/^\/chat-lane-assignments\/(assignment-[0-9a-f-]{36})$/i);
  if (transitionMatch && request.method === "POST") return await transition(request, db, transitionMatch[1]);
  if (url.pathname.startsWith("/chat-lane")) return json({ error: "not_found" }, 404);
  return null;
}
