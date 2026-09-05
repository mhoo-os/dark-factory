-- MHO-250 B4: schema-6 is the activation marker for registry mutation.
-- Old source never writes the v2 marker, so a source rollback remains able to
-- inspect and conservatively block existing assignments without corrupting audit history.
DROP TRIGGER IF EXISTS chat_lane_assignment_transition_guard;
DROP TRIGGER IF EXISTS chat_lane_assignment_transition_apply;

CREATE TRIGGER chat_lane_assignment_transition_guard_v2
BEFORE UPDATE OF status ON chat_lane_assignments
WHEN NEW.status <> OLD.status AND NEW.transition_reason GLOB 'mho250-v2:*'
BEGIN
  SELECT CASE WHEN NOT ((OLD.status='RUNNING' AND NEW.status IN ('PUBLISHING','BLOCKED')) OR (OLD.status='PUBLISHING' AND NEW.status IN ('COMPLETED','BLOCKED')))
    THEN RAISE(ABORT, 'chat_lane_transition_denied') END;
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM chat_lanes WHERE lane_id=OLD.lane_id AND current_assignment_id=OLD.assignment_id AND lease_token=OLD.lease_token AND lease_fence=OLD.lease_fence AND status=OLD.status)
    THEN RAISE(ABORT, 'chat_lane_transition_raced') END;
  SELECT CASE WHEN NEW.transition_reason='mho250-v2:lease_expired' AND OLD.lease_expires_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now') THEN 1
    WHEN NEW.transition_reason<>'mho250-v2:lease_expired' AND OLD.lease_expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now') THEN 1
    ELSE RAISE(ABORT, 'chat_lane_lease_expired') END;
END;

CREATE TRIGGER chat_lane_assignment_transition_apply_v2
AFTER UPDATE OF status ON chat_lane_assignments
WHEN NEW.status <> OLD.status AND NEW.transition_reason GLOB 'mho250-v2:*'
BEGIN
  UPDATE chat_lanes SET status=CASE WHEN NEW.status='PUBLISHING' THEN 'PUBLISHING' WHEN NEW.status='COMPLETED' THEN 'IDLE' WHEN NEW.transition_reason='mho250-v2:replace' THEN 'REPLACE' ELSE 'BLOCKED' END,
    chat_id=CASE WHEN NEW.transition_reason='mho250-v2:replace' THEN NULL ELSE chat_id END,
    lease_token=CASE WHEN NEW.status='PUBLISHING' THEN lease_token ELSE NULL END,
    lease_expires_at=CASE WHEN NEW.status='PUBLISHING' THEN lease_expires_at ELSE NULL END,
    current_assignment_id=CASE WHEN NEW.status='PUBLISHING' THEN current_assignment_id ELSE NULL END, updated_at=NEW.updated_at
  WHERE lane_id=OLD.lane_id AND current_assignment_id=OLD.assignment_id AND lease_token=OLD.lease_token AND lease_fence=OLD.lease_fence AND status=OLD.status;
  SELECT CASE WHEN NEW.status='PUBLISHING' AND NOT EXISTS (SELECT 1 FROM chat_lanes WHERE lane_id=OLD.lane_id AND status='PUBLISHING' AND current_assignment_id=OLD.assignment_id AND lease_token=OLD.lease_token AND lease_fence=OLD.lease_fence)
      THEN RAISE(ABORT, 'chat_lane_transition_raced')
    WHEN NEW.status='COMPLETED' AND NOT EXISTS (SELECT 1 FROM chat_lanes WHERE lane_id=OLD.lane_id AND status='IDLE' AND current_assignment_id IS NULL AND lease_token IS NULL AND lease_expires_at IS NULL)
      THEN RAISE(ABORT, 'chat_lane_transition_raced')
    WHEN NEW.status='BLOCKED' AND NEW.transition_reason='mho250-v2:replace' AND NOT EXISTS (SELECT 1 FROM chat_lanes WHERE lane_id=OLD.lane_id AND status='REPLACE' AND chat_id IS NULL AND current_assignment_id IS NULL)
      THEN RAISE(ABORT, 'chat_lane_transition_raced')
    WHEN NEW.status='BLOCKED' AND NEW.transition_reason<>'mho250-v2:replace' AND NOT EXISTS (SELECT 1 FROM chat_lanes WHERE lane_id=OLD.lane_id AND status='BLOCKED' AND current_assignment_id IS NULL AND lease_token IS NULL AND lease_expires_at IS NULL)
      THEN RAISE(ABORT, 'chat_lane_transition_raced') END;
  INSERT INTO chat_lane_events(event_id,assignment_id,event_type,payload_digest,created_at) VALUES(
    CASE WHEN NEW.transition_reason='mho250-v2:lease_expired' THEN 'expiry:'||NEW.assignment_id||':'||NEW.lease_fence ELSE 'transition:'||NEW.assignment_id||':'||NEW.lease_fence||':'||NEW.status END,
    NEW.assignment_id,CASE WHEN NEW.transition_reason='mho250-v2:lease_expired' THEN 'LEASE_EXPIRED' ELSE NEW.status END,COALESCE(NEW.output_digest,NEW.request_digest),NEW.updated_at);
END;
INSERT OR REPLACE INTO factory_schema_meta(schema_name,schema_version) VALUES ('factory-ledger',6);
