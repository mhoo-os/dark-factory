-- Preserve enough handoff state to retry a durable-but-not-yet-enqueued
-- webhook without treating a replay as a new event.
ALTER TABLE factory_ingress_events ADD COLUMN updated_at TEXT;
ALTER TABLE factory_ingress_events ADD COLUMN normalized_json TEXT;
UPDATE factory_ingress_events SET updated_at = received_at WHERE updated_at IS NULL;

-- These nullable additions keep the first deployed MVP schema upgradeable while
-- making the durable row carry the identity fields used by the v1 ledger.
ALTER TABLE factory_runs ADD COLUMN contract_version TEXT;
ALTER TABLE factory_runs ADD COLUMN profile_digest TEXT;
ALTER TABLE factory_runs ADD COLUMN planning_revision TEXT;
ALTER TABLE factory_runs ADD COLUMN planning_fingerprint TEXT;
ALTER TABLE factory_runs ADD COLUMN execution_profile TEXT;
ALTER TABLE factory_runs ADD COLUMN validation_profile TEXT;
ALTER TABLE factory_runs ADD COLUMN attempt INTEGER;
ALTER TABLE factory_runs ADD COLUMN lease_owner TEXT;
ALTER TABLE factory_runs ADD COLUMN branch TEXT;
ALTER TABLE factory_runs ADD COLUMN model_digest TEXT;
ALTER TABLE factory_runs ADD COLUMN rules_digest TEXT;
ALTER TABLE factory_runs ADD COLUMN cost_usd REAL;
ALTER TABLE factory_runs ADD COLUMN token_count INTEGER;
ALTER TABLE factory_runs ADD COLUMN latency_ms INTEGER;
ALTER TABLE factory_runs ADD COLUMN escalation_reason TEXT;
ALTER TABLE factory_runs ADD COLUMN reconciled_at TEXT;

CREATE TABLE IF NOT EXISTS factory_events (
  event_id TEXT PRIMARY KEY,
  dispatch_id TEXT NOT NULL,
  event_sequence INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  payload_digest TEXT,
  accepted INTEGER NOT NULL,
  reason TEXT NOT NULL,
  received_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS factory_evidence (
  evidence_id TEXT PRIMARY KEY,
  dispatch_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  kind TEXT NOT NULL,
  digest TEXT NOT NULL,
  artifact_ref TEXT NOT NULL,
  redacted INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

INSERT OR REPLACE INTO factory_schema_meta(schema_name, schema_version)
VALUES ('factory-ledger', 2);
