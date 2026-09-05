import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const migration = await readFile(new URL("../migrations/0004_chat_lane_registry.sql", import.meta.url), "utf8");
const source = await readFile(new URL("../src/chat-lane-registry.ts", import.meta.url), "utf8");
const index = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");

test("migration provisions exactly five review and five planning lanes fail-closed", () => {
  assert.equal((migration.match(/\('review-[1-5]','review',[1-5],'REPLACE'/g) ?? []).length, 5);
  assert.equal((migration.match(/\('planning-[1-5]','planning',[1-5],'REPLACE'/g) ?? []).length, 5);
  assert.match(migration, /chat_id IS NULL/);
  assert.match(migration, /status IN \('IDLE', 'RUNNING', 'PUBLISHING', 'BLOCKED', 'REPLACE'\)/);
});

test("allocation is performed by one SQLite trigger with no pre-read race", () => {
  assert.match(migration, /CREATE TRIGGER IF NOT EXISTS chat_lane_allocate_after_insert/);
  assert.match(migration, /WHERE lane_type = NEW\.lane_type AND status = 'IDLE' AND chat_id IS NOT NULL/);
  assert.match(migration, /RAISE\(ABORT, 'chat_lane_unavailable'\)/);
  assert.match(migration, /VALUES\('lease:' \|\| NEW\.assignment_id,NEW\.assignment_id,'LEASED',NEW\.request_digest,NEW\.created_at\)/);
  assert.doesNotMatch(source, /SELECT .*status = 'IDLE'.*INSERT/s);
});

test("registry binds idempotency, exact review identity, leases, and completion evidence", () => {
  for (const marker of [
    "idempotency_key TEXT NOT NULL UNIQUE",
    "request_digest TEXT NOT NULL",
    "target_head_sha TEXT",
    "lease_token TEXT NOT NULL UNIQUE",
    "linear_output_url TEXT",
    "github_output_url TEXT",
    "verified_at TEXT",
  ]) assert.match(migration, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(source, /review_identity_incomplete/);
  assert.match(source, /idempotency_conflict/);
  assert.match(source, /completion_evidence_required/);
  assert.match(source, /lease_fenced/);
});

test("expired active lanes block safely and the scheduler performs recovery", () => {
  assert.match(source, /status='BLOCKED'/);
  assert.match(source, /LEASE_EXPIRED/);
  assert.match(source, /lease_expires_at<=\?/);
  assert.match(index, /await recoverExpiredChatLanes\(env\.DB\)/);
});

test("all registry endpoints reuse the existing admin boundary", () => {
  assert.match(index, /url\.pathname\.startsWith\("\/chat-lane"\)/);
  assert.match(index, /FACTORY_ADMIN_SECRET/);
  assert.match(index, /handleChatLaneRequest\(request, env\.DB\)/);
});
