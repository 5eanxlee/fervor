-- A signed execution with a durable broadcast marker remains reconcilable after
-- a worker dies between provider acceptance and acknowledgement persistence.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';
SET LOCAL idle_in_transaction_session_timeout = '60s';
SET LOCAL search_path = public;

ALTER TABLE trade_executions
    ADD COLUMN broadcast_started_at TIMESTAMPTZ,
    ADD COLUMN broadcast_count INTEGER NOT NULL DEFAULT 0,
    ADD CONSTRAINT trade_exec_broadcast_count CHECK (broadcast_count >= 0) NOT VALID,
    ADD CONSTRAINT trade_exec_broadcast_shape CHECK (
        (broadcast_count = 0 AND broadcast_started_at IS NULL)
        OR (broadcast_count > 0 AND broadcast_started_at IS NOT NULL)
    ) NOT VALID;

ALTER TABLE trade_executions VALIDATE CONSTRAINT trade_exec_broadcast_count;
ALTER TABLE trade_executions VALIDATE CONSTRAINT trade_exec_broadcast_shape;

CREATE INDEX trade_exec_recovery_idx
    ON trade_executions (updated_at, id)
    WHERE state = 'signed' AND signature IS NOT NULL AND broadcast_started_at IS NOT NULL;

COMMENT ON COLUMN trade_executions.broadcast_started_at IS
    'First durable possible-broadcast boundary; not proof that bytes reached the provider';
