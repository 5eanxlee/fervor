-- Make outbound attempt identity and action-kind dispatch policy authoritative
-- in PostgreSQL as well as the typed repository.
-- stride: destructive-review=attempt-dispatch-guard-v22

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';
SET LOCAL idle_in_transaction_session_timeout = '60s';
SET LOCAL search_path = public;

LOCK TABLE order_actions, action_attempts IN SHARE ROW EXCLUSIVE MODE;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
          FROM action_attempts attempt
          JOIN order_actions action ON action.id = attempt.action_id
         WHERE attempt.req_hash <> action.req_hash
            OR attempt.provider <> action.provider
            OR (attempt.blob_action_id IS NOT NULL
                AND attempt.blob_action_id <> attempt.action_id)
            OR (action.kind IN ('cancel_confirm', 'provider_sync', 'chain_sync') AND (
                attempt.method <> 'GET' OR attempt.body_hash IS NOT NULL
                OR attempt.blob_action_id IS NOT NULL
            ))
            OR (action.kind = 'prepare' AND (
                attempt.method <> 'POST' OR attempt.body_hash IS NULL
                OR attempt.blob_action_id IS NOT NULL
            ))
            OR (action.kind = 'activate' AND (
                attempt.method <> 'POST' OR attempt.body_hash IS NULL
                OR attempt.blob_action_id IS DISTINCT FROM attempt.action_id
            ))
            OR (action.kind = 'edit' AND (
                attempt.method NOT IN ('POST', 'PATCH', 'PUT') OR attempt.body_hash IS NULL
                OR attempt.blob_action_id IS NOT NULL
            ))
            OR (action.kind IN ('cancel_init', 'expire') AND (
                attempt.method NOT IN ('POST', 'DELETE') OR attempt.body_hash IS NULL
                OR attempt.blob_action_id IS NOT NULL
            ))
            OR (action.kind = 'compensate' AND (
                attempt.method <> 'POST' OR attempt.body_hash IS NULL
                OR attempt.blob_action_id IS DISTINCT FROM attempt.action_id
            ))
    ) THEN
        RAISE EXCEPTION 'existing action attempt violates its admitted dispatch policy';
    END IF;
END;
$$;

ALTER TABLE action_attempts
    ADD CONSTRAINT action_attempt_blob_owner CHECK (
        blob_action_id IS NULL OR blob_action_id = action_id
    ) NOT VALID;

ALTER TABLE action_attempts
    VALIDATE CONSTRAINT action_attempt_blob_owner;

ALTER TABLE action_attempts
    ADD CONSTRAINT action_attempt_http_fact CHECK (
        send_state <> 'response_recorded'
        OR CASE http_class
            WHEN 'success' THEN
                http_status BETWEEN 200 AND 299
                AND error_code IS NULL AND error_message IS NULL
            WHEN 'client_error' THEN
                http_status BETWEEN 400 AND 499
                AND http_status NOT IN (401, 403, 409, 429)
                AND error_code IS NOT NULL
            WHEN 'auth_error' THEN
                http_status IN (401, 403) AND error_code IS NOT NULL
            WHEN 'rate_limited' THEN
                http_status = 429 AND error_code IS NOT NULL
            WHEN 'conflict' THEN
                http_status = 409 AND error_code IS NOT NULL
            WHEN 'server_error' THEN
                http_status BETWEEN 500 AND 599 AND error_code IS NOT NULL
            WHEN 'transport_error' THEN
                http_status IS NULL AND error_code IS NOT NULL
            WHEN 'timeout' THEN
                http_status IS NULL AND error_code IS NOT NULL
            ELSE false
        END
    ) NOT VALID;

ALTER TABLE action_attempts
    VALIDATE CONSTRAINT action_attempt_http_fact;

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
        IF (action.kind IN ('cancel_confirm', 'provider_sync', 'chain_sync') AND (
                NEW.method <> 'GET' OR NEW.body_hash IS NOT NULL OR NEW.blob_action_id IS NOT NULL
            ))
            OR (action.kind = 'prepare' AND (
                NEW.method <> 'POST' OR NEW.body_hash IS NULL OR NEW.blob_action_id IS NOT NULL
            ))
            OR (action.kind = 'activate' AND (
                NEW.method <> 'POST' OR NEW.body_hash IS NULL
                OR NEW.blob_action_id IS DISTINCT FROM NEW.action_id
            ))
            OR (action.kind = 'edit' AND (
                NEW.method NOT IN ('POST', 'PATCH', 'PUT') OR NEW.body_hash IS NULL
                OR NEW.blob_action_id IS NOT NULL
            ))
            OR (action.kind IN ('cancel_init', 'expire') AND (
                NEW.method NOT IN ('POST', 'DELETE') OR NEW.body_hash IS NULL
                OR NEW.blob_action_id IS NOT NULL
            ))
            OR (action.kind = 'compensate' AND (
                NEW.method <> 'POST' OR NEW.body_hash IS NULL
                OR NEW.blob_action_id IS DISTINCT FROM NEW.action_id
            )) THEN
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
        IF action.req_hash <> NEW.req_hash
            OR action.attempt_count <> NEW.seq
            OR action.work_state <> 'dispatching'
            OR action.effect_state <> 'possible' THEN
            RAISE EXCEPTION 'attempt start does not match its admitted action fact'
                USING ERRCODE = '23514';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

COMMENT ON CONSTRAINT action_attempt_blob_owner ON action_attempts IS
    'A signed transaction blob may authorize only the action that owns the immutable attempt';
COMMENT ON CONSTRAINT action_attempt_http_fact ON action_attempts IS
    'Normalized response class, status, and error facts must agree';
COMMENT ON FUNCTION action_attempt_guard() IS
    'Validate request identity, action-kind dispatch policy, and active fence after row/advisory locks';
