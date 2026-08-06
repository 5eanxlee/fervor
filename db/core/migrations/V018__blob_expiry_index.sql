-- Restartable online index for envelope-key destruction and tuple scrubbing.
-- stride: destructive-review=order-schema-index-restart

SET lock_timeout = '5s';
SET statement_timeout = '7min';
SET idle_in_transaction_session_timeout = '60s';
SET search_path = public;

DROP INDEX CONCURRENTLY IF EXISTS order_tx_blobs_expiry_idx;
CREATE INDEX CONCURRENTLY order_tx_blobs_expiry_idx
    ON order_tx_blobs (expires_at, action_id)
    WHERE purged_at IS NULL;
