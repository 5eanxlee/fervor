-- Build the complete hot-set index without blocking execution writes on a
-- populated production table. This migration is intentionally non-transactional.

SET lock_timeout = '5s';
SET statement_timeout = '30min';
SET idle_in_transaction_session_timeout = '60s';
SET search_path = public;

CREATE INDEX CONCURRENTLY trade_exec_reconcile_due_idx
    ON trade_executions (updated_at, id)
    WHERE signature IS NOT NULL
      AND (state IN ('submitted', 'processed', 'confirmed')
           OR (state = 'signed' AND broadcast_started_at IS NOT NULL));
