-- stride: destructive-review=observability.recovery-index-restart

SET lock_timeout = '5s';
SET statement_timeout = '7min';
SET idle_in_transaction_session_timeout = '60s';
SET search_path = public;

DROP INDEX CONCURRENTLY IF EXISTS trade_exec_recovery_stats_idx;
CREATE INDEX CONCURRENTLY trade_exec_recovery_stats_idx
    ON trade_executions ((COALESCE(broadcast_started_at, submitted_at, created_at)))
    INCLUDE (provider_status, broadcast_count)
    WHERE signature IS NOT NULL
      AND (state IN ('submitted', 'processed', 'confirmed')
           OR (state = 'signed' AND broadcast_started_at IS NOT NULL));
