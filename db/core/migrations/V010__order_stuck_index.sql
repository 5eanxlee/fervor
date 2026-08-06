-- stride: destructive-review=observability.order-index-restart

SET lock_timeout = '5s';
SET statement_timeout = '7min';
SET idle_in_transaction_session_timeout = '60s';
SET search_path = public;

DROP INDEX CONCURRENTLY IF EXISTS order_stuck_idx;
CREATE INDEX CONCURRENTLY order_stuck_idx
    ON order_intents (updated_at, id)
    WHERE state IN ('preparing', 'activating', 'cancel_pending');
