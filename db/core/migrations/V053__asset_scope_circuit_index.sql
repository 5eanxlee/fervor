-- Build the wallet/mint active circuit lookup without blocking financial
-- writers. The lock-protocol migration refuses an invalid build.
-- stride: destructive-review=asset-scope-circuit-index-recovery

SET lock_timeout = '5s';
SET statement_timeout = '10min';
SET idle_in_transaction_session_timeout = '60s';
SET search_path = public;

DROP INDEX CONCURRENTLY IF EXISTS asset_obligations_scope_block_idx;

CREATE INDEX CONCURRENTLY asset_obligations_scope_block_idx
    ON asset_obligations (cluster, wallet_address, mint, opened_at, id)
    WHERE state IN ('open', 'review') AND blocks_actions;
