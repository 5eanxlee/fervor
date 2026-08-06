-- stride: destructive-review=observability.chain-index-restart

SET lock_timeout = '5s';
SET statement_timeout = '7min';
SET idle_in_transaction_session_timeout = '60s';
SET search_path = public;

DROP INDEX CONCURRENTLY IF EXISTS trade_exec_chain_stuck_idx;
CREATE INDEX CONCURRENTLY trade_exec_chain_stuck_idx
    ON trade_executions ((COALESCE(submitted_at, created_at)))
    WHERE state IN ('submitted', 'processed', 'confirmed');
