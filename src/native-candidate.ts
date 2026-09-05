/** Source-only mock seam. No route, scheduler, credential, publisher or retry owner. */
const PREFIX = "native-candidate:v1:";
const MOCK_PIN = "ba81c1b65d13a573144acda2708f57d870eb176b647715b7d86c294d7f71ef88";
const SHA = /^[0-9a-f]{40}$/;
const DIGEST = /^[0-9a-f]{64}$/;

type Run = {
  run_id: string; dispatch_id: string; contract_digest: string; linear_issue_id: string;
  linear_identifier: string; repository: string; collision_group: string; base_sha: string;
  head_sha: string | null; branch: string; pr_number: number | null; lease_fence: number;
  factory_id: string; registry_version: string; registry_digest: string; registry_entry_version: string;
};
export type NativeIntent = {
  mode: "mock-only"; attempt: 0; attemptId: string; deadlineMs: number;
  requestDigest: string; mockPin: string; run: Run;
};
export type CandidateObservation = {
  status: "candidate" | "failed" | "ambiguous" | "cancelled" | "expired";
  resultDigest: string; headSha: string | null; processStopped: boolean;
  usage: null; usageStatus: "UNKNOWN";
};
type Step = { result_json: string };
type Runner = (request: { attemptId: string; deadlineMs: number; checkCurrentGrant: () => Promise<boolean> }) => Promise<CandidateObservation>;

async function hash(value: string): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))), x => x.toString(16).padStart(2, "0")).join("");
}

// SQL checks and the claim INSERT share a statement, so stop/fence changes cannot
// race between a successful pre-read and a persisted launch. Slot 1 is deliberate:
// this first increment permits concurrency one only, within all four domains.
const CURRENT = `r.run_id=? AND r.dispatch_id=? AND r.contract_digest=?
 AND r.linear_issue_id=? AND r.linear_identifier=? AND r.repository=? AND r.collision_group=?
 AND r.base_sha=? AND COALESCE(r.head_sha,r.base_sha)=? AND r.branch=? AND r.pr_number IS ?
 AND r.factory_id=? AND r.registry_version=? AND r.registry_digest=? AND r.registry_entry_version=?
 AND r.current_state='running' AND r.lease_owner='workflow' AND r.lease_fence=?
 AND julianday(r.lease_expires_at)>julianday(?)
 AND (SELECT value FROM control_flags WHERE key='stop')='false'
 AND EXISTS(SELECT 1 FROM factory_lease_reservations q WHERE q.reservation_id=r.lease_fence AND q.run_id=r.run_id)
 AND (SELECT COUNT(*) FROM factory_lease_members m WHERE m.reservation_id=r.lease_fence)=4
 AND (SELECT COUNT(*) FROM factory_lease_members m JOIN factory_leases l ON l.lease_key=m.lease_key
   WHERE m.reservation_id=r.lease_fence AND l.owner='workflow' AND l.dispatch_id=r.run_id
   AND l.factory_id=r.factory_id AND l.registry_version=r.registry_version
   AND l.registry_digest=r.registry_digest AND l.registry_entry_version=r.registry_entry_version
   AND julianday(l.expires_at)>julianday(?)
   AND l.lease_key IN ('global:1','factory:'||r.factory_id||':1',
     'repository:'||r.repository||':1','collision:'||r.collision_group||':1'))=4`;

function bindings(intent: NativeIntent, now: number): unknown[] {
  const r = intent.run;
  return [r.run_id,r.dispatch_id,r.contract_digest,r.linear_issue_id,r.linear_identifier,r.repository,r.collision_group,
    r.base_sha,r.head_sha ?? r.base_sha,r.branch,r.pr_number,r.factory_id,r.registry_version,r.registry_digest,
    r.registry_entry_version,r.lease_fence,new Date(now).toISOString(),new Date(now).toISOString()];
}

async function step(db: D1Database, runId: string, key: string): Promise<Step | null> {
  return db.prepare("SELECT result_json FROM factory_steps WHERE run_id=? AND step_key=?").bind(runId,PREFIX+key).first<Step>();
}

async function insert(db: D1Database, intent: NativeIntent, key: string, payload: string, now: number, guarded: boolean): Promise<boolean> {
  if (guarded && now >= intent.deadlineMs) return false;
  const result = await db.prepare(`INSERT INTO factory_steps(run_id,step_key,status,result_json,
    factory_id,registry_version,registry_digest,registry_entry_version,updated_at)
    SELECT r.run_id,?,'observation',?,?,?,?,?,?
    FROM factory_runs r WHERE ${guarded ? CURRENT : "r.run_id=?"}
    AND NOT EXISTS(SELECT 1 FROM factory_steps s WHERE s.run_id=r.run_id AND s.step_key=?)
    ON CONFLICT(run_id,step_key) DO NOTHING`).bind(PREFIX+key,payload,intent.run.factory_id,intent.run.registry_version,
      intent.run.registry_digest,intent.run.registry_entry_version,new Date(now).toISOString(),
      ...(guarded ? bindings(intent,now) : [intent.run.run_id]),PREFIX+key).run();
  return result.meta.changes === 1;
}

async function requireIntent(db: D1Database, intent: NativeIntent): Promise<void> {
  const stored = await step(db,intent.run.run_id,"intent");
  if (stored?.result_json !== JSON.stringify(intent)) throw new Error("native_intent_conflict");
}

export async function currentNativeGrant(db: D1Database, intent: NativeIntent, now = Date.now()): Promise<boolean> {
  await requireIntent(db,intent);
  if (now >= intent.deadlineMs) return false;
  return Boolean(await db.prepare(`SELECT r.run_id FROM factory_runs r WHERE ${CURRENT}`).bind(...bindings(intent,now)).first());
}

/** Called only by a trusted Cloudflare workflow after existing admission checks.
 * requestDigest binds its approved bounded task. A second intent for this run
 * cannot reset deadline/budget/fence, even after completion or an uncertain start.
 */
export async function reserveMockAttempt(db: D1Database, request: {
  runId: string; contractDigest: string; expectedHeadSha: string; requestDigest: string;
  deadlineMs: number;
}, now = Date.now()): Promise<NativeIntent> {
  if (!DIGEST.test(request.requestDigest) || !SHA.test(request.expectedHeadSha)
    || !Number.isSafeInteger(request.deadlineMs) || request.deadlineMs <= now || request.deadlineMs > now+30_000) {
    throw new Error("native_request_invalid");
  }
  const schema = await db.prepare("SELECT schema_version FROM factory_schema_meta WHERE schema_name='native-candidate-receipts'").first<{schema_version: number}>();
  if (schema?.schema_version !== 1) throw new Error("native_schema_unverified");
  const r = await db.prepare(`SELECT run_id,dispatch_id,contract_digest,linear_issue_id,linear_identifier,
    repository,collision_group,base_sha,head_sha,branch,pr_number,lease_fence,
    factory_id,registry_version,registry_digest,registry_entry_version FROM factory_runs WHERE run_id=?`).bind(request.runId).first<Run>();
  if (!r || r.contract_digest !== request.contractDigest || (r.head_sha ?? r.base_sha) !== request.expectedHeadSha
    || !SHA.test(r.base_sha) || !/^factory\/[a-z0-9-]+$/.test(r.branch)
    || !Number.isSafeInteger(r.lease_fence) || r.lease_fence < 1) throw new Error("native_run_binding_invalid");
  const intent: NativeIntent = { mode: "mock-only", attempt: 0,
    attemptId: await hash(r.run_id+":native-candidate:v1:0"), deadlineMs: request.deadlineMs,
    requestDigest: request.requestDigest, mockPin: MOCK_PIN, run: r };
  const payload = JSON.stringify(intent);
  if (!await insert(db,intent,"intent",payload,now,true)) {
    const existing = await step(db,r.run_id,"intent");
    if (existing?.result_json !== payload) throw new Error("native_intent_conflict_or_inactive");
  }
  return intent;
}

/** Persist launch before crossing the process boundary. Never resend a claim.
 * revalidate is trusted Cloudflare head/registry/contract readback, never a runner
 * assertion. This source increment only accepts a mock runner; no live transport
 * or publication path is provided. Unknown usage remains unknown in every receipt.
 */
export async function deliverMockAttempt(db: D1Database, input: NativeIntent, runner: Runner,
  revalidate: () => Promise<boolean>, clock = Date.now): Promise<{ disposition: string; receiptDigest?: string; publicationAllowed: false }> {
  // Copy caller-owned data before any await; mutations cannot retarget a launch.
  const intent: NativeIntent = JSON.parse(JSON.stringify(input));
  await requireIntent(db,intent);
  const checkCurrentGrant = async () => await currentNativeGrant(db,intent,clock())
    && await revalidate() === true && await currentNativeGrant(db,intent,clock());
  let active = false;
  try { active = await checkCurrentGrant(); } catch { /* unavailable authority refuses */ }
  if (!active) return { disposition: "inactive", publicationAllowed: false };
  const launch = JSON.stringify({ attemptId: intent.attemptId, intentDigest: await hash(JSON.stringify(intent)) });
  if (!await insert(db,intent,"launch",launch,clock(),true)) {
    // Includes crash before spawn, after acceptance and before observation storage.
    return { disposition: "ambiguous-no-resend", publicationAllowed: false };
  }
  let result: CandidateObservation;
  try {
    const raw = await runner({ attemptId: intent.attemptId, deadlineMs: intent.deadlineMs, checkCurrentGrant });
    if (!["candidate","failed","ambiguous","cancelled","expired"].includes(raw.status)
      || !DIGEST.test(raw.resultDigest) || typeof raw.processStopped !== "boolean"
      || (raw.headSha !== null && !SHA.test(raw.headSha)) || raw.usage !== null || raw.usageStatus !== "UNKNOWN"
      || (raw.status === "candidate" && (!raw.headSha || !raw.processStopped))) throw new Error("invalid_observation");
    // Whitelist only bounded receipt fields; raw errors/stdout/auth never persist.
    result = { status: raw.status, resultDigest: raw.resultDigest, headSha: raw.headSha,
      processStopped: raw.processStopped, usage: null, usageStatus: "UNKNOWN" };
  } catch {
    result = { status: "ambiguous", resultDigest: await hash("unavailable"), headSha: null,
      processStopped: false, usage: null, usageStatus: "UNKNOWN" };
  }
  try { active = await checkCurrentGrant(); } catch { active = false; }
  const disposition = active && result.status === "candidate" ? "mock-candidate-recorded" : "quarantined";
  const receipt = JSON.stringify({ intent, launchDigest: await hash(launch), observedAt: clock(), result, disposition,
    publicationAllowed: false });
  const receiptDigest = await hash(receipt);
  // Late results are retained as audit observations, never thrown away or treated
  // as permission to publish/release a replacement lease. D1 failure propagates.
  await insert(db,intent,"receipt:"+receiptDigest,receipt,clock(),false);
  return { disposition, receiptDigest, publicationAllowed: false };
}
