-- Install the complete attempt policy immediately after checksum-pinned V022.
-- Creating the trigger closes the old-writer race before the historical scan.
-- stride: destructive-review=action-policy-v22.1

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';
SET LOCAL idle_in_transaction_session_timeout = '60s';
SET LOCAL search_path = public;

CREATE FUNCTION action_dispatch_valid(
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
        WHEN 'cancel_confirm' THEN attempt_method = 'GET' AND NOT has_body AND NOT has_blob
        WHEN 'provider_sync' THEN attempt_method = 'GET' AND NOT has_body AND NOT has_blob
        WHEN 'chain_sync' THEN attempt_method = 'GET' AND NOT has_body AND NOT has_blob
        WHEN 'expire' THEN attempt_method IN ('POST', 'DELETE') AND has_body AND NOT has_blob
        WHEN 'compensate' THEN attempt_method = 'POST' AND has_body AND has_blob
        ELSE false
    END, false)
$$;

CREATE FUNCTION action_http_valid(
    response_class VARCHAR,
    response_status INTEGER,
    has_error BOOLEAN,
    has_message BOOLEAN
) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path = pg_catalog, pg_temp AS $$
    SELECT coalesce(CASE response_class
        WHEN 'success' THEN response_status BETWEEN 200 AND 299
            AND NOT has_error AND NOT has_message
        WHEN 'client_error' THEN response_status BETWEEN 400 AND 499
            AND response_status NOT IN (401, 403, 409, 429) AND has_error
        WHEN 'auth_error' THEN response_status IN (401, 403) AND has_error
        WHEN 'rate_limited' THEN response_status = 429 AND has_error
        WHEN 'conflict' THEN response_status = 409 AND has_error
        WHEN 'server_error' THEN response_status BETWEEN 500 AND 599 AND has_error
        WHEN 'transport_error' THEN response_status IS NULL AND has_error
        WHEN 'timeout' THEN response_status IS NULL AND has_error
        ELSE false
    END, false)
$$;

CREATE FUNCTION action_policy_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
    action_kind VARCHAR;
BEGIN
    SELECT kind INTO action_kind FROM order_actions WHERE id = NEW.action_id;
    IF NOT FOUND OR NOT action_dispatch_valid(
        action_kind,
        NEW.method,
        NEW.body_hash IS NOT NULL,
        NEW.blob_action_id IS NOT NULL
    ) THEN
        RAISE EXCEPTION 'attempt violates the versioned dispatch policy'
            USING ERRCODE = '23514';
    END IF;
    IF NEW.send_state = 'response_recorded' AND NOT action_http_valid(
        NEW.http_class,
        NEW.http_status,
        NEW.error_code IS NOT NULL,
        NEW.error_message IS NOT NULL
    ) THEN
        RAISE EXCEPTION 'attempt violates the versioned response policy'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER action_attempt_policy_guard
    BEFORE INSERT OR UPDATE ON action_attempts
    FOR EACH ROW EXECUTE FUNCTION action_policy_guard();

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
          FROM action_attempts attempt
          JOIN order_actions action ON action.id = attempt.action_id
         WHERE NOT action_dispatch_valid(
                   action.kind,
                   attempt.method,
                   attempt.body_hash IS NOT NULL,
                   attempt.blob_action_id IS NOT NULL
               )
            OR (attempt.send_state = 'response_recorded' AND NOT action_http_valid(
                   attempt.http_class,
                   attempt.http_status,
                   attempt.error_code IS NOT NULL,
                   attempt.error_message IS NOT NULL
               ))
    ) THEN
        RAISE EXCEPTION 'existing action attempt violates the versioned policy';
    END IF;
END;
$$;

COMMENT ON FUNCTION action_dispatch_valid(VARCHAR, VARCHAR, BOOLEAN, BOOLEAN) IS
    'Version 1 action-kind method, body, and signed-blob dispatch matrix';
COMMENT ON FUNCTION action_http_valid(VARCHAR, INTEGER, BOOLEAN, BOOLEAN) IS
    'Version 1 normalized response class, status, and error-fact matrix';
COMMENT ON FUNCTION action_policy_guard() IS
    'Keep attempt writes aligned with the callable version 1 policy matrix';
