-- Reuse canonical steps; native attempt receipts are observations, never upserts.
-- Also block REPLACE: SQLite can otherwise bypass DELETE triggers during REPLACE.
CREATE TRIGGER native_candidate_steps_no_replace
BEFORE INSERT ON factory_steps
WHEN NEW.step_key GLOB 'native-candidate:v1:*' AND EXISTS(
  SELECT 1 FROM factory_steps WHERE run_id=NEW.run_id AND step_key=NEW.step_key
)
BEGIN
  SELECT RAISE(ABORT, 'native_candidate_receipt_immutable');
END;

CREATE TRIGGER native_candidate_steps_no_update
BEFORE UPDATE ON factory_steps
WHEN OLD.step_key GLOB 'native-candidate:v1:*' OR NEW.step_key GLOB 'native-candidate:v1:*'
BEGIN
  SELECT RAISE(ABORT, 'native_candidate_receipt_immutable');
END;

CREATE TRIGGER native_candidate_steps_no_delete
BEFORE DELETE ON factory_steps
WHEN OLD.step_key GLOB 'native-candidate:v1:*'
BEGIN
  SELECT RAISE(ABORT, 'native_candidate_receipt_immutable');
END;

INSERT OR REPLACE INTO factory_schema_meta(schema_name,schema_version)
VALUES ('native-candidate-receipts',1);
