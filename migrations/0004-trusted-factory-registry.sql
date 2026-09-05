-- Bind every execution-significant durable receipt to the human-owned registry
-- revision that admitted it. Existing evidence remains readable; only new
-- registry-aware admissions populate these fields.
ALTER TABLE factory_runs ADD COLUMN factory_id TEXT;
ALTER TABLE factory_runs ADD COLUMN registry_version TEXT;
ALTER TABLE factory_runs ADD COLUMN registry_digest TEXT;
ALTER TABLE factory_runs ADD COLUMN registry_entry_version TEXT;
CREATE INDEX IF NOT EXISTS factory_runs_registry_idx
  ON factory_runs(factory_id, registry_version, registry_digest);

ALTER TABLE factory_ingress_events ADD COLUMN factory_id TEXT;
ALTER TABLE factory_ingress_events ADD COLUMN registry_version TEXT;
ALTER TABLE factory_ingress_events ADD COLUMN registry_digest TEXT;
ALTER TABLE factory_ingress_events ADD COLUMN registry_entry_version TEXT;

ALTER TABLE factory_leases ADD COLUMN factory_id TEXT;
ALTER TABLE factory_leases ADD COLUMN registry_version TEXT;
ALTER TABLE factory_leases ADD COLUMN registry_digest TEXT;
ALTER TABLE factory_leases ADD COLUMN registry_entry_version TEXT;

ALTER TABLE factory_events ADD COLUMN factory_id TEXT;
ALTER TABLE factory_events ADD COLUMN registry_version TEXT;
ALTER TABLE factory_events ADD COLUMN registry_digest TEXT;
ALTER TABLE factory_events ADD COLUMN registry_entry_version TEXT;

ALTER TABLE factory_transitions ADD COLUMN factory_id TEXT;
ALTER TABLE factory_transitions ADD COLUMN registry_version TEXT;
ALTER TABLE factory_transitions ADD COLUMN registry_digest TEXT;
ALTER TABLE factory_transitions ADD COLUMN registry_entry_version TEXT;

ALTER TABLE factory_evidence ADD COLUMN factory_id TEXT;
ALTER TABLE factory_evidence ADD COLUMN registry_version TEXT;
ALTER TABLE factory_evidence ADD COLUMN registry_digest TEXT;
ALTER TABLE factory_evidence ADD COLUMN registry_entry_version TEXT;

ALTER TABLE factory_steps ADD COLUMN factory_id TEXT;
ALTER TABLE factory_steps ADD COLUMN registry_version TEXT;
ALTER TABLE factory_steps ADD COLUMN registry_digest TEXT;
ALTER TABLE factory_steps ADD COLUMN registry_entry_version TEXT;

CREATE TABLE IF NOT EXISTS factory_pr_receipts (
  receipt_id TEXT PRIMARY KEY,
  dispatch_id TEXT NOT NULL REFERENCES factory_runs(dispatch_id),
  run_id TEXT NOT NULL,
  pr_number INTEGER NOT NULL,
  pr_url TEXT NOT NULL,
  head_sha TEXT NOT NULL,
  factory_id TEXT NOT NULL,
  registry_version TEXT NOT NULL,
  registry_digest TEXT NOT NULL,
  registry_entry_version TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS factory_linear_reconciliations (
  reconciliation_id TEXT PRIMARY KEY,
  dispatch_id TEXT NOT NULL REFERENCES factory_runs(dispatch_id),
  run_id TEXT NOT NULL,
  state TEXT NOT NULL,
  reason TEXT NOT NULL,
  factory_id TEXT NOT NULL,
  registry_version TEXT NOT NULL,
  registry_digest TEXT NOT NULL,
  registry_entry_version TEXT NOT NULL,
  created_at TEXT NOT NULL
);

INSERT OR REPLACE INTO factory_schema_meta(schema_name, schema_version)
VALUES ('factory-ledger', 4);
