-- Build the exact provider-claim hot-path index without blocking order-control
-- plane writers. Each nontransactional migration owns one recoverable artifact.
-- stride: destructive-review=action-provider-due-index-v24

SET lock_timeout = '5s';
SET statement_timeout = '7min';
SET idle_in_transaction_session_timeout = '60s';
SET search_path = public;

DROP INDEX CONCURRENTLY IF EXISTS order_actions_provider_due_idx;
CREATE INDEX CONCURRENTLY order_actions_provider_due_idx
    ON order_actions (provider, due_at, id)
    WHERE work_state IN ('queued', 'ready', 'reconciling')
      AND outcome = 'pending'
      AND block_reason IS NULL;
