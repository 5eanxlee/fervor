-- Repeat the operation cutover under a delete-safe barrier, prove the exact
-- audit index shape, and make operation generations lifetime-monotonic.
-- This is a drained, non-rolling cutover from writer contract 2/V041.
-- stride: destructive-review=operation-replay-safety

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';
SET LOCAL idle_in_transaction_session_timeout = '60s';
SET LOCAL search_path = public;

LOCK TABLE order_intents IN ACCESS EXCLUSIVE MODE;

CREATE OR REPLACE FUNCTION order_op_fact_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF OLD.op_state IS NOT NULL
            OR OLD.op_token IS NOT NULL
            OR OLD.op_lease_until IS NOT NULL
            OR OLD.error_code = 'provider_outcome_unknown' THEN
            RAISE EXCEPTION 'active provider mutation fact cannot be deleted'
                USING ERRCODE = '55000';
        END IF;
        RETURN OLD;
    END IF;
    IF TG_OP = 'INSERT' THEN
        RETURN NEW;
    END IF;

    IF OLD.error_code = 'provider_outcome_unknown' AND NEW.op_state = 'started' AND (
        NEW.op_kind IS DISTINCT FROM OLD.op_kind
        OR NEW.op_req_hash IS DISTINCT FROM OLD.op_req_hash
        OR NEW.op_want_hash IS DISTINCT FROM OLD.op_want_hash
        OR NEW.op_detail IS DISTINCT FROM OLD.op_detail
        OR NEW.op_started_at IS DISTINCT FROM OLD.op_started_at
        OR NEW.op_token IS DISTINCT FROM OLD.op_token
        OR NEW.op_lease_until IS DISTINCT FROM OLD.op_lease_until
        OR NEW.op_writer IS DISTINCT FROM OLD.op_writer
        OR NEW.op_ver IS DISTINCT FROM OLD.op_ver
        OR NEW.unknown_at IS DISTINCT FROM OLD.unknown_at
        OR NEW.unknown_detail IS DISTINCT FROM OLD.unknown_detail
        OR NEW.error_code IS DISTINCT FROM OLD.error_code
    ) THEN
        RAISE EXCEPTION 'unknown provider mutation fact is immutable until resolution'
            USING ERRCODE = '55000';
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
            IF NEW.op_token IS DISTINCT FROM OLD.op_token
                OR NEW.op_lease_until IS DISTINCT FROM OLD.op_lease_until THEN
                IF NEW.op_ver IS DISTINCT FROM OLD.op_ver + 1 THEN
                    RAISE EXCEPTION 'started provider mutation lease change requires a new writer version'
                        USING ERRCODE = '55000';
                END IF;
            ELSIF NEW.op_ver IS DISTINCT FROM OLD.op_ver THEN
                RAISE EXCEPTION 'provider mutation version cannot advance without a lease change'
                    USING ERRCODE = '55000';
            END IF;
        ELSIF NEW.op_state IS NULL AND (
            NEW.op_writer IS NOT NULL OR NEW.op_ver IS DISTINCT FROM OLD.op_ver
        ) THEN
            RAISE EXCEPTION 'started provider mutation must preserve its lifetime generation when cleared'
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
    ELSIF OLD.op_state = 'reserved' AND NEW.op_state IS NULL THEN
        IF NEW.op_writer IS NOT NULL OR NEW.op_ver IS DISTINCT FROM OLD.op_ver THEN
            RAISE EXCEPTION 'reserved provider mutation must preserve its lifetime generation when cleared'
                USING ERRCODE = '55000';
        END IF;
    ELSIF OLD.op_state IS NULL AND NEW.op_state = 'started' THEN
        RAISE EXCEPTION 'provider mutation cannot skip its durable reservation'
            USING ERRCODE = '55000';
    ELSIF OLD.op_state IS NULL AND NEW.op_state IS NULL
        AND NEW.op_ver IS DISTINCT FROM OLD.op_ver THEN
        RAISE EXCEPTION 'provider mutation generation cannot change outside a fact transition'
            USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER order_intents_op_fact_guard ON order_intents;
CREATE TRIGGER order_intents_op_fact_guard
    BEFORE INSERT OR UPDATE OR DELETE ON order_intents
    FOR EACH ROW EXECUTE FUNCTION order_op_fact_guard();

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
          FROM pg_class relation
          JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
          JOIN pg_index index_row ON index_row.indexrelid = relation.oid
         WHERE namespace.nspname = 'public'
           AND relation.relname = 'order_intents_op_cutover_idx'
           AND index_row.indrelid = 'public.order_intents'::regclass
           AND index_row.indisvalid
           AND index_row.indisready
           AND NOT index_row.indisunique
           AND NOT index_row.indisprimary
           AND NOT index_row.indisexclusion
           AND index_row.indnkeyatts = 1
           AND index_row.indnatts = 1
           AND index_row.indexprs IS NULL
           AND pg_get_indexdef(index_row.indexrelid, 1, true) = 'id'
           AND pg_get_expr(index_row.indpred, index_row.indrelid, true) =
               'op_token IS NOT NULL OR op_lease_until IS NOT NULL OR op_state IS NOT NULL OR error_code::text = ''provider_outcome_unknown''::text'
    ) THEN
        RAISE EXCEPTION 'operation replay cutover requires its exact audit index';
    END IF;
END;
$$;

SET LOCAL enable_seqscan = off;
SET LOCAL enable_bitmapscan = off;
SET LOCAL enable_indexscan = on;
SET LOCAL enable_indexonlyscan = on;

DO $$
BEGIN
    IF EXISTS (
        SELECT id
          FROM order_intents
         WHERE op_token IS NOT NULL
            OR op_lease_until IS NOT NULL
            OR op_state IS NOT NULL
            OR error_code = 'provider_outcome_unknown'
         LIMIT 1
    ) THEN
        RAISE EXCEPTION
            'operation replay cutover requires drained writers and reconciled unknown outcomes';
    END IF;
END;
$$;

ALTER TABLE order_intents
    DROP CONSTRAINT order_intents_op_shape_v3,
    ADD CONSTRAINT order_intents_op_shape_v4 CHECK ((
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
            AND op_ver >= 0
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

COMMENT ON COLUMN order_intents.op_ver IS
    'Lifetime-monotonic provider-operation generation; never reset after a completed fact';
COMMENT ON FUNCTION order_op_fact_guard() IS
    'Protect provider-operation identity, lifetime generation, and active facts from deletion';
