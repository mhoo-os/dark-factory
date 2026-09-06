-- Same run and canonical steps: immutable budget, claims and results.
CREATE TRIGGER repair_steps_no_replace BEFORE INSERT ON factory_steps
WHEN NEW.step_key GLOB 'review-repair:v1:*' AND EXISTS(SELECT 1 FROM factory_steps WHERE run_id=NEW.run_id AND step_key=NEW.step_key)
BEGIN SELECT RAISE(ABORT, 'repair_receipt_immutable'); END;
CREATE TRIGGER repair_steps_no_update BEFORE UPDATE ON factory_steps
WHEN OLD.step_key GLOB 'review-repair:v1:*' OR NEW.step_key GLOB 'review-repair:v1:*'
BEGIN SELECT RAISE(ABORT, 'repair_receipt_immutable'); END;
CREATE TRIGGER repair_steps_no_delete BEFORE DELETE ON factory_steps
WHEN OLD.step_key GLOB 'review-repair:v1:*'
BEGIN SELECT RAISE(ABORT, 'repair_receipt_immutable'); END;
INSERT OR REPLACE INTO factory_schema_meta(schema_name,schema_version) VALUES ('review-repair-receipts',1);
