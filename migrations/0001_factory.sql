CREATE TABLE IF NOT EXISTS factory_schema_meta (
  schema_name TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL
);
INSERT OR REPLACE INTO factory_schema_meta(schema_name, schema_version)
VALUES ('factory-ledger', 1);

CREATE TABLE IF NOT EXISTS control_flags (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
INSERT OR IGNORE INTO control_flags(key, value, updated_at)
VALUES ('stop', 'false', '1970-01-01T00:00:00.000Z');

CREATE TABLE IF NOT EXISTS factory_ingress_events (
  event_id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload_digest TEXT NOT NULL,
  handoff_state TEXT NOT NULL,
  received_at TEXT NOT NULL,
  enqueued_at TEXT
);

CREATE TABLE IF NOT EXISTS factory_runs (
  dispatch_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL UNIQUE,
  contract_digest TEXT NOT NULL,
  contract_json TEXT NOT NULL,
  linear_project_id TEXT NOT NULL,
  linear_issue_id TEXT NOT NULL,
  linear_identifier TEXT NOT NULL,
  repository TEXT NOT NULL,
  collision_group TEXT NOT NULL,
  base_sha TEXT NOT NULL,
  current_state TEXT NOT NULL,
  workflow_id TEXT,
  lease_fence INTEGER,
  lease_expires_at TEXT,
  head_sha TEXT,
  pr_number INTEGER,
  pr_url TEXT,
  result_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS factory_runs_ready_idx
  ON factory_runs(current_state, created_at);

CREATE TABLE IF NOT EXISTS factory_leases (
  lease_key TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  dispatch_id TEXT NOT NULL,
  fence INTEGER NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS factory_steps (
  run_id TEXT NOT NULL,
  step_key TEXT NOT NULL,
  status TEXT NOT NULL,
  result_json TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (run_id, step_key)
);
