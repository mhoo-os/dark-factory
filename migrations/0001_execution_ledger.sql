CREATE TABLE IF NOT EXISTS webhook_events (
  event_id TEXT PRIMARY KEY,
  source TEXT NOT NULL CHECK (source IN ('linear', 'github')),
  body_sha256 TEXT NOT NULL,
  decision TEXT NOT NULL,
  reason TEXT,
  received_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS executions (
  execution_id TEXT PRIMARY KEY,
  linear_issue_id TEXT NOT NULL UNIQUE,
  linear_identifier TEXT NOT NULL,
  linear_url TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  repository TEXT NOT NULL,
  priority INTEGER NOT NULL CHECK (priority BETWEEN 1 AND 4),
  state TEXT NOT NULL CHECK (state IN ('admitted','queued','dispatched','running','succeeded','failed','cancelled','needs-human')),
  workflow_id TEXT,
  github_pr_number INTEGER,
  lease_expires_at TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  result_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS repo_leases (
  repository TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL,
  lease_expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS control_flags (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS executions_ready_idx
  ON executions (state, priority, created_at);
