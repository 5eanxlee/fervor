-- stride: destructive-review=observability.hot-set-rebuild
-- Keep periodic operational aggregates on small active subsets instead of
-- scanning retained terminal history on every API replica.

SET lock_timeout = '5s';
SET statement_timeout = '8min';
SET idle_in_transaction_session_timeout = '60s';
SET search_path = public;

DROP INDEX CONCURRENTLY IF EXISTS event_outbox_failed_idx;
CREATE INDEX CONCURRENTLY event_outbox_failed_idx
    ON event_outbox (id)
    WHERE status = 'failed';

DROP INDEX CONCURRENTLY IF EXISTS notification_backlog_idx;
CREATE INDEX CONCURRENTLY notification_backlog_idx
    ON notification_deliveries (id)
    WHERE status IN ('pending', 'sending', 'retry_scheduled');

DROP INDEX CONCURRENTLY IF EXISTS order_stuck_idx;
CREATE INDEX CONCURRENTLY order_stuck_idx
    ON order_intents (updated_at, id)
    WHERE state IN ('preparing', 'activating', 'cancel_pending');

DROP INDEX CONCURRENTLY IF EXISTS tokens_observed_idx;
CREATE INDEX CONCURRENTLY tokens_observed_idx
    ON tokens (observed_at DESC)
    WHERE observed_at IS NOT NULL;

DROP INDEX CONCURRENTLY IF EXISTS trade_exec_signed_stuck_idx;
CREATE INDEX CONCURRENTLY trade_exec_signed_stuck_idx
    ON trade_executions ((COALESCE(broadcast_started_at, created_at)))
    WHERE state = 'signed';

DROP INDEX CONCURRENTLY IF EXISTS trade_exec_chain_stuck_idx;
CREATE INDEX CONCURRENTLY trade_exec_chain_stuck_idx
    ON trade_executions ((COALESCE(submitted_at, created_at)))
    WHERE state IN ('submitted', 'processed', 'confirmed');

DROP INDEX CONCURRENTLY IF EXISTS trade_exec_recovery_stats_idx;
CREATE INDEX CONCURRENTLY trade_exec_recovery_stats_idx
    ON trade_executions ((COALESCE(broadcast_started_at, submitted_at, created_at)))
    INCLUDE (provider_status, broadcast_count)
    WHERE signature IS NOT NULL
      AND (state IN ('submitted', 'processed', 'confirmed')
           OR (state = 'signed' AND broadcast_started_at IS NOT NULL));
