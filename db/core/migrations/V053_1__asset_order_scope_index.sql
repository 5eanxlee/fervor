-- Bound claim linearization by actionable orders instead of a wallet's full
-- order history. This stays isolated for exact interrupted-index recovery.
-- stride: destructive-review=asset-order-scope-index-recovery

SET lock_timeout = '5s';
SET statement_timeout = '7min';
SET idle_in_transaction_session_timeout = '60s';
SET search_path = public;

DROP INDEX CONCURRENTLY IF EXISTS order_intents_action_scope_idx;

CREATE INDEX CONCURRENTLY order_intents_action_scope_idx
    ON order_intents (cluster, wallet_address, id)
    WHERE state IN (
        'preparing', 'prepared', 'activating', 'open', 'executing',
        'partially_filled', 'cancel_pending', 'expired'
    );
