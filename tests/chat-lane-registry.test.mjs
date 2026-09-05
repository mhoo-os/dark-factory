import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { handleChatLaneRequest, isChatLaneAdmin, recoverExpiredChatLanes } from "../src/chat-lane-registry.ts";

const migration4 = await readFile(new URL("../migrations/0004_chat_lane_registry.sql", import.meta.url), "utf8");
const migration5 = await readFile(new URL("../migrations/0005_chat_lane_transition_guards.sql", import.meta.url), "utf8");
const migration6 = await readFile(new URL("../migrations/0006_chat_lane_activation_guard.sql", import.meta.url), "utf8");
const source = await readFile(new URL("../src/chat-lane-registry.ts", import.meta.url), "utf8");
const index = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");

function db() {
  const database = new DatabaseSync(":memory:");
  database.exec("CREATE TABLE factory_schema_meta(schema_name TEXT PRIMARY KEY, schema_version INTEGER NOT NULL)");
  database.exec(migration4);
  database.exec(migration5);
  database.exec(migration6);
  database.prepare("UPDATE chat_lanes SET chat_id=?,status='IDLE',updated_at=? WHERE lane_id='review-1'").run("chat-review-0001", "2026-09-05T00:00:00.000Z");
  return database;
}

class D1 {
  constructor(database, triggerInclusive = false) { this.database = database; this.triggerInclusive = triggerInclusive; }
  prepare(sql) {
    let values = [];
    const thisDatabase = this.database;
    const triggerInclusive = this.triggerInclusive;
    return {
      bind(...next) { values = next; return this; },
      async run() { const result = thisDatabase.prepare(sql).run(...values); return { meta: { changes: result.changes === 0 ? 0 : triggerInclusive ? 3 : result.changes } }; },
      async first() { return thisDatabase.prepare(sql).get(...values) ?? null; },
      async all() { return { results: thisDatabase.prepare(sql).all(...values) }; },
    };
  }
  async batch(statements) { return await Promise.all(statements.map((statement) => statement.run())); }
}

function lease(database, id, expiresAt = "2099-09-05T00:10:00.000Z") {
  database.prepare("INSERT INTO chat_lane_assignments(assignment_id,idempotency_key,request_digest,lane_type,lease_token,lease_expires_at,status,repository,pr_number,linear_issue_id,target_head_sha,assignment_json,created_at,updated_at) VALUES(?,?,?,?,?,?,'RUNNING',?,?,?,?,?,?,?)").run(
    id, `key-${id}`, `digest-${id}`, "review", `00000000-0000-4000-8000-${id.slice(-12).padStart(12, "0")}`, expiresAt,
    "mhoo-os/dark-factory", 29, "MHO-250", "be74f4d21d6be28751d62734dcbb4716db382cc6",
    JSON.stringify({ repository: "mhoo-os/dark-factory", pr_number: 29, linear_issue_id: "MHO-250", target_head_sha: "be74f4d21d6be28751d62734dcbb4716db382cc6", review_id: "MHOO-RL3-MHO-250-PR29-be74f4d21d6b-R1", verdict: "REQUEST CHANGES" }),
    "2026-09-05T00:00:00.000Z", "2026-09-05T00:00:00.000Z",
  );
  return database.prepare("SELECT * FROM chat_lane_assignments WHERE assignment_id=?").get(id);
}

function transition(database, assignment, status, reason, at) {
  return database.prepare("UPDATE chat_lane_assignments SET status=?,transition_reason=?,updated_at=? WHERE assignment_id=? AND lease_token=? AND lease_fence=? AND status=?").run(
    status, `mho250-v2:${reason}`, at, assignment.assignment_id, assignment.lease_token, assignment.lease_fence, assignment.status,
  );
}

test("fresh migration provisions ten fail-closed slots and the additive guard schema", () => {
  const database = db();
  assert.equal(database.prepare("SELECT count(*) AS n FROM chat_lanes").get().n, 10);
  assert.equal(database.prepare("SELECT count(*) AS n FROM chat_lanes WHERE status='REPLACE'").get().n, 9);
  const columns = database.prepare("PRAGMA table_info(chat_lane_assignments)").all().map((row) => row.name);
  assert.deepEqual(columns.filter((name) => ["transition_reason", "attested_by", "attested_at"].includes(name)).sort(), ["attested_at", "attested_by", "transition_reason"]);
  assert.equal(database.prepare("SELECT schema_version AS version FROM factory_schema_meta WHERE schema_name='factory-ledger'").get().version, 6);
});

test("a winning completion atomically releases the lane and writes exactly one truthful event", () => {
  const database = db();
  const assignment = lease(database, "assignment-00000000-0000-4000-8000-000000000001");
  assert.equal(transition(database, assignment, "PUBLISHING", "operator_transition", "2026-09-05T00:01:00.000Z").changes, 1);
  const publishing = database.prepare("SELECT * FROM chat_lane_assignments WHERE assignment_id=?").get(assignment.assignment_id);
  assert.equal(transition(database, publishing, "COMPLETED", "operator_transition", "2026-09-05T00:02:00.000Z").changes, 1);
  const lane = database.prepare("SELECT status,current_assignment_id,lease_token FROM chat_lanes WHERE lane_id='review-1'").get();
  assert.equal(lane.status, "IDLE");
  assert.equal(lane.current_assignment_id, null);
  assert.equal(lane.lease_token, null);
  assert.deepEqual(database.prepare("SELECT event_type FROM chat_lane_events WHERE assignment_id=? ORDER BY created_at,event_id").all(assignment.assignment_id).map((event) => event.event_type), ["LEASED", "PUBLISHING", "COMPLETED"]);
});

test("lost transition/recovery races roll back without a false event or premature reuse", () => {
  const database = db();
  const assignment = lease(database, "assignment-00000000-0000-4000-8000-000000000002");
  assert.equal(transition(database, assignment, "PUBLISHING", "operator_transition", "2099-09-05T00:00:30.000Z").changes, 1);
  const publishing = database.prepare("SELECT * FROM chat_lane_assignments WHERE assignment_id=?").get(assignment.assignment_id);
  database.prepare("UPDATE chat_lanes SET status='IDLE',lease_token=NULL,lease_expires_at=NULL,current_assignment_id=NULL,updated_at=? WHERE lane_id='review-1'").run("2026-09-05T00:01:00.000Z");
  assert.throws(() => transition(database, publishing, "COMPLETED", "operator_transition", "2099-09-05T00:02:00.000Z"), /chat_lane_transition_raced/);
  assert.equal(database.prepare("SELECT status FROM chat_lane_assignments WHERE assignment_id=?").get(assignment.assignment_id).status, "PUBLISHING");
  assert.equal(database.prepare("SELECT count(*) AS n FROM chat_lane_events WHERE assignment_id=?").get(assignment.assignment_id).n, 2);
  assert.equal(database.prepare("SELECT count(*) AS n FROM chat_lanes WHERE status='IDLE' AND current_assignment_id IS NULL").get().n, 1);
});

test("stale completion loses to publishing or expiry recovery without a second event", () => {
  const publishingDb = db();
  const leased = lease(publishingDb, "assignment-00000000-0000-4000-8000-000000000006");
  const stale = { ...leased };
  assert.equal(transition(publishingDb, leased, "PUBLISHING", "operator_transition", "2099-09-05T00:01:00.000Z").changes, 1);
  assert.equal(transition(publishingDb, stale, "COMPLETED", "operator_transition", "2099-09-05T00:02:00.000Z").changes, 0);
  assert.deepEqual(publishingDb.prepare("SELECT event_type FROM chat_lane_events WHERE assignment_id=? ORDER BY created_at,event_id").all(leased.assignment_id).map((event) => event.event_type), ["LEASED", "PUBLISHING"]);

  const recoveryDb = db();
  const expiring = lease(recoveryDb, "assignment-00000000-0000-4000-8000-000000000007", "2000-01-01T00:00:00.000Z");
  assert.equal(transition(recoveryDb, expiring, "BLOCKED", "lease_expired", "2099-09-05T00:02:00.000Z").changes, 1);
  assert.equal(transition(recoveryDb, { ...expiring, status: "PUBLISHING" }, "COMPLETED", "operator_transition", "2099-09-05T00:03:00.000Z").changes, 0);
  assert.deepEqual(recoveryDb.prepare("SELECT event_type FROM chat_lane_events WHERE assignment_id=? ORDER BY created_at,event_id").all(expiring.assignment_id).map((event) => event.event_type), ["LEASED", "LEASE_EXPIRED"]);
});

test("expiry revokes authority at the mutation boundary and recovery is the only blocking path", () => {
  const database = db();
  const assignment = lease(database, "assignment-00000000-0000-4000-8000-000000000003", "2026-09-05T00:01:00.000Z");
  assert.throws(() => transition(database, assignment, "PUBLISHING", "operator_transition", "2026-09-05T00:01:00.000Z"), /chat_lane_lease_expired/);
  assert.equal(database.prepare("SELECT status FROM chat_lane_assignments WHERE assignment_id=?").get(assignment.assignment_id).status, "RUNNING");
  assert.equal(transition(database, assignment, "BLOCKED", "lease_expired", "2026-09-05T00:01:00.000Z").changes, 1);
  assert.equal(database.prepare("SELECT status FROM chat_lanes WHERE lane_id='review-1'").get().status, "BLOCKED");
  assert.deepEqual(database.prepare("SELECT event_type FROM chat_lane_events WHERE assignment_id=? ORDER BY created_at,event_id").all(assignment.assignment_id).map((event) => event.event_type), ["LEASED", "LEASE_EXPIRED"]);
});

test("schema-5 retains the pre-0005 source transition batch for a source rollback", () => {
  const database = db();
  const assignment = lease(database, "assignment-00000000-0000-4000-8000-000000000004");
  const at = "2026-09-05T00:01:00.000Z";
  database.prepare("UPDATE chat_lanes SET status='PUBLISHING',updated_at=? WHERE lane_id=? AND current_assignment_id=? AND lease_token=? AND lease_fence=?")
    .run(at, assignment.lane_id, assignment.assignment_id, assignment.lease_token, assignment.lease_fence);
  database.prepare("UPDATE chat_lane_assignments SET status='PUBLISHING',updated_at=? WHERE assignment_id=? AND lease_token=? AND lease_fence=? AND status='RUNNING'")
    .run(at, assignment.assignment_id, assignment.lease_token, assignment.lease_fence);
  database.prepare("INSERT INTO chat_lane_events(event_id,assignment_id,event_type,payload_digest,created_at) VALUES(?,?,?,?,?)")
    .run(`transition:${assignment.assignment_id}:${assignment.lease_fence}:PUBLISHING`, assignment.assignment_id, "PUBLISHING", "old-source", at);
  assert.equal(database.prepare("SELECT status FROM chat_lane_assignments WHERE assignment_id=?").get(assignment.assignment_id).status, "PUBLISHING");
  assert.deepEqual(database.prepare("SELECT event_type FROM chat_lane_events WHERE assignment_id=? ORDER BY created_at,event_id").all(assignment.assignment_id).map((event) => event.event_type), ["LEASED", "PUBLISHING"]);
});

test("handler executes idempotent leasing, no-capacity rollback, exact evidence and auth refusal", async () => {
  const database = db();
  const d1 = new D1(database);
  assert.equal(isChatLaneAdmin(new Request("https://example.test/chat-lanes"), null), false);
  assert.equal(isChatLaneAdmin(new Request("https://example.test/chat-lanes", { headers: { Authorization: "Bearer wrong" } }), "right"), false);
  assert.equal(isChatLaneAdmin(new Request("https://example.test/chat-lanes", { headers: { Authorization: "Bearer right" } }), "right"), true);
  const assignment = { repository: "mhoo-os/dark-factory", pr_number: 29, linear_issue_id: "MHO-250", target_head_sha: "be74f4d21d6be28751d62734dcbb4716db382cc6", review_id: "MHOO-RL3-MHO-250-PR29-be74f4d21d6b-R1", verdict: "REQUEST CHANGES" };
  const makeLease = (key, body = assignment) => new Request("https://example.test/chat-lanes/lease", { method: "POST", body: JSON.stringify({ lane_type: "review", idempotency_key: key, assignment: body, lease_seconds: 1800 }) });
  const created = await handleChatLaneRequest(makeLease("handler-lease-1"), d1);
  assert.equal(created.status, 201);
  const leaseBody = await created.json();
  const publish = async (lease, targetD1) => await handleChatLaneRequest(new Request(`https://example.test/chat-lane-assignments/${lease.assignment_id}`, { method: "POST", body: JSON.stringify({ lease_token: lease.lease_token, status: "PUBLISHING" }) }), targetD1);
  assert.equal((await publish(leaseBody, d1)).status, 200);
  const replay = await handleChatLaneRequest(makeLease("handler-lease-1"), d1);
  assert.equal(replay.status, 200);
  assert.equal((await replay.json()).duplicate, true);
  const conflict = await handleChatLaneRequest(makeLease("handler-lease-1", { ...assignment, target_head_sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }), d1);
  assert.equal(conflict.status, 409);
  const unavailable = await handleChatLaneRequest(makeLease("handler-lease-2"), d1);
  assert.equal(unavailable.status, 409);
  assert.equal(database.prepare("SELECT count(*) AS n FROM chat_lane_assignments").get().n, 1);
  const completion = new Request(`https://example.test/chat-lane-assignments/${leaseBody.assignment_id}`, { method: "POST", body: JSON.stringify({ lease_token: leaseBody.lease_token, status: "COMPLETED", output_digest: "sha256:" + "0".repeat(64), completion_manifest: { ...assignment, verification: { method: "authenticated_operator_v1", attested_by: "operator-1", attested_at: "2026-09-05T00:00:00.000Z" } }, linear_output_url: "https://linear.app/mhoo/issue/MHO-250/trigger-bounded-chatgpt-work-autofix-from-trusted-pr-review-comments#comment-95d702de-076a-421c-aece-e83430cb0070" }) });
  const denied = await handleChatLaneRequest(completion, d1);
  assert.equal(denied.status, 422);
  assert.equal(database.prepare("SELECT status FROM chat_lane_assignments WHERE assignment_id=?").get(leaseBody.assignment_id).status, "PUBLISHING");

  for (const manifest of [
    { ...assignment, repository: "mhoo-os/wrong" },
    { ...assignment, pr_number: 30 },
    { ...assignment, linear_issue_id: "MHO-251" },
    { ...assignment, target_head_sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
    { ...assignment, review_id: "MHOO-RL3-MHO-250-PR29-aaaaaaaaaaaa-R1" },
    { ...assignment, verdict: "PASS" },
  ]) {
    const bad = await handleChatLaneRequest(new Request(`https://example.test/chat-lane-assignments/${leaseBody.assignment_id}`, { method: "POST", body: JSON.stringify({ lease_token: leaseBody.lease_token, status: "COMPLETED", output_digest: "sha256:" + "1".repeat(64), linear_output_url: "https://linear.app/mhoo/issue/MHO-250/trigger-bounded-chatgpt-work-autofix-from-trusted-pr-review-comments#comment-95d702de-076a-421c-aece-e83430cb0070", github_output_url: "https://github.com/mhoo-os/dark-factory/pull/29#issuecomment-5548673763", completion_manifest: { ...manifest, verification: { method: "authenticated_operator_v1", attested_by: "operator-1", attested_at: "2026-09-05T00:00:00.000Z" } } }) }), d1);
    assert.equal(bad.status, 422);
  }
  const incompleteAttestation = await handleChatLaneRequest(new Request(`https://example.test/chat-lane-assignments/${leaseBody.assignment_id}`, { method: "POST", body: JSON.stringify({ lease_token: leaseBody.lease_token, status: "COMPLETED", output_digest: "sha256:" + "2".repeat(64), linear_output_url: "https://linear.app/mhoo/issue/MHO-250/trigger-bounded-chatgpt-work-autofix-from-trusted-pr-review-comments#comment-95d702de-076a-421c-aece-e83430cb0070", github_output_url: "https://github.com/mhoo-os/dark-factory/pull/29#issuecomment-5548673763", completion_manifest: { ...assignment, verification: { method: "unverified", attested_by: "operator-1", attested_at: "2026-09-05T00:00:00.000Z" } } }) }), d1);
  assert.equal(incompleteAttestation.status, 422);
  for (const [linear_output_url, github_output_url] of [
    ["https://linear.app/mhoo/issue/MHO-250/trigger-bounded-chatgpt-work-autofix-from-trusted-pr-review-comments#comment-95d702de-076a-421c-aece-e83430cb0070", "https://github.com/"],
    ["https://linear.app/mhoo/issue/MHO-251/wrong#comment-95d702de-076a-421c-aece-e83430cb0070", "https://github.com/mhoo-os/dark-factory/pull/29#issuecomment-5548673763"],
    ["https://linear.app/mhoo/issue/MHO-250/trigger-bounded-chatgpt-work-autofix-from-trusted-pr-review-comments", "https://github.com/mhoo-os/dark-factory/pull/30#issuecomment-5548673763"],
  ]) {
    const badUrl = await handleChatLaneRequest(new Request(`https://example.test/chat-lane-assignments/${leaseBody.assignment_id}`, { method: "POST", body: JSON.stringify({ lease_token: leaseBody.lease_token, status: "COMPLETED", output_digest: "sha256:" + "5".repeat(64), linear_output_url, github_output_url, completion_manifest: { ...assignment, verification: { method: "authenticated_operator_v1", attested_by: "operator-1", attested_at: "2026-09-05T00:00:00.000Z" } } }) }), d1);
    assert.equal(badUrl.status, 422);
  }

  const validDb = db();
  const validD1 = new D1(validDb);
  const validLease = await handleChatLaneRequest(makeLease("handler-valid-review"), validD1);
  const validLeaseBody = await validLease.json();
  assert.equal((await publish(validLeaseBody, validD1)).status, 200);
  const validCompletion = await handleChatLaneRequest(new Request(`https://example.test/chat-lane-assignments/${validLeaseBody.assignment_id}`, { method: "POST", body: JSON.stringify({ lease_token: validLeaseBody.lease_token, status: "COMPLETED", output_digest: "sha256:" + "3".repeat(64), linear_output_url: "https://linear.app/mhoo/issue/MHO-250/trigger-bounded-chatgpt-work-autofix-from-trusted-pr-review-comments#comment-95d702de-076a-421c-aece-e83430cb0070", github_output_url: "https://github.com/mhoo-os/dark-factory/pull/29#issuecomment-5548673763", completion_manifest: { ...assignment, verification: { method: "authenticated_operator_v1", attested_by: "operator-1", attested_at: "2026-09-05T00:00:00.000Z" } } }) }), validD1);
  assert.equal(validCompletion.status, 200);
  assert.equal(validDb.prepare("SELECT status FROM chat_lanes WHERE lane_id='review-1'").get().status, "IDLE");

  const planningDb = db();
  planningDb.prepare("UPDATE chat_lanes SET chat_id=?,status='IDLE',updated_at=? WHERE lane_id='planning-1'").run("chat-planning-0001", "2026-09-05T00:00:00.000Z");
  const planningD1 = new D1(planningDb);
  await assert.rejects(
    handleChatLaneRequest(new Request("https://example.test/chat-lanes/lease", { method: "POST", body: JSON.stringify({ lane_type: "planning", idempotency_key: "empty-planning", assignment: {} }) }), planningD1),
    /planning_identity_incomplete/,
  );
  const planningLease = await handleChatLaneRequest(new Request("https://example.test/chat-lanes/lease", { method: "POST", body: JSON.stringify({ lane_type: "planning", idempotency_key: "valid-planning", assignment: { objective: "MHO-250-bounded-objective" } }) }), planningD1);
  const planningLeaseBody = await planningLease.json();
  assert.equal((await publish(planningLeaseBody, planningD1)).status, 200);
  const planningCompletion = await handleChatLaneRequest(new Request(`https://example.test/chat-lane-assignments/${planningLeaseBody.assignment_id}`, { method: "POST", body: JSON.stringify({ lease_token: planningLeaseBody.lease_token, status: "COMPLETED", output_digest: "sha256:" + "4".repeat(64), github_output_url: "https://github.com/mhoo-os/dark-factory/pull/29#issuecomment-5548673763", completion_manifest: { objective: "MHO-250-bounded-objective", verification: { method: "authenticated_operator_v1", attested_by: "operator-1", attested_at: "2026-09-05T00:00:00.000Z" } } }) }), planningD1);
  assert.equal(planningCompletion.status, 200);
  assert.equal(planningDb.prepare("SELECT status FROM chat_lanes WHERE lane_id='planning-1'").get().status, "IDLE");
});

test("handler reads a live lease then rejects mutation after expiry", async () => {
  const database = db();
  const d1 = new D1(database);
  const assignment = lease(database, "assignment-00000000-0000-4000-8000-000000000005", "2000-01-01T00:00:00.000Z");
  const response = await handleChatLaneRequest(new Request(`https://example.test/chat-lane-assignments/${assignment.assignment_id}`, { method: "POST", body: JSON.stringify({ lease_token: assignment.lease_token, status: "PUBLISHING" }) }), d1);
  assert.equal(response.status, 409);
  assert.equal(database.prepare("SELECT status FROM chat_lane_assignments WHERE assignment_id=?").get(assignment.assignment_id).status, "RUNNING");
  assert.equal(database.prepare("SELECT count(*) AS n FROM chat_lane_events WHERE assignment_id=?").get(assignment.assignment_id).n, 1);
});

test("D1 trigger-inclusive change accounting acknowledges winners and recovery", async () => {
  const database = db();
  const d1 = new D1(database, true);
  const assignment = { repository: "mhoo-os/dark-factory", pr_number: 29, linear_issue_id: "MHO-250", target_head_sha: "be74f4d21d6be28751d62734dcbb4716db382cc6", review_id: "MHOO-RL3-MHO-250-PR29-be74f4d21d6b-R1", verdict: "REQUEST CHANGES" };
  const leased = await handleChatLaneRequest(new Request("https://example.test/chat-lanes/lease", { method: "POST", body: JSON.stringify({ lane_type: "review", idempotency_key: "d1-counts", assignment }) }), d1);
  const leaseBody = await leased.json();
  assert.equal((await handleChatLaneRequest(new Request(`https://example.test/chat-lane-assignments/${leaseBody.assignment_id}`, { method: "POST", body: JSON.stringify({ lease_token: leaseBody.lease_token, status: "PUBLISHING" }) }), d1)).status, 200);
  assert.equal((await handleChatLaneRequest(new Request(`https://example.test/chat-lane-assignments/${leaseBody.assignment_id}`, { method: "POST", body: JSON.stringify({ lease_token: leaseBody.lease_token, status: "COMPLETED", output_digest: "sha256:" + "a".repeat(64), linear_output_url: "https://linear.app/mhoo/issue/MHO-250/trigger-bounded-chatgpt-work-autofix-from-trusted-pr-review-comments#comment-95d702de-076a-421c-aece-e83430cb0070", github_output_url: "https://github.com/mhoo-os/dark-factory/pull/29#issuecomment-5548673763", completion_manifest: { ...assignment, verification: { method: "authenticated_operator_v1", attested_by: "operator-1", attested_at: "2026-09-05T00:00:00.000Z" } } }) }), d1)).status, 200);
  const expired = lease(database, "assignment-00000000-0000-4000-8000-000000000009", "2000-01-01T00:00:00.000Z");
  assert.equal(await recoverExpiredChatLanes(d1, new Date("2026-09-05T00:00:00.000Z")), 1);
  assert.equal(database.prepare("SELECT status FROM chat_lane_assignments WHERE assignment_id=?").get(expired.assignment_id).status, "BLOCKED");
});

test("readiness refuses absent and schema-4 registry routes without writes", async () => {
  const absent = new DatabaseSync(":memory:");
  absent.exec("CREATE TABLE factory_schema_meta(schema_name TEXT PRIMARY KEY, schema_version INTEGER NOT NULL)");
  assert.equal((await handleChatLaneRequest(new Request("https://example.test/chat-lanes/lease", { method: "POST", body: "{}" }), new D1(absent))).status, 503);
  const schema4 = new DatabaseSync(":memory:");
  schema4.exec("CREATE TABLE factory_schema_meta(schema_name TEXT PRIMARY KEY, schema_version INTEGER NOT NULL)");
  schema4.exec(migration4);
  assert.equal((await handleChatLaneRequest(new Request("https://example.test/chat-lanes/lease", { method: "POST", body: "{}" }), new D1(schema4))).status, 503);
  assert.equal(schema4.prepare("SELECT count(*) AS n FROM chat_lane_assignments").get().n, 0);
});

test("six concurrent handler leases atomically claim five slots with no leaked sixth receipt", async () => {
  const database = db();
  for (let slot = 2; slot <= 5; slot += 1) database.prepare("UPDATE chat_lanes SET chat_id=?,status='IDLE',updated_at=? WHERE lane_id=?").run(`chat-review-${slot}`, "2026-09-05T00:00:00.000Z", `review-${slot}`);
  const d1 = new D1(database);
  const assignment = { repository: "mhoo-os/dark-factory", pr_number: 29, linear_issue_id: "MHO-250", target_head_sha: "be74f4d21d6be28751d62734dcbb4716db382cc6", review_id: "MHOO-RL3-MHO-250-PR29-be74f4d21d6b-R1", verdict: "REQUEST CHANGES" };
  const responses = await Promise.all(Array.from({ length: 6 }, (_, index) => handleChatLaneRequest(new Request("https://example.test/chat-lanes/lease", { method: "POST", body: JSON.stringify({ lane_type: "review", idempotency_key: `concurrent-${index}`, assignment }) }), d1)));
  assert.equal(responses.filter((response) => response.status === 201).length, 5);
  assert.equal(responses.filter((response) => response.status === 409).length, 1);
  assert.equal(database.prepare("SELECT count(*) AS n FROM chat_lane_assignments").get().n, 5);
  assert.equal(database.prepare("SELECT count(*) AS n FROM chat_lane_events WHERE event_type='LEASED'").get().n, 5);
  assert.equal(database.prepare("SELECT count(DISTINCT lane_id) AS n FROM chat_lane_assignments").get().n, 5);
});

test("a statement error in the transition trigger rolls back assignment and lane state", () => {
  const database = db();
  const assignment = lease(database, "assignment-00000000-0000-4000-8000-000000000008");
  database.prepare("INSERT INTO chat_lane_events(event_id,assignment_id,event_type,payload_digest,created_at) VALUES(?,?,?,?,?)")
    .run(`transition:${assignment.assignment_id}:${assignment.lease_fence}:PUBLISHING`, assignment.assignment_id, "PUBLISHING", "preexisting", "2026-09-05T00:00:01.000Z");
  assert.throws(() => transition(database, assignment, "PUBLISHING", "operator_transition", "2099-09-05T00:01:00.000Z"), /UNIQUE constraint failed/);
  assert.equal(database.prepare("SELECT status FROM chat_lane_assignments WHERE assignment_id=?").get(assignment.assignment_id).status, "RUNNING");
  assert.equal(database.prepare("SELECT status FROM chat_lanes WHERE lane_id='review-1'").get().status, "RUNNING");
  assert.equal(database.prepare("SELECT count(*) AS n FROM chat_lane_events WHERE assignment_id=?").get(assignment.assignment_id).n, 2);
});

test("scheduler isolates an unready registry without suppressing existing recovery", () => {
  assert.match(index, /try \{\s*await recoverExpiredChatLanes\(env\.DB\);\s*\} catch/s);
  assert.match(index, /chat_lane_registry_recovery_failed/);
  assert.match(index, /await recoverStaleLeases\(env\);/);
});
