-- Make encrypted signed transactions durably decryptable and enforce blob
-- validity at attempt, egress, and decrypt authorization boundaries.
-- Existing version-1 blobs cannot reconstruct their authenticated data and are
-- conservatively quarantined instead of being reinterpreted.
-- stride: destructive-review=transaction-blob-hardening

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';
SET LOCAL idle_in_transaction_session_timeout = '60s';
SET LOCAL search_path = public;

LOCK TABLE order_actions, action_attempts, action_egress, order_tx_blobs
    IN SHARE ROW EXCLUSIVE MODE;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
          FROM action_egress egress
          JOIN order_tx_blobs blob ON blob.action_id = egress.action_id
         WHERE egress.completed_at IS NULL
    ) THEN
        RAISE EXCEPTION
            'transaction blob hardening requires every legacy egress authorization to be closed';
    END IF;
END;
$$;

ALTER TABLE order_tx_blobs
    ADD COLUMN aad_ver SMALLINT NOT NULL DEFAULT 1,
    ADD COLUMN raw_hash CHAR(64);

ALTER TABLE order_tx_blobs
    ALTER COLUMN aad_ver SET DEFAULT 2,
    ADD CONSTRAINT order_tx_blobs_aad_v2 CHECK (
        (aad_ver = 1 AND raw_hash IS NULL)
        OR (aad_ver = 2 AND raw_hash ~ '^[0-9a-f]{64}$')
    ) NOT VALID;

ALTER TABLE order_tx_blobs VALIDATE CONSTRAINT order_tx_blobs_aad_v2;

ALTER TABLE order_blob_reads
    ADD COLUMN lease_owner VARCHAR(128);

-- Signed actions and Trigger confirmations admitted under the prior mutable
-- policy cannot be dispatched automatically. Preserve all evidence and require
-- an operator/chain reconciliation decision.
UPDATE order_actions action
   SET action_ver = action.action_ver + 1,
       work_state = 'parked',
       effect_state = CASE
           WHEN action.effect_state = 'conflict' THEN 'conflict'
           ELSE 'possible'
       END,
       outcome = 'manual_review',
       block_reason = 'operator_hold',
       lease_owner = NULL,
       lease_until = NULL,
       write_scope = NULL,
       write_epoch = NULL,
       ambiguity_at = COALESCE(action.ambiguity_at, clock_timestamp()),
       error_code = 'signed_policy_upgrade',
       error_class = 'policy',
       error_message = 'Signed transaction policy changed; reconcile before further mutation'
 WHERE action.work_state <> 'done'
   AND (
       action.kind = 'cancel_confirm'
       OR EXISTS (
           SELECT 1 FROM order_tx_blobs blob
            WHERE blob.action_id = action.id AND blob.aad_ver = 1
       )
   );

INSERT INTO order_anomalies (
    id, anomaly_key, order_id, action_id, scope, kind, severity,
    blocks_actions, detail_hash, detail
)
SELECT gen_random_uuid(),
       'migration:v39:signed-policy:' || action.id::text,
       action.order_id,
       action.id,
       'action',
       'policy_violation',
       'critical',
       true,
       encode(digest(
           convert_to('migration:v39:signed-policy:' || action.id::text, 'UTF8'),
           'sha256'
       ), 'hex'),
       jsonb_build_object(
           'actionId', action.id,
           'kind', action.kind,
           'reason', 'signed_transaction_policy_upgrade',
           'legacyBlob', EXISTS (
               SELECT 1 FROM order_tx_blobs blob
                WHERE blob.action_id = action.id AND blob.aad_ver = 1
           )
       )
  FROM order_actions action
 WHERE action.error_code = 'signed_policy_upgrade'
ON CONFLICT (anomaly_key) DO NOTHING;

CREATE OR REPLACE FUNCTION order_tx_meta_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
    IF OLD.message_hash IS NOT NULL AND (
        NEW.message_hash IS DISTINCT FROM OLD.message_hash
        OR NEW.recent_blockhash IS DISTINCT FROM OLD.recent_blockhash
        OR NEW.last_valid_height IS DISTINCT FROM OLD.last_valid_height
    ) THEN
        RAISE EXCEPTION 'committed prepared transaction identity cannot change'
            USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
END;
$$;

CREATE FUNCTION order_tx_blob_v2_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
    IF TG_OP = 'INSERT' AND (NEW.aad_ver <> 2 OR NEW.raw_hash IS NULL) THEN
        RAISE EXCEPTION 'new encrypted transaction blobs require durable version-2 identity'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER order_tx_blobs_v2_guard
    BEFORE INSERT ON order_tx_blobs
    FOR EACH ROW EXECUTE FUNCTION order_tx_blob_v2_guard();

CREATE FUNCTION action_attempts_z_blob_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
    IF NEW.blob_action_id IS NOT NULL AND NEW.send_state IN ('prepared', 'started')
        AND NOT EXISTS (
            SELECT 1 FROM order_tx_blobs blob
             WHERE blob.action_id = NEW.blob_action_id
               AND blob.aad_ver = 2
               AND blob.purged_at IS NULL
               AND blob.expires_at > NEW.deadline_at
             FOR SHARE
        ) THEN
        RAISE EXCEPTION 'attempt transaction blob does not outlive its transport deadline'
            USING ERRCODE = '40001';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER action_attempts_z_blob_guard
    BEFORE INSERT OR UPDATE ON action_attempts
    FOR EACH ROW EXECUTE FUNCTION action_attempts_z_blob_guard();

CREATE FUNCTION action_egress_z_blob_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
    IF TG_OP = 'INSERT' AND NEW.blob_action_id IS NOT NULL AND NOT EXISTS (
        SELECT 1
          FROM action_attempts attempt
          JOIN order_tx_blobs blob ON blob.action_id = NEW.blob_action_id
         WHERE attempt.id = NEW.attempt_id
           AND attempt.action_id = NEW.action_id
           AND blob.aad_ver = 2
           AND blob.purged_at IS NULL
           AND blob.expires_at > attempt.deadline_at
         FOR SHARE OF blob
    ) THEN
        RAISE EXCEPTION 'egress transaction blob is unavailable for its full deadline'
            USING ERRCODE = '40001';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER action_egress_z_blob_guard
    BEFORE INSERT ON action_egress
    FOR EACH ROW EXECUTE FUNCTION action_egress_z_blob_guard();

CREATE OR REPLACE FUNCTION order_blob_read_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
    action order_actions%ROWTYPE;
    attempt action_attempts%ROWTYPE;
    target_order UUID;
    now_at TIMESTAMPTZ;
BEGIN
    SELECT stored.order_id INTO target_order
      FROM order_actions stored
     WHERE stored.id = NEW.action_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'blob-read action does not exist' USING ERRCODE = '23514';
    END IF;
    PERFORM 1 FROM order_intents stored WHERE stored.id = target_order FOR SHARE;
    SELECT * INTO action FROM order_actions stored WHERE stored.id = NEW.action_id FOR SHARE;
    SELECT * INTO attempt FROM action_attempts stored WHERE stored.id = NEW.attempt_id FOR SHARE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'blob-read attempt does not exist' USING ERRCODE = '23514';
    END IF;
    PERFORM pg_advisory_xact_lock_shared(hashtextextended(NEW.write_scope, 1937006964));
    now_at := clock_timestamp();

    IF attempt.action_id <> action.id
        OR attempt.send_state <> 'started'
        OR attempt.deadline_at <= now_at
        OR action.lease_owner IS NULL
        OR NEW.lease_owner IS NULL
        OR action.lease_owner <> NEW.lease_owner
        OR action.lease_gen <> NEW.lease_gen
        OR action.lease_until <= now_at
        OR action.write_scope <> NEW.write_scope
        OR action.write_epoch <> NEW.write_epoch
        OR attempt.lease_gen <> NEW.lease_gen
        OR attempt.write_scope <> NEW.write_scope
        OR attempt.write_epoch <> NEW.write_epoch
        OR NOT EXISTS (
            SELECT 1 FROM order_epoch_current epoch
             WHERE epoch.scope = NEW.write_scope
               AND epoch.epoch = NEW.write_epoch
               AND epoch.mode = 'live'
        )
        OR NOT EXISTS (
            SELECT 1 FROM order_tx_blobs blob
             WHERE blob.action_id = NEW.action_id
               AND blob.aad_ver = 2
               AND blob.purged_at IS NULL
               AND blob.expires_at > attempt.deadline_at
             FOR SHARE
        ) THEN
        RAISE EXCEPTION 'blob access does not match one live outbound authorization'
            USING ERRCODE = '40001';
    END IF;
    RETURN NEW;
END;
$$;

COMMENT ON COLUMN order_tx_blobs.aad_ver IS
    'Authenticated-data contract version; only version 2 is decryptable by current runtimes';
COMMENT ON COLUMN order_tx_blobs.raw_hash IS
    'Durable SHA-256 identity required to reconstruct version-2 authenticated data';
COMMENT ON COLUMN order_blob_reads.lease_owner IS
    'Exact action lease owner authorizing this immutable decrypt-access fact';
COMMENT ON FUNCTION order_tx_meta_guard() IS
    'Freeze provider-prepared message and validity identity before wallet signing';
COMMENT ON FUNCTION order_blob_read_guard() IS
    'Authorize decrypt only while the fenced attempt and version-2 blob cover the full deadline';
