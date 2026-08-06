-- Bound operator and reconciliation scans to unresolved provider mutations.
-- stride: destructive-review=order-operation-index-recovery

SET lock_timeout = '5s';
SET statement_timeout = '10min';
SET idle_in_transaction_session_timeout = '60s';
SET search_path = public;

DROP INDEX CONCURRENTLY IF EXISTS order_intents_unknown_op_idx;

CREATE INDEX CONCURRENTLY order_intents_unknown_op_idx
    ON order_intents (provider, user_id, updated_at, id)
    WHERE error_code = 'provider_outcome_unknown' OR op_state = 'started';
