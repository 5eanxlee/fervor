-- Keep the recovery batch bounded even when a direct caller passes SQL NULL.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';
SET LOCAL idle_in_transaction_session_timeout = '60s';
SET LOCAL search_path = public;

CREATE OR REPLACE FUNCTION recover_action_egress(batch_size INTEGER)
RETURNS TABLE (attempt_id UUID)
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
    IF batch_size IS NULL OR batch_size < 1 OR batch_size > 1000 THEN
        RAISE EXCEPTION 'egress recovery batch must be between 1 and 1000'
            USING ERRCODE = '22023';
    END IF;

    RETURN QUERY
    WITH due AS MATERIALIZED (
        SELECT egress.attempt_id
          FROM action_attempts attempt
          JOIN action_egress egress ON egress.attempt_id = attempt.id
         WHERE attempt.send_state = 'started'
           AND attempt.deadline_at <= clock_timestamp()
           AND egress.writer_ver = 2
           AND egress.started_at IS NULL
           AND egress.completed_at IS NULL
         ORDER BY attempt.deadline_at, attempt.action_id, attempt.seq
         FOR UPDATE OF egress SKIP LOCKED
         LIMIT batch_size
    )
    UPDATE action_egress egress
       SET completed_at = clock_timestamp(),
           end_kind = 'deadline_before_start'
      FROM due
     WHERE egress.attempt_id = due.attempt_id
       AND egress.completed_at IS NULL
    RETURNING egress.attempt_id;
END;
$$;

COMMENT ON FUNCTION recover_action_egress(INTEGER) IS
    'Close a non-null bounded batch of expired version-2 reservations that never entered transport';
