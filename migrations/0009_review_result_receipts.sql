-- Reuse the lane assignment as the durable request/result record.
ALTER TABLE chat_lane_assignments ADD COLUMN completion_manifest_json TEXT;
CREATE TRIGGER review_result_no_rewrite
BEFORE UPDATE OF completion_manifest_json ON chat_lane_assignments
WHEN OLD.completion_manifest_json IS NOT NULL AND NEW.completion_manifest_json IS NOT OLD.completion_manifest_json
BEGIN
  SELECT RAISE(ABORT, 'review_result_immutable');
END;
CREATE TRIGGER review_request_no_rewrite
BEFORE UPDATE OF assignment_json,request_digest ON chat_lane_assignments
WHEN json_extract(OLD.assignment_json,'$.review_request_version')='mho253-v1'
 AND (NEW.assignment_json<>OLD.assignment_json OR NEW.request_digest<>OLD.request_digest)
BEGIN
  SELECT RAISE(ABORT, 'review_request_immutable');
END;
INSERT OR REPLACE INTO factory_schema_meta(schema_name,schema_version)
VALUES ('chat-review-receipts',1);
CREATE TRIGGER review_result_no_delete
BEFORE DELETE ON chat_lane_assignments
WHEN OLD.completion_manifest_json IS NOT NULL OR json_extract(OLD.assignment_json,'$.review_request_version')='mho253-v1'
BEGIN
  SELECT RAISE(ABORT, 'review_receipt_immutable');
END;
CREATE TRIGGER review_result_no_replace
BEFORE INSERT ON chat_lane_assignments
WHEN EXISTS (SELECT 1 FROM chat_lane_assignments old WHERE (old.assignment_id=NEW.assignment_id OR old.idempotency_key=NEW.idempotency_key OR old.lease_token=NEW.lease_token)
 AND (old.completion_manifest_json IS NOT NULL OR json_extract(old.assignment_json,'$.review_request_version')='mho253-v1'))
BEGIN
  SELECT RAISE(ABORT, 'review_receipt_immutable');
END;
