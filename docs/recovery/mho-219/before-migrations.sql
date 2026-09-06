-- Metadata only. Execute only against the separately approved recovery target.
SELECT schema_name, schema_version FROM factory_schema_meta ORDER BY schema_name;
SELECT name FROM d1_migrations ORDER BY id;
SELECT type, name, tbl_name FROM sqlite_master
WHERE type IN ('table', 'index', 'trigger') ORDER BY type, name;
SELECT COUNT(*) AS runs FROM factory_runs;
SELECT COUNT(*) AS leases FROM factory_leases;
