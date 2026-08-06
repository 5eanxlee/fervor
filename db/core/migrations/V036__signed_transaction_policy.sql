-- Align confirm-cancel dispatch with Jupiter Trigger V2 and widen KMS key
-- identity storage for full provider ARNs. The precondition fails closed rather
-- than reinterpreting a historical bodyless confirmation attempt.
-- stride: destructive-review=signed-transaction-policy-v36

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';
SET LOCAL idle_in_transaction_session_timeout = '60s';
SET LOCAL search_path = public;

LOCK TABLE action_attempts IN SHARE ROW EXCLUSIVE MODE;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
          FROM action_attempts attempt
          JOIN order_actions action ON action.id = attempt.action_id
         WHERE action.kind = 'cancel_confirm'
    ) THEN
        RAISE EXCEPTION
            'cancel-confirm attempts predate the signed Trigger V2 policy; reconcile them before V036';
    END IF;
END;
$$;

ALTER TABLE order_tx_blobs
    ALTER COLUMN key_id TYPE VARCHAR(2048);

CREATE FUNCTION order_tx_meta_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
    IF (NEW.recent_blockhash IS DISTINCT FROM OLD.recent_blockhash
        OR NEW.last_valid_height IS DISTINCT FROM OLD.last_valid_height)
        AND EXISTS (
            SELECT 1 FROM order_tx_blobs blob WHERE blob.action_id = OLD.id
        ) THEN
        RAISE EXCEPTION 'committed transaction validity metadata cannot change'
            USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER order_actions_tx_meta_guard
    BEFORE UPDATE ON order_actions
    FOR EACH ROW EXECUTE FUNCTION order_tx_meta_guard();

CREATE OR REPLACE FUNCTION action_dispatch_valid(
    action_kind VARCHAR,
    attempt_method VARCHAR,
    has_body BOOLEAN,
    has_blob BOOLEAN
) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path = pg_catalog, pg_temp AS $$
    SELECT coalesce(CASE action_kind
        WHEN 'prepare' THEN attempt_method = 'POST' AND has_body AND NOT has_blob
        WHEN 'activate' THEN attempt_method = 'POST' AND has_body AND has_blob
        WHEN 'edit' THEN attempt_method IN ('POST', 'PATCH', 'PUT') AND has_body AND NOT has_blob
        WHEN 'cancel_init' THEN attempt_method IN ('POST', 'DELETE') AND has_body AND NOT has_blob
        WHEN 'cancel_confirm' THEN attempt_method = 'POST' AND has_body AND has_blob
        WHEN 'provider_sync' THEN attempt_method = 'GET' AND NOT has_body AND NOT has_blob
        WHEN 'chain_sync' THEN attempt_method = 'GET' AND NOT has_body AND NOT has_blob
        WHEN 'expire' THEN attempt_method IN ('POST', 'DELETE') AND has_body AND NOT has_blob
        WHEN 'compensate' THEN attempt_method = 'POST' AND has_body AND has_blob
        ELSE false
    END, false)
$$;

CREATE OR REPLACE FUNCTION action_attempt_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
    action order_actions%ROWTYPE;
    matched BOOLEAN;
    now_at TIMESTAMPTZ;
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'action_attempts is append-once' USING ERRCODE = '55000';
    END IF;
    IF TG_OP = 'INSERT' THEN
        SELECT * INTO action FROM order_actions WHERE id = NEW.action_id FOR UPDATE;
        matched := FOUND;
        IF NOT matched THEN
            RAISE EXCEPTION 'attempt action does not exist' USING ERRCODE = '23514';
        END IF;
        PERFORM pg_advisory_xact_lock_shared(hashtextextended(action.write_scope, 1937006964));
        now_at := clock_timestamp();
        IF action.lease_gen <> NEW.lease_gen
            OR action.write_scope <> NEW.write_scope
            OR action.write_epoch <> NEW.write_epoch
            OR action.lease_owner IS NULL
            OR action.lease_until <= now_at
            OR NOT EXISTS (
                SELECT 1 FROM order_epoch_current epoch
                 WHERE epoch.scope = action.write_scope
                   AND epoch.epoch = action.write_epoch
                   AND epoch.mode = 'live'
            ) THEN
            RAISE EXCEPTION 'attempt fence is no longer active' USING ERRCODE = '40001';
        END IF;
        IF action.desired_hash <> NEW.desired_hash
            OR action.req_hash <> NEW.req_hash
            OR action.provider <> NEW.provider
            OR action.attempt_count <> NEW.seq
            OR NEW.send_state = 'response_recorded'
            OR (NEW.send_state = 'started' AND (
                action.work_state <> 'dispatching' OR action.effect_state <> 'possible'
            )) THEN
            RAISE EXCEPTION 'attempt does not match its admitted action fact'
                USING ERRCODE = '23514';
        END IF;
        IF NOT action_dispatch_valid(
            action.kind,
            NEW.method,
            NEW.body_hash IS NOT NULL,
            NEW.blob_action_id IS NOT NULL
        ) THEN
            RAISE EXCEPTION 'attempt method, body, or blob violates its action-kind dispatch policy'
                USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
    END IF;
    IF (to_jsonb(NEW) - ARRAY[
        'send_state', 'started_at', 'completed_at', 'http_status', 'http_class',
        'response_hash', 'provider_effect_id', 'error_code', 'error_message'
    ]) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY[
        'send_state', 'started_at', 'completed_at', 'http_status', 'http_class',
        'response_hash', 'provider_effect_id', 'error_code', 'error_message'
    ]) THEN
        RAISE EXCEPTION 'attempt request identity is immutable' USING ERRCODE = '55000';
    END IF;
    IF NOT ((OLD.send_state = 'prepared' AND NEW.send_state = 'started')
        OR (OLD.send_state = 'started' AND NEW.send_state = 'response_recorded')) THEN
        RAISE EXCEPTION 'invalid attempt fact transition % to %', OLD.send_state, NEW.send_state
            USING ERRCODE = '23514';
    END IF;
    IF OLD.send_state = 'started' AND NEW.started_at IS DISTINCT FROM OLD.started_at THEN
        RAISE EXCEPTION 'attempt start time is immutable after dispatch' USING ERRCODE = '55000';
    END IF;
    IF OLD.send_state = 'prepared' THEN
        SELECT * INTO action FROM order_actions WHERE id = NEW.action_id FOR UPDATE;
        matched := FOUND;
        IF matched THEN
            PERFORM pg_advisory_xact_lock_shared(hashtextextended(NEW.write_scope, 1937006964));
        END IF;
        now_at := clock_timestamp();
        IF NOT matched OR action.lease_gen <> NEW.lease_gen
            OR action.write_scope <> NEW.write_scope
            OR action.write_epoch <> NEW.write_epoch
            OR action.lease_owner IS NULL
            OR action.lease_until <= now_at
            OR action.attempt_count <> NEW.seq
            OR action.work_state <> 'dispatching'
            OR action.effect_state <> 'possible'
            OR NOT EXISTS (
                SELECT 1 FROM order_epoch_current epoch
                 WHERE epoch.scope = NEW.write_scope
                   AND epoch.epoch = NEW.write_epoch
                   AND epoch.mode = 'live'
            ) THEN
            RAISE EXCEPTION 'attempt start does not match the active action fence'
                USING ERRCODE = '23514';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION action_dispatch_valid(VARCHAR, VARCHAR, BOOLEAN, BOOLEAN) IS
    'Version 1 action dispatch matrix aligned with signed Jupiter Trigger V2 confirmation';
COMMENT ON COLUMN order_tx_blobs.key_id IS
    'Full key-provider identity used to wrap the per-transaction data key';
COMMENT ON FUNCTION order_tx_meta_guard() IS
    'Freeze blockhash validity metadata after encrypted signed bytes are committed';
