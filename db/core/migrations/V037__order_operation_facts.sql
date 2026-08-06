-- Persist the legacy synchronous API's mutation identity before transport. A
-- started fact survives process death and database write failures, so an
-- expired lease cannot silently authorize a second provider mutation.
-- stride: destructive-review=order-operation-fact-guard

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';
SET LOCAL idle_in_transaction_session_timeout = '60s';
SET LOCAL search_path = public;

ALTER TABLE order_intents
    ADD COLUMN op_kind VARCHAR(20),
    ADD COLUMN op_state VARCHAR(12),
    ADD COLUMN op_req_hash CHAR(64),
    ADD COLUMN op_want_hash CHAR(64),
    ADD COLUMN op_detail JSONB,
    ADD COLUMN op_started_at TIMESTAMPTZ,
    ADD COLUMN unknown_at TIMESTAMPTZ,
    ADD COLUMN unknown_detail JSONB,
    ADD CONSTRAINT order_intents_op_kind_v2 CHECK (
        op_kind IS NULL OR op_kind IN (
            'prepare', 'activate', 'edit', 'cancel_init', 'cancel_confirm'
        )
    ) NOT VALID,
    ADD CONSTRAINT order_intents_op_state_v2 CHECK (
        op_state IS NULL OR op_state IN ('reserved', 'started')
    ) NOT VALID,
    ADD CONSTRAINT order_intents_op_req_v2 CHECK (
        op_req_hash IS NULL OR op_req_hash ~ '^[0-9a-f]{64}$'
    ) NOT VALID,
    ADD CONSTRAINT order_intents_op_want_v2 CHECK (
        op_want_hash IS NULL OR op_want_hash ~ '^[0-9a-f]{64}$'
    ) NOT VALID,
    ADD CONSTRAINT order_intents_op_detail_v2 CHECK (
        op_detail IS NULL OR (
            jsonb_typeof(op_detail) = 'object' AND pg_column_size(op_detail) <= 8192
        )
    ) NOT VALID,
    ADD CONSTRAINT order_intents_unknown_detail_v2 CHECK (
        unknown_detail IS NULL OR (
            jsonb_typeof(unknown_detail) = 'object'
            AND pg_column_size(unknown_detail) <= 8192
        )
    ) NOT VALID,
    ADD CONSTRAINT order_intents_op_shape_v2 CHECK (
        (op_state IS NULL AND op_kind IS NULL AND op_req_hash IS NULL
            AND op_want_hash IS NULL AND op_detail IS NULL AND op_started_at IS NULL)
        OR
        (op_state = 'reserved' AND op_kind IS NOT NULL AND op_req_hash IS NOT NULL
            AND op_want_hash IS NOT NULL AND op_detail IS NOT NULL AND op_started_at IS NULL)
        OR
        (op_state = 'started' AND op_kind IS NOT NULL AND op_req_hash IS NOT NULL
            AND op_want_hash IS NOT NULL AND op_detail IS NOT NULL AND op_started_at IS NOT NULL)
    ) NOT VALID;

ALTER TABLE order_intents
    VALIDATE CONSTRAINT order_intents_op_kind_v2;
ALTER TABLE order_intents
    VALIDATE CONSTRAINT order_intents_op_state_v2;
ALTER TABLE order_intents
    VALIDATE CONSTRAINT order_intents_op_req_v2;
ALTER TABLE order_intents
    VALIDATE CONSTRAINT order_intents_op_want_v2;
ALTER TABLE order_intents
    VALIDATE CONSTRAINT order_intents_op_detail_v2;
ALTER TABLE order_intents
    VALIDATE CONSTRAINT order_intents_unknown_detail_v2;
ALTER TABLE order_intents
    VALIDATE CONSTRAINT order_intents_op_shape_v2;

CREATE FUNCTION order_op_fact_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
    IF OLD.op_state = 'started' AND NEW.op_state = 'started' AND (
        NEW.op_kind IS DISTINCT FROM OLD.op_kind
        OR NEW.op_req_hash IS DISTINCT FROM OLD.op_req_hash
        OR NEW.op_want_hash IS DISTINCT FROM OLD.op_want_hash
        OR NEW.op_detail IS DISTINCT FROM OLD.op_detail
        OR NEW.op_started_at IS DISTINCT FROM OLD.op_started_at
    ) THEN
        RAISE EXCEPTION 'started provider mutation identity is immutable'
            USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER order_intents_op_fact_guard
    BEFORE UPDATE ON order_intents
    FOR EACH ROW EXECUTE FUNCTION order_op_fact_guard();

COMMENT ON COLUMN order_intents.op_state IS
    'Durable synchronous mutation phase; started blocks blind lease replay';
COMMENT ON COLUMN order_intents.op_detail IS
    'Canonical non-secret request evidence for provider reconciliation';
COMMENT ON COLUMN order_intents.unknown_detail IS
    'Non-secret provider response evidence recorded after an ambiguous effect';
COMMENT ON FUNCTION order_op_fact_guard() IS
    'Prevent replacement of a provider mutation after transport may have started';
