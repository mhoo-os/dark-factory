PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS factory_schema_meta (
  schema_name TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL
);
INSERT OR IGNORE INTO factory_schema_meta(schema_name, schema_version)
VALUES ('factory-ledger', 1);

CREATE TABLE IF NOT EXISTS factory_runs (
  dispatch_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL UNIQUE,
  contract_version TEXT NOT NULL,
  contract_digest TEXT NOT NULL,
  linear_project_id TEXT NOT NULL,
  linear_issue_id TEXT NOT NULL,
  linear_identifier TEXT NOT NULL,
  planning_revision TEXT NOT NULL,
  planning_fingerprint TEXT NOT NULL,
  repository TEXT NOT NULL,
  execution_profile TEXT NOT NULL,
  validation_profile TEXT NOT NULL,
  collision_group TEXT NOT NULL,
  current_state TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 0,
  lease_owner TEXT,
  lease_fence INTEGER,
  lease_expires_at TEXT,
  base_sha TEXT NOT NULL,
  head_sha TEXT,
  pr_number INTEGER,
  pr_url TEXT,
  model_digest TEXT,
  rules_digest TEXT,
  cost_usd REAL,
  token_count INTEGER,
  latency_ms INTEGER,
  escalation_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  reconciled_at TEXT
);

CREATE INDEX IF NOT EXISTS factory_runs_issue_idx ON factory_runs(linear_issue_id);

CREATE TABLE IF NOT EXISTS factory_events (
  event_id TEXT PRIMARY KEY,
  dispatch_id TEXT NOT NULL REFERENCES factory_runs(dispatch_id),
  event_sequence INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  payload_digest TEXT,
  accepted INTEGER NOT NULL,
  reason TEXT NOT NULL,
  received_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS factory_transitions (
  dispatch_id TEXT NOT NULL REFERENCES factory_runs(dispatch_id),
  event_sequence INTEGER NOT NULL,
  event_id TEXT NOT NULL UNIQUE REFERENCES factory_events(event_id),
  from_state TEXT NOT NULL,
  to_state TEXT NOT NULL,
  actor TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (dispatch_id, event_sequence)
);

CREATE TABLE IF NOT EXISTS factory_evidence (
  evidence_id TEXT PRIMARY KEY,
  dispatch_id TEXT NOT NULL REFERENCES factory_runs(dispatch_id),
  run_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  kind TEXT NOT NULL,
  digest TEXT NOT NULL,
  artifact_ref TEXT NOT NULL,
  redacted INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
