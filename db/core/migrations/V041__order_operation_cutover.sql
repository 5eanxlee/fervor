-- Install an explicit, fail-closed writer barrier. This is intentionally a
-- drained cutover rather than a rolling-compatible mutation change: V037-aware
-- and older binaries cannot originate or take over work after this commits.
-- stride: destructive-review=order-operation-writer-cutover

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';
SET LOCAL idle_in_transaction_session_timeout = '60s';
SET LOCAL search_path = public;

ALTER TABLE order_intents
    ADD COLUMN op_writer SMALLINT,
    ADD COLUMN op_ver BIGINT NOT NULL DEFAULT 0;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
          FROM pg_class relation
          JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
          JOIN pg_index index_row ON index_row.indexrelid = relation.oid
         WHERE namespace.nspname = 'public'
           AND relation.relname = 'order_intents_op_cutover_idx'
           AND index_row.indisvalid
           AND index_row.indisready
    ) THEN
        RAISE EXCEPTION 'operation writer cutover requires its valid audit index';
    END IF;
    IF EXISTS (
        SELECT 1
          FROM order_intents
         WHERE op_token IS NOT NULL
            OR op_lease_until IS NOT NULL
            OR op_state IS NOT NULL
            OR error_code = 'provider_outcome_unknown'
         LIMIT 1
    ) THEN
        RAISE EXCEPTION
            'operation writer cutover requires drained prior writers and reconciled legacy operations';
    END IF;
END;
$$;

ALTER TABLE order_intents
    DROP CONSTRAINT order_intents_op_shape_v2,
    ADD CONSTRAINT order_intents_op_shape_v3 CHECK ((
        (
            op_state IS NULL
            AND op_kind IS NULL
            AND op_req_hash IS NULL
            AND op_want_hash IS NULL
            AND op_detail IS NULL
            AND op_started_at IS NULL
            AND op_token IS NULL
            AND op_lease_until IS NULL
            AND op_writer IS NULL
            AND op_ver = 0
            AND unknown_at IS NULL
            AND unknown_detail IS NULL
            AND error_code IS DISTINCT FROM 'provider_outcome_unknown'
        ) OR (
            op_state = 'reserved'
            AND op_kind IS NOT NULL
            AND op_req_hash IS NOT NULL
            AND op_want_hash IS NOT NULL
            AND op_detail IS NOT NULL
            AND op_started_at IS NULL
            AND op_token IS NOT NULL
            AND op_lease_until IS NOT NULL
            AND op_writer = 2
            AND op_ver > 0
            AND unknown_at IS NULL
            AND unknown_detail IS NULL
            AND error_code IS DISTINCT FROM 'provider_outcome_unknown'
        ) OR (
            op_state = 'started'
            AND op_kind IS NOT NULL
            AND op_req_hash IS NOT NULL
            AND op_want_hash IS NOT NULL
            AND op_detail IS NOT NULL
            AND op_started_at IS NOT NULL
            AND op_token IS NOT NULL
            AND op_lease_until IS NOT NULL
            AND op_writer = 2
            AND op_ver > 0
            AND unknown_at IS NULL
            AND unknown_detail IS NULL
            AND error_code IS DISTINCT FROM 'provider_outcome_unknown'
        ) OR (
            op_state = 'started'
            AND op_kind IS NOT NULL
            AND op_req_hash IS NOT NULL
            AND op_want_hash IS NOT NULL
            AND op_detail IS NOT NULL
            AND op_started_at IS NOT NULL
            AND op_token IS NULL
            AND op_lease_until IS NULL
            AND op_writer = 2
            AND op_ver > 0
            AND unknown_at IS NOT NULL
            AND unknown_detail IS NOT NULL
            AND error_code = 'provider_outcome_unknown'
        )
    ) IS TRUE) NOT VALID;

CREATE OR REPLACE FUNCTION order_op_fact_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        RETURN NEW;
    END IF;

    IF OLD.op_state = 'started' THEN
        IF NEW.op_state = 'reserved' THEN
            RAISE EXCEPTION 'started provider mutation cannot return to reserved'
                USING ERRCODE = '55000';
        END IF;
        IF NEW.op_state = 'started' AND (
            NEW.op_kind IS DISTINCT FROM OLD.op_kind
            OR NEW.op_req_hash IS DISTINCT FROM OLD.op_req_hash
            OR NEW.op_want_hash IS DISTINCT FROM OLD.op_want_hash
            OR NEW.op_detail IS DISTINCT FROM OLD.op_detail
            OR NEW.op_started_at IS DISTINCT FROM OLD.op_started_at
            OR NEW.op_writer IS DISTINCT FROM OLD.op_writer
        ) THEN
            RAISE EXCEPTION 'started provider mutation identity is immutable'
                USING ERRCODE = '55000';
        END IF;
        IF NEW.op_state = 'started' THEN
            IF (NEW.op_token IS DISTINCT FROM OLD.op_token
                OR NEW.op_lease_until IS DISTINCT FROM OLD.op_lease_until) THEN
                IF NEW.op_ver IS DISTINCT FROM OLD.op_ver + 1 THEN
                    RAISE EXCEPTION 'started provider mutation lease change requires a new writer version'
                        USING ERRCODE = '55000';
                END IF;
            ELSIF NEW.op_ver IS DISTINCT FROM OLD.op_ver THEN
                RAISE EXCEPTION 'provider mutation version cannot advance without a lease change'
                    USING ERRCODE = '55000';
            END IF;
        ELSIF NEW.op_state IS NULL
            AND (NEW.op_writer IS NOT NULL OR NEW.op_ver <> 0) THEN
            RAISE EXCEPTION 'started provider mutation must clear its writer identity atomically'
                USING ERRCODE = '55000';
        END IF;
        RETURN NEW;
    END IF;

    IF OLD.op_state = 'reserved' AND NEW.op_state = 'started' THEN
        IF NEW.op_kind IS DISTINCT FROM OLD.op_kind
            OR NEW.op_req_hash IS DISTINCT FROM OLD.op_req_hash
            OR NEW.op_want_hash IS DISTINCT FROM OLD.op_want_hash
            OR NEW.op_detail IS DISTINCT FROM OLD.op_detail
            OR NEW.op_token IS DISTINCT FROM OLD.op_token
            OR NEW.op_lease_until IS DISTINCT FROM OLD.op_lease_until
            OR NEW.op_writer IS DISTINCT FROM OLD.op_writer
            OR NEW.op_ver IS DISTINCT FROM OLD.op_ver
            OR NEW.op_started_at IS NULL THEN
            RAISE EXCEPTION 'provider mutation start must preserve its reserved identity'
                USING ERRCODE = '55000';
        END IF;
        RETURN NEW;
    END IF;

    IF NEW.op_state = 'reserved' THEN
        IF NEW.op_writer <> 2 OR NEW.op_ver IS DISTINCT FROM OLD.op_ver + 1 THEN
            RAISE EXCEPTION 'provider mutation reservation requires writer version 2'
                USING ERRCODE = '55000';
        END IF;
    ELSIF OLD.op_state = 'reserved' AND NEW.op_state IS NULL
        AND (NEW.op_writer IS NOT NULL OR NEW.op_ver <> 0) THEN
        RAISE EXCEPTION 'reserved provider mutation must clear its writer identity atomically'
            USING ERRCODE = '55000';
    ELSIF OLD.op_state IS NULL AND NEW.op_state = 'started' THEN
        RAISE EXCEPTION 'provider mutation cannot skip its durable reservation'
            USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER order_intents_op_fact_guard ON order_intents;
CREATE TRIGGER order_intents_op_fact_guard
    BEFORE INSERT OR UPDATE ON order_intents
    FOR EACH ROW EXECUTE FUNCTION order_op_fact_guard();

COMMENT ON COLUMN order_intents.op_writer IS
    'Mutation writer contract; version 2 is mandatory after the drained cutover';
COMMENT ON COLUMN order_intents.op_ver IS
    'Monotonic reservation/lease generation, reset only with the complete operation fact';
COMMENT ON FUNCTION order_op_fact_guard() IS
    'Reject prior writers, lease takeover without a new generation, and started-fact downgrade';
