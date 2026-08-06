-- Build the action-scoped active circuit lookup without blocking financial
-- writers. The lock-protocol migration refuses an invalid build.
-- stride: destructive-review=asset-action-circuit-index-recovery

SET lock_timeout = '5s';
SET statement_timeout = '10min';
SET idle_in_transaction_session_timeout = '60s';
SET search_path = public;

DROP INDEX CONCURRENTLY IF EXISTS asset_obligations_action_block_idx;

CREATE INDEX CONCURRENTLY asset_obligations_action_block_idx
    ON asset_obligations (action_id, opened_at, id)
    WHERE state IN ('open', 'review') AND blocks_actions AND action_id IS NOT NULL;
