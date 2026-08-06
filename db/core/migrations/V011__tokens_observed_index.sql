-- stride: destructive-review=observability.token-index-restart

SET lock_timeout = '5s';
SET statement_timeout = '7min';
SET idle_in_transaction_session_timeout = '60s';
SET search_path = public;

DROP INDEX CONCURRENTLY IF EXISTS tokens_observed_idx;
CREATE INDEX CONCURRENTLY tokens_observed_idx
    ON tokens (observed_at DESC)
    WHERE observed_at IS NOT NULL;
