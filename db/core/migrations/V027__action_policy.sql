-- Re-audit the early V022.1 attempt policy after the concurrent operational-index
-- window.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';
SET LOCAL idle_in_transaction_session_timeout = '60s';
SET LOCAL search_path = public;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
          FROM pg_trigger
         WHERE tgrelid = 'action_attempts'::regclass
           AND tgname = 'action_attempt_policy_guard'
           AND NOT tgisinternal
    ) THEN
        RAISE EXCEPTION 'early action attempt policy guard is missing';
    END IF;

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
        RAISE EXCEPTION 'action attempt policy drift occurred after V022.1';
    END IF;
END;
$$;
