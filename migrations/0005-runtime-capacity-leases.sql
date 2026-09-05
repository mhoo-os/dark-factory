-- One execution must reserve every independently-governed capacity domain.
-- The reservation id is the run fencing token; the individual lease rows are
-- slot claims for global, factory, repository, and collision-group limits.
CREATE TABLE IF NOT EXISTS factory_lease_reservations (
  reservation_id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES factory_runs(run_id),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS factory_lease_members (
  reservation_id INTEGER NOT NULL REFERENCES factory_lease_reservations(reservation_id),
  lease_key TEXT NOT NULL,
  PRIMARY KEY (reservation_id, lease_key)
);
CREATE INDEX IF NOT EXISTS factory_lease_members_key_idx
  ON factory_lease_members(lease_key);

INSERT OR REPLACE INTO factory_schema_meta(schema_name, schema_version)
VALUES ('factory-ledger', 5);
