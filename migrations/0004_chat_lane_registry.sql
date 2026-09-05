-- MHO-250 Phase 0: durable, fail-closed chat lane registry.
-- Chat IDs are deliberately not committed. Operators bind them through the
-- admin-only endpoint; unbound lanes remain REPLACE and cannot be leased.
CREATE TABLE IF NOT EXISTS chat_lanes (
  lane_id TEXT PRIMARY KEY,
  lane_type TEXT NOT NULL CHECK (lane_type IN ('review', 'planning')),
  slot INTEGER NOT NULL CHECK (slot BETWEEN 1 AND 5),
  chat_id TEXT UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('IDLE', 'RUNNING', 'PUBLISHING', 'BLOCKED', 'REPLACE')),
  lease_token TEXT,
  lease_fence INTEGER NOT NULL DEFAULT 0,
  lease_expires_at TEXT,
  current_assignment_id TEXT UNIQUE,
  updated_at TEXT NOT NULL,
  UNIQUE (lane_type, slot),
  CHECK (
    (status = 'REPLACE' AND chat_id IS NULL AND lease_token IS NULL AND lease_expires_at IS NULL AND current_assignment_id IS NULL)
    OR
    (status = 'IDLE' AND chat_id IS NOT NULL AND lease_token IS NULL AND lease_expires_at IS NULL AND current_assignment_id IS NULL)
    OR
    (status IN ('RUNNING', 'PUBLISHING') AND chat_id IS NOT NULL AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL AND current_assignment_id IS NOT NULL)
    OR
    (status = 'BLOCKED' AND chat_id IS NOT NULL AND lease_token IS NULL AND lease_expires_at IS NULL AND current_assignment_id IS NULL)
  )
);

CREATE TABLE IF NOT EXISTS chat_lane_assignments (
  assignment_id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  request_digest TEXT NOT NULL,
  lane_type TEXT NOT NULL CHECK (lane_type IN ('review', 'planning')),
  lane_id TEXT REFERENCES chat_lanes(lane_id),
  lease_token TEXT NOT NULL UNIQUE,
  lease_fence INTEGER,
  lease_expires_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('RUNNING', 'PUBLISHING', 'COMPLETED', 'BLOCKED')),
  repository TEXT,
  pr_number INTEGER,
  linear_issue_id TEXT,
  target_head_sha TEXT,
  assignment_json TEXT NOT NULL,
  linear_output_url TEXT,
  github_output_url TEXT,
  output_digest TEXT,
  verified_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS chat_lane_events (
  event_id TEXT PRIMARY KEY,
  assignment_id TEXT NOT NULL REFERENCES chat_lane_assignments(assignment_id),
  event_type TEXT NOT NULL,
  payload_digest TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS chat_lanes_available_idx
  ON chat_lanes(lane_type, status, slot);
CREATE INDEX IF NOT EXISTS chat_lanes_expiry_idx
  ON chat_lanes(status, lease_expires_at);
CREATE INDEX IF NOT EXISTS chat_lane_assignments_status_idx
  ON chat_lane_assignments(status, updated_at);

-- Allocation is one SQLite transaction: inserting an assignment atomically
-- claims the lowest-numbered compatible IDLE lane or aborts the insert.
CREATE TRIGGER IF NOT EXISTS chat_lane_allocate_after_insert
AFTER INSERT ON chat_lane_assignments
WHEN NEW.lane_id IS NULL
BEGIN
  UPDATE chat_lanes
  SET status = 'RUNNING',
      lease_token = NEW.lease_token,
      lease_fence = lease_fence + 1,
      lease_expires_at = NEW.lease_expires_at,
      current_assignment_id = NEW.assignment_id,
      updated_at = NEW.updated_at
  WHERE lane_id = (
    SELECT lane_id FROM chat_lanes
    WHERE lane_type = NEW.lane_type AND status = 'IDLE' AND chat_id IS NOT NULL
    ORDER BY slot LIMIT 1
  );

  UPDATE chat_lane_assignments
  SET lane_id = (SELECT lane_id FROM chat_lanes WHERE current_assignment_id = NEW.assignment_id),
      lease_fence = (SELECT lease_fence FROM chat_lanes WHERE current_assignment_id = NEW.assignment_id)
  WHERE assignment_id = NEW.assignment_id;

  -- Parentheses keep Cloudflare D1's remote trigger splitter from mistaking
  -- this CASE END for the trigger's END. SQLite semantics are unchanged.
  SELECT (CASE
    WHEN (SELECT lane_id FROM chat_lane_assignments WHERE assignment_id = NEW.assignment_id) IS NULL
    THEN RAISE(ABORT, 'chat_lane_unavailable')
  END);

  INSERT INTO chat_lane_events(event_id,assignment_id,event_type,payload_digest,created_at)
  VALUES('lease:' || NEW.assignment_id,NEW.assignment_id,'LEASED',NEW.request_digest,NEW.created_at);
END;

INSERT OR IGNORE INTO chat_lanes(lane_id,lane_type,slot,status,updated_at) VALUES
  ('review-1','review',1,'REPLACE','1970-01-01T00:00:00.000Z'),
  ('review-2','review',2,'REPLACE','1970-01-01T00:00:00.000Z'),
  ('review-3','review',3,'REPLACE','1970-01-01T00:00:00.000Z'),
  ('review-4','review',4,'REPLACE','1970-01-01T00:00:00.000Z'),
  ('review-5','review',5,'REPLACE','1970-01-01T00:00:00.000Z'),
  ('planning-1','planning',1,'REPLACE','1970-01-01T00:00:00.000Z'),
  ('planning-2','planning',2,'REPLACE','1970-01-01T00:00:00.000Z'),
  ('planning-3','planning',3,'REPLACE','1970-01-01T00:00:00.000Z'),
  ('planning-4','planning',4,'REPLACE','1970-01-01T00:00:00.000Z'),
  ('planning-5','planning',5,'REPLACE','1970-01-01T00:00:00.000Z');

INSERT OR REPLACE INTO factory_schema_meta(schema_name, schema_version)
VALUES ('factory-ledger', 4);
