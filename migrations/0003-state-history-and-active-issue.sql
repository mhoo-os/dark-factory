-- Enforce the state/authority contract at the D1 boundary and make the
-- one-active-run-per-Linear-issue rule atomic rather than a pre-read only.
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

CREATE UNIQUE INDEX IF NOT EXISTS factory_runs_active_issue_unique_idx
  ON factory_runs(linear_issue_id)
  WHERE current_state NOT IN ('not-admitted', 'failed', 'pr-merged', 'pr-canceled');

INSERT OR REPLACE INTO factory_schema_meta(schema_name, schema_version)
VALUES ('factory-ledger', 3);
