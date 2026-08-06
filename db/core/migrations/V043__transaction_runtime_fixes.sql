-- Make decrypt authorization retries exact and align every signed-blob path
-- with aggregate -> action -> attempt -> blob lock order.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';
SET LOCAL idle_in_transaction_session_timeout = '60s';
SET LOCAL search_path = public;

CREATE FUNCTION assert_blob_access(
    target_action UUID,
    target_attempt UUID,
    target_owner VARCHAR,
    target_gen BIGINT,
    target_scope VARCHAR,
    target_epoch BIGINT
) RETURNS VOID
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
    action_row order_actions%ROWTYPE;
    attempt_row action_attempts%ROWTYPE;
    target_order UUID;
    blob_ok BOOLEAN;
    now_at TIMESTAMPTZ;
BEGIN
    SELECT stored.order_id INTO target_order
      FROM order_actions stored
     WHERE stored.id = target_action;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'blob-read action does not exist' USING ERRCODE = '23514';
    END IF;

    PERFORM 1 FROM order_intents stored WHERE stored.id = target_order FOR SHARE;
    SELECT * INTO action_row
      FROM order_actions stored
     WHERE stored.id = target_action
     FOR SHARE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'blob-read action does not exist' USING ERRCODE = '23514';
    END IF;
    SELECT * INTO attempt_row
      FROM action_attempts stored
     WHERE stored.id = target_attempt
     FOR SHARE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'blob-read attempt does not exist' USING ERRCODE = '23514';
    END IF;

    PERFORM pg_advisory_xact_lock_shared(hashtextextended(target_scope, 1937006964));
    PERFORM 1
      FROM order_tx_blobs blob
     WHERE blob.action_id = target_action
       AND blob.aad_ver = 2
       AND blob.purged_at IS NULL
       AND blob.expires_at > attempt_row.deadline_at
     FOR SHARE;
    blob_ok := FOUND;
    now_at := clock_timestamp();

    IF attempt_row.action_id <> action_row.id
        OR attempt_row.send_state <> 'started'
        OR attempt_row.deadline_at <= now_at
        OR action_row.lease_owner IS NULL
        OR target_owner IS NULL
        OR action_row.lease_owner <> target_owner
        OR action_row.lease_gen <> target_gen
        OR action_row.lease_until <= now_at
        OR action_row.write_scope <> target_scope
        OR action_row.write_epoch <> target_epoch
        OR attempt_row.lease_gen <> target_gen
        OR attempt_row.write_scope <> target_scope
        OR attempt_row.write_epoch <> target_epoch
        OR NOT EXISTS (
            SELECT 1 FROM order_epoch_current epoch
             WHERE epoch.scope = target_scope
               AND epoch.epoch = target_epoch
               AND epoch.mode = 'live'
        )
        OR NOT blob_ok THEN
        RAISE EXCEPTION 'blob access does not match one live outbound authorization'
            USING ERRCODE = '40001';
    END IF;
END;
$$;

CREATE OR REPLACE FUNCTION order_blob_read_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
    PERFORM assert_blob_access(
        NEW.action_id,
        NEW.attempt_id,
        NEW.lease_owner,
        NEW.lease_gen,
        NEW.write_scope,
        NEW.write_epoch
    );
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION purge_order_tx_blob(target UUID, proof VARCHAR, destroyed TIMESTAMPTZ)
RETURNS BOOLEAN
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
    target_order UUID;
BEGIN
    IF proof IS NULL OR btrim(proof) = '' OR destroyed IS NULL THEN
        RAISE EXCEPTION 'destruction proof and time are required' USING ERRCODE = '22023';
    END IF;

    SELECT action.order_id INTO target_order
      FROM order_actions action
     WHERE action.id = target;
    IF NOT FOUND THEN
        RETURN FALSE;
    END IF;
    PERFORM 1 FROM order_intents order_row WHERE order_row.id = target_order FOR UPDATE;
    PERFORM 1 FROM order_actions action WHERE action.id = target FOR UPDATE;
    PERFORM 1 FROM action_attempts attempt WHERE attempt.action_id = target FOR SHARE;
    PERFORM 1
      FROM order_tx_blobs blob
     WHERE blob.action_id = target AND blob.purged_at IS NULL
     FOR UPDATE;
    IF NOT FOUND THEN
        RETURN FALSE;
    END IF;

    UPDATE order_tx_blobs blob
       SET ciphertext = decode(repeat('00', 17), 'hex'),
           nonce = decode(repeat('00', CASE WHEN blob.alg = 'aes_256_gcm' THEN 12 ELSE 24 END), 'hex'),
           wrapped_key = decode(repeat('00', 32), 'hex'),
           key_id = 'destroyed',
           destroyed_at = destroyed,
           destroy_ref = proof,
           purged_at = clock_timestamp()
     WHERE blob.action_id = target AND blob.purged_at IS NULL;
    RETURN FOUND;
END;
$$;

COMMENT ON FUNCTION assert_blob_access(UUID, UUID, VARCHAR, BIGINT, VARCHAR, BIGINT) IS
    'Recheck one exact signed-blob authorization in global row-lock order';
COMMENT ON FUNCTION order_blob_read_guard() IS
    'Record decrypt authorization only while its exact fenced attempt remains live';
COMMENT ON FUNCTION purge_order_tx_blob(UUID, VARCHAR, TIMESTAMPTZ) IS
    'Create a terminal crypto tombstone after acquiring aggregate-to-blob locks';
