-- Build the small cutover/audit set before the writer-version barrier. The
-- following migration uses it to fail quickly if any prior binary still owns
-- or may have emitted a provider mutation.
-- stride: destructive-review=order-operation-cutover-index

SET lock_timeout = '5s';
SET statement_timeout = '10min';
SET idle_in_transaction_session_timeout = '60s';
SET search_path = public;

DROP INDEX CONCURRENTLY IF EXISTS order_intents_op_cutover_idx;

CREATE INDEX CONCURRENTLY order_intents_op_cutover_idx
    ON order_intents (id)
    WHERE op_token IS NOT NULL
       OR op_lease_until IS NOT NULL
       OR op_state IS NOT NULL
       OR error_code = 'provider_outcome_unknown';
