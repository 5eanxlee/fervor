-- Bound predecessor gates to unfinished actions without blocking order-control
-- plane writers. This is isolated for exact interrupted-index recovery.
-- stride: destructive-review=action-predecessor-index-v25

SET lock_timeout = '5s';
SET statement_timeout = '7min';
SET idle_in_transaction_session_timeout = '60s';
SET search_path = public;

DROP INDEX CONCURRENTLY IF EXISTS order_actions_predecessor_idx;
CREATE INDEX CONCURRENTLY order_actions_predecessor_idx
    ON order_actions (order_id, expected_ver, id)
    WHERE work_state <> 'done';
