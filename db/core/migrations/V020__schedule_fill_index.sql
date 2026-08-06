-- Enforce the one-finalized-fill-per-schedule consumption invariant without a
-- table rewrite or blocking ordinary schedule writes for the index build.
-- stride: destructive-review=schedule-fill-index-v20

SET lock_timeout = '5s';
SET statement_timeout = '7min';
SET idle_in_transaction_session_timeout = '60s';
SET search_path = public;

DROP INDEX CONCURRENTLY IF EXISTS order_schedules_fill_idx;

CREATE UNIQUE INDEX CONCURRENTLY order_schedules_fill_idx
    ON order_schedules (fill_id)
    WHERE fill_id IS NOT NULL;
