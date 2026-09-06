-- Metadata only. Execute only against the separately approved recovery target.
SELECT schema_name, schema_version FROM factory_schema_meta ORDER BY schema_name;
SELECT name FROM d1_migrations ORDER BY id;
SELECT name FROM sqlite_master WHERE type='trigger' ORDER BY name;
SELECT status, COUNT(*) AS lane_count FROM chat_lanes GROUP BY status;
SELECT COUNT(*) AS assignments FROM chat_lane_assignments;
SELECT COUNT(*) AS events FROM chat_lane_events;
SELECT COUNT(*) AS runs FROM factory_runs;
SELECT COUNT(*) AS leases FROM factory_leases;
SELECT COUNT(*) AS unexpected_lane_state FROM chat_lanes
WHERE status <> 'REPLACE' OR chat_id IS NOT NULL OR lease_token IS NOT NULL
   OR lease_expires_at IS NOT NULL OR current_assignment_id IS NOT NULL;
