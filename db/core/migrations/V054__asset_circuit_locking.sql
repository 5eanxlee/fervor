-- Circuit openings and financial action decisions share the order aggregate
-- lock. If the opening commits first, admission/start observes it; if the
-- action commits first, the circuit becomes authoritative immediately after.
-- stride: destructive-review=asset-circuit-lock-trigger

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';
SET LOCAL idle_in_transaction_session_timeout = '60s';
SET LOCAL search_path = public;

DO $$
DECLARE
    required_name TEXT;
BEGIN
    FOREACH required_name IN ARRAY ARRAY[
        'asset_obligations_order_block_idx',
        'asset_obligations_action_block_idx',
        'asset_obligations_scope_block_idx',
        'order_intents_action_scope_idx'
    ] LOOP
        IF NOT EXISTS (
            SELECT 1
              FROM pg_class relation
              JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
              JOIN pg_index index_row ON index_row.indexrelid = relation.oid
             WHERE namespace.nspname = 'public'
               AND relation.relname = required_name
               AND index_row.indisvalid
               AND index_row.indisready
        ) THEN
            RAISE EXCEPTION 'asset circuit locking requires valid index %', required_name;
        END IF;
    END LOOP;
END;
$$;

CREATE FUNCTION asset_scope_lock(target_cluster TEXT, target_wallet TEXT) RETURNS VOID
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp AS $$
BEGIN
    IF pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
        RAISE EXCEPTION 'asset scope writes require read committed isolation'
            USING ERRCODE = '25001';
    END IF;
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
        target_cluster || pg_catalog.chr(31) || target_wallet,
        15485863
    ));
END;
$$;

CREATE FUNCTION asset_scope_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
    IF coalesce(pg_catalog.to_jsonb(NEW)->>'source', 'provider') <> 'provider' THEN
        RETURN NEW;
    END IF;
    PERFORM public.asset_scope_lock(coalesce(NEW.cluster, 'unscoped'), NEW.wallet_address);
    RETURN NEW;
END;
$$;

CREATE TRIGGER order_intents_scope_lock
    BEFORE INSERT ON order_intents
    FOR EACH ROW EXECUTE FUNCTION asset_scope_guard();

CREATE TRIGGER asset_evidence_scope_lock
    BEFORE INSERT ON asset_evidence
    FOR EACH ROW EXECUTE FUNCTION asset_scope_guard();

CREATE FUNCTION asset_circuit_lock() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
    IF NEW.action_id IS NOT NULL AND NOT EXISTS (
        SELECT 1
          FROM order_actions action
          JOIN order_intents order_row ON order_row.id = action.order_id
         WHERE action.id = NEW.action_id
           AND (NEW.order_id IS NULL OR NEW.order_id = order_row.id)
           AND NEW.cluster = order_row.cluster
           AND NEW.wallet_address = order_row.wallet_address
    ) THEN
        RAISE EXCEPTION 'asset obligation action crosses its order or wallet boundary'
            USING ERRCODE = '23514';
    END IF;

    IF NOT NEW.blocks_actions OR NEW.state NOT IN ('open', 'review') THEN
        RETURN NEW;
    END IF;

    PERFORM public.asset_scope_lock(NEW.cluster, NEW.wallet_address);
    IF NEW.claim_ver IS NOT NULL THEN
        RETURN NEW;
    END IF;

    PERFORM 1
      FROM order_intents order_row
     WHERE order_row.id = NEW.order_id
        OR order_row.id = (
            SELECT action.order_id FROM order_actions action WHERE action.id = NEW.action_id
        )
        OR (
            order_row.cluster = NEW.cluster
            AND order_row.wallet_address = NEW.wallet_address
            AND NEW.mint IN (order_row.input_mint, order_row.output_mint)
        )
     ORDER BY order_row.id
     FOR UPDATE OF order_row;
    RETURN NEW;
END;
$$;

CREATE TRIGGER asset_obligations_circuit_lock
    BEFORE INSERT ON asset_obligations
    FOR EACH ROW EXECUTE FUNCTION asset_circuit_lock();

COMMENT ON FUNCTION asset_circuit_lock() IS
    'Linearizes blocking obligation openings with financial action admission and dispatch';
COMMENT ON FUNCTION asset_scope_lock(TEXT, TEXT) IS
    'Serializes blocking wallet scopes, provider evidence, and new order identities under read committed isolation';
