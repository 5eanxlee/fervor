-- Distinguish gateways that durably record transport entry before invoking the
-- provider, then recover their expired reservations after a process crash.
-- stride: destructive-review=egress-recovery-v34

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';
SET LOCAL idle_in_transaction_session_timeout = '60s';
SET LOCAL search_path = public;

ALTER TABLE action_egress
    ADD COLUMN writer_ver SMALLINT;

ALTER TABLE action_egress
    ADD CONSTRAINT action_egress_writer_ver CHECK (
        writer_ver IS NULL OR writer_ver = 2
    ) NOT VALID;

ALTER TABLE action_egress VALIDATE CONSTRAINT action_egress_writer_ver;

CREATE FUNCTION recover_action_egress(batch_size INTEGER)
RETURNS TABLE (attempt_id UUID)
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
    IF batch_size < 1 OR batch_size > 1000 THEN
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

COMMENT ON COLUMN action_egress.writer_ver IS
    'Version 2 proves the gateway records started_at before provider transport entry; null is legacy';
COMMENT ON FUNCTION recover_action_egress(INTEGER) IS
    'Close expired version-2 reservations that crashed before provider transport entry';
