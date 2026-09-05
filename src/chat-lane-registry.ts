type Json = Record<string, unknown>;

const LANE_TYPES = new Set(["review", "planning"]);
const ACTIVE_STATUSES = new Set(["RUNNING", "PUBLISHING"]);
const SHA40 = /^[0-9a-f]{40}$/i;
const REPOSITORY = /^mhoo-os\/[a-z0-9][a-z0-9._-]{0,99}$/;
const ISSUE = /^MHO-[1-9][0-9]*$/;
const SAFE_ID = /^[A-Za-z0-9._:@/-]{1,256}$/;
const REVIEW_ID = /^MHOO-[A-Za-z0-9._-]{8,200}$/;
const VERDICT = /^(PASS|REQUEST CHANGES)$/;
const OPERATOR = /^[A-Za-z0-9._:@/-]{1,128}$/;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

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

function requiredObject(value: unknown, label: string): Json {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label}_invalid`);
  return value as Json;
}

function exactGithubCommentUrl(value: unknown, repository: string, prNumber: number): string {
  const url = optionalText(value, "github_output_url", /^https:\/\/github\.com\//, 2_048);
  if (!url) throw new Error("github_output_url_invalid");
  const match = url.match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)#issuecomment-(\d+)$/);
  if (!match || match[1] !== repository || Number(match[2]) !== prNumber) throw new Error("github_output_binding_invalid");
  return url;
}

function exactLinearCommentUrl(value: unknown, issueId: string): string {
  const url = optionalText(value, "linear_output_url", /^https:\/\/linear\.app\//, 2_048);
  if (!url) throw new Error("linear_output_url_invalid");
  const parsed = new URL(url);
  const parts = parsed.pathname.split("/").filter(Boolean);
  if (parsed.protocol !== "https:" || parsed.hostname !== "linear.app" || parts[0] !== "mhoo" ||
      parts[1] !== "issue" || parts[2] !== issueId || parts.length !== 4 ||
      !/^comment-[0-9a-f-]{36}$/i.test(parsed.hash.slice(1))) throw new Error("linear_output_binding_invalid");
  return url;
}

function concreteGithubOutputUrl(value: unknown): string {
  const url = optionalText(value, "github_output_url", /^https:\/\/github\.com\//, 2_048);
  if (!url) throw new Error("github_output_url_invalid");
  const parsed = new URL(url);
  const parts = parsed.pathname.split("/").filter(Boolean);
  if (parsed.protocol !== "https:" || parsed.hostname !== "github.com" || parts.length !== 4 ||
      !/^[A-Za-z0-9_.-]+$/.test(parts[0]) || !/^[A-Za-z0-9_.-]+$/.test(parts[1]) ||
      !["pull", "issues"].includes(parts[2]) || !/^\d+$/.test(parts[3]) ||
      !/^issuecomment-\d+$/.test(parsed.hash.slice(1))) throw new Error("github_output_binding_invalid");
  return url;
}

function assignmentIdentity(laneType: string, metadata: Json): { repository: string | null; prNumber: number | null; linearIssueId: string | null; targetHeadSha: string | null } {
  const repository = optionalText(metadata.repository, "repository", REPOSITORY);
  const prNumber = metadata.pr_number === undefined || metadata.pr_number === null ? null : Number(metadata.pr_number);
  if (prNumber !== null && (!Number.isSafeInteger(prNumber) || prNumber < 1)) throw new Error("pr_number_invalid");
  const linearIssueId = optionalText(metadata.linear_issue_id, "linear_issue_id", ISSUE);
  const targetHeadSha = optionalText(metadata.target_head_sha, "target_head_sha", SHA40);
  if (laneType === "review") {
    requiredText(metadata.review_id, "review_id", REVIEW_ID);
    requiredText(metadata.verdict, "verdict", VERDICT);
    if (!repository || !prNumber || !targetHeadSha || !linearIssueId) throw new Error("review_identity_incomplete");
  } else if (!linearIssueId && !optionalText(metadata.objective, "objective", SAFE_ID)) {
    throw new Error("planning_identity_incomplete");
  }
  return { repository, prNumber, linearIssueId, targetHeadSha };
}

function completionEvidence(laneType: string, assignment: Json, payload: Json): { linearUrl: string | null; githubUrl: string | null; outputDigest: string; attestedBy: string; attestedAt: string } {
  const manifest = requiredObject(payload.completion_manifest, "completion_manifest");
  const verification = requiredObject(manifest.verification, "verification");
  const attestedBy = requiredText(verification.attested_by, "attested_by", OPERATOR);
  const attestedAt = requiredText(verification.attested_at, "attested_at", ISO_TIME);
  if (verification.method !== "authenticated_operator_v1") throw new Error("verification_method_invalid");
  const outputDigest = requiredText(payload.output_digest, "output_digest", /^sha256:[0-9a-f]{64}$/i);
  if (laneType === "review") {
    const repository = requiredText(assignment.repository, "repository", REPOSITORY);
    const prNumber = Number(assignment.pr_number);
    const linearIssueId = requiredText(assignment.linear_issue_id, "linear_issue_id", ISSUE);
    const targetHeadSha = requiredText(assignment.target_head_sha, "target_head_sha", SHA40);
    const reviewId = requiredText(assignment.review_id, "review_id", REVIEW_ID);
    const verdict = requiredText(assignment.verdict, "verdict", VERDICT);
    if (!Number.isSafeInteger(prNumber) || prNumber < 1 ||
        manifest.repository !== repository || Number(manifest.pr_number) !== prNumber ||
        manifest.linear_issue_id !== linearIssueId || manifest.target_head_sha !== targetHeadSha ||
        manifest.review_id !== reviewId || manifest.verdict !== verdict) throw new Error("completion_binding_invalid");
    return {
      linearUrl: exactLinearCommentUrl(payload.linear_output_url, linearIssueId),
      githubUrl: exactGithubCommentUrl(payload.github_output_url, repository, prNumber),
      outputDigest, attestedBy, attestedAt,
    };
  }
  if ((assignment.linear_issue_id && manifest.linear_issue_id !== assignment.linear_issue_id) ||
      (assignment.objective && manifest.objective !== assignment.objective)) throw new Error("completion_binding_invalid");
  const linearUrl = assignment.linear_issue_id ? exactLinearCommentUrl(payload.linear_output_url, String(assignment.linear_issue_id)) : null;
  const githubUrl = payload.github_output_url === undefined ? null : concreteGithubOutputUrl(payload.github_output_url);
  if (!linearUrl && !githubUrl) throw new Error("completion_evidence_required");
  return { linearUrl, githubUrl, outputDigest, attestedBy, attestedAt };
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

async function registryReady(db: D1Database): Promise<boolean> {
  try {
    const meta = await db.prepare("SELECT schema_version FROM factory_schema_meta WHERE schema_name='factory-ledger'").first<{ schema_version: number }>();
    const trigger = await db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name='chat_lane_assignment_transition_guard_v2'").first();
    return Number(meta?.schema_version) >= 6 && Boolean(trigger);
  } catch { return false; }
}

export function isChatLaneAdmin(request: Request, adminSecret: string | null): boolean {
  return Boolean(adminSecret) && request.headers.get("Authorization") === `Bearer ${adminSecret}`;
}

async function register(request: Request, db: D1Database, laneId: string): Promise<Response> {
  const payload = await body(request);
  const chatId = requiredText(payload.chat_id, "chat_id", /^[A-Za-z0-9_-]{8,128}$/);
  const now = new Date().toISOString();
  const result = await db.prepare(
    "UPDATE chat_lanes SET chat_id=?,status='IDLE',updated_at=? WHERE lane_id=? AND status IN ('REPLACE','BLOCKED','IDLE') AND current_assignment_id IS NULL",
  ).bind(chatId, now, laneId).run();
  if (result.meta.changes < 1) return json({ error: "lane_not_registerable" }, 409);
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
  const { repository, prNumber, linearIssueId, targetHeadSha } = assignmentIdentity(laneType, metadata);

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
    "SELECT lane_id,lane_type,status,lease_fence,lease_expires_at,assignment_json FROM chat_lane_assignments WHERE assignment_id=? AND lease_token=?",
  ).bind(assignmentId, leaseToken).first<{ lane_id: string; lane_type: string; status: string; lease_fence: number; lease_expires_at: string; assignment_json: string }>();
  if (!current || !ACTIVE_STATUSES.has(current.status)) return json({ error: "lease_fenced" }, 409);
  if ((requested === "PUBLISHING" && current.status !== "RUNNING") ||
      (requested === "COMPLETED" && current.status !== "PUBLISHING")) return json({ error: "transition_denied" }, 409);

  let assignment: Json;
  try { assignment = JSON.parse(current.assignment_json) as Json; } catch { throw new Error("assignment_manifest_invalid"); }
  const now = new Date().toISOString();
  let evidence: { linearUrl: string | null; githubUrl: string | null; outputDigest: string | null; attestedBy: string | null; attestedAt: string | null };
  try {
    evidence = requested === "COMPLETED"
      ? completionEvidence(current.lane_type, assignment, payload)
      : { linearUrl: null, githubUrl: null, outputDigest: null, attestedBy: null, attestedAt: null };
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "completion_evidence_required" }, 422);
  }
  const assignmentStatus = requested === "REPLACE" ? "BLOCKED" : requested;
  const reason = requested === "REPLACE" ? "mho250-v2:replace" : "mho250-v2:operator_transition";
  // The migration trigger owns lane state and event insertion. Its guard raises
  // inside SQLite if the assignment/lane/token/fence/expiry snapshot no longer
  // agrees, which rolls this assignment update back instead of committing a split state.
  const result = await db.prepare(
    "UPDATE chat_lane_assignments SET status=?,transition_reason=?,linear_output_url=COALESCE(?,linear_output_url),github_output_url=COALESCE(?,github_output_url),output_digest=COALESCE(?,output_digest),verified_at=CASE WHEN ?='COMPLETED' THEN ? ELSE verified_at END,completed_at=CASE WHEN ?='COMPLETED' THEN ? ELSE completed_at END,attested_by=COALESCE(?,attested_by),attested_at=COALESCE(?,attested_at),updated_at=? WHERE assignment_id=? AND lease_token=? AND lease_fence=? AND status=? AND lease_expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now') AND EXISTS (SELECT 1 FROM chat_lanes WHERE lane_id=? AND current_assignment_id=? AND lease_token=? AND lease_fence=? AND status=?)",
  ).bind(assignmentStatus, reason, evidence.linearUrl, evidence.githubUrl, evidence.outputDigest, requested, now, requested, now, evidence.attestedBy, evidence.attestedAt, now, assignmentId, leaseToken, current.lease_fence, current.status, current.lane_id, assignmentId, leaseToken, current.lease_fence, current.status).run();
  if (result.meta.changes < 1) return json({ error: "lease_fenced_or_expired" }, 409);
  const laneStatus = requested === "COMPLETED" ? "IDLE" : requested === "REPLACE" ? "REPLACE" : assignmentStatus;
  return json({ assignment_id: assignmentId, lane_id: current.lane_id, status: assignmentStatus, lane_status: laneStatus });
}

export async function recoverExpiredChatLanes(db: D1Database, now = new Date()): Promise<number> {
  const timestamp = now.toISOString();
  const expired = await db.prepare(
    "SELECT lane_id,current_assignment_id,lease_token,lease_fence FROM chat_lanes WHERE status IN ('RUNNING','PUBLISHING') AND lease_expires_at<=? ORDER BY lane_id LIMIT 25",
  ).bind(timestamp).all<{ lane_id: string; current_assignment_id: string; lease_token: string; lease_fence: number }>();
  let recovered = 0;
  for (const lane of expired.results ?? []) {
    const result = await db.prepare(
      "UPDATE chat_lane_assignments SET status='BLOCKED',transition_reason='mho250-v2:lease_expired',updated_at=? WHERE assignment_id=? AND lease_token=? AND lease_fence=? AND status IN ('RUNNING','PUBLISHING') AND EXISTS (SELECT 1 FROM chat_lanes WHERE lane_id=? AND current_assignment_id=? AND lease_token=? AND lease_fence=? AND lease_expires_at<=?)",
    ).bind(timestamp, lane.current_assignment_id, lane.lease_token, lane.lease_fence, lane.lane_id, lane.current_assignment_id, lane.lease_token, lane.lease_fence, timestamp).run();
    if (result.meta.changes >= 1) recovered += 1;
  }
  return recovered;
}

export async function handleChatLaneRequest(request: Request, db: D1Database): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/chat-lane")) return null;
  if (!(await registryReady(db))) return json({ error: "registry_unready" }, 503);
  if (url.pathname === "/chat-lanes" && request.method === "GET") return await list(db);
  if (url.pathname === "/chat-lanes/lease" && request.method === "POST") return await lease(request, db);
  if (url.pathname === "/chat-lanes/recover" && request.method === "POST") return json({ recovered: await recoverExpiredChatLanes(db) });
  const registerMatch = url.pathname.match(/^\/chat-lanes\/(review|planning)-([1-5])$/);
  if (registerMatch && request.method === "PUT") return await register(request, db, `${registerMatch[1]}-${registerMatch[2]}`);
  const transitionMatch = url.pathname.match(/^\/chat-lane-assignments\/(assignment-[0-9a-f-]{36})$/i);
  if (transitionMatch && request.method === "POST") return await transition(request, db, transitionMatch[1]);
  return json({ error: "not_found" }, 404);
}
