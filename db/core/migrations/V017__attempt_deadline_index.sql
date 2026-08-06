-- Restartable online index for timed-out dispatch reconciliation.
-- stride: destructive-review=order-schema-index-restart

SET lock_timeout = '5s';
SET statement_timeout = '7min';
SET idle_in_transaction_session_timeout = '60s';
SET search_path = public;

DROP INDEX CONCURRENTLY IF EXISTS action_attempts_deadline_idx;
CREATE INDEX CONCURRENTLY action_attempts_deadline_idx
    ON action_attempts (deadline_at, action_id, seq)
    WHERE send_state = 'started';
