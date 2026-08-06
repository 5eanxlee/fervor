-- A multi-mint provider claim must join every direct or financially actionable
-- matching order aggregate before commit. Deferred claim validation sees the
-- complete immutable part set, so reciprocal fills acquire those aggregates
-- in one deterministic order without locking inactive terminal history.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';
SET LOCAL idle_in_transaction_session_timeout = '60s';
SET LOCAL search_path = public;

DO $$
DECLARE
    invalid_id UUID;
BEGIN
    SELECT obligation.id INTO invalid_id
      FROM asset_obligations obligation
     WHERE obligation.action_id IS NOT NULL
       AND NOT EXISTS (
           SELECT 1
             FROM order_actions action
             JOIN order_intents order_row ON order_row.id = action.order_id
            WHERE action.id = obligation.action_id
              AND (obligation.order_id IS NULL OR obligation.order_id = order_row.id)
              AND obligation.cluster = order_row.cluster
              AND obligation.wallet_address = order_row.wallet_address
       )
     ORDER BY obligation.id
     LIMIT 1;
    IF invalid_id IS NOT NULL THEN
        RAISE EXCEPTION 'asset circuit upgrade found crossed or dangling action identity %', invalid_id
            USING ERRCODE = '23514';
    END IF;
END;
$$;

ALTER TABLE asset_obligations
    ADD CONSTRAINT asset_obligations_action_fk
    FOREIGN KEY (action_id) REFERENCES order_actions(id) ON DELETE RESTRICT
    NOT VALID;

CREATE FUNCTION asset_lock_claim_scope(target UUID) RETURNS VOID
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
    obligation asset_obligations%ROWTYPE;
    claim_mints TEXT[];
BEGIN
    SELECT * INTO obligation
      FROM asset_obligations stored
     WHERE stored.id = target;
    IF NOT FOUND OR obligation.claim_ver IS NULL
        OR NOT obligation.blocks_actions
        OR obligation.state NOT IN ('open', 'review') THEN
        RETURN;
    END IF;

    PERFORM public.asset_scope_lock(obligation.cluster, obligation.wallet_address);

    SELECT array_agg(claim_mint.mint ORDER BY claim_mint.mint)
      INTO claim_mints
      FROM (
          SELECT obligation.mint
          UNION
          SELECT part.mint
            FROM asset_claim_parts part
           WHERE part.obligation_id = obligation.id
      ) claim_mint;

    PERFORM 1
      FROM order_intents order_row
      JOIN (
          SELECT direct.id
            FROM order_intents direct
           WHERE direct.id = obligation.order_id
          UNION
          SELECT action.order_id
            FROM order_actions action
           WHERE action.id = obligation.action_id
          UNION
          SELECT scoped.id
            FROM order_intents scoped
           WHERE scoped.cluster = obligation.cluster
             AND scoped.wallet_address = obligation.wallet_address
             AND scoped.state IN (
                 'preparing', 'prepared', 'activating', 'open', 'executing',
                 'partially_filled', 'cancel_pending', 'expired'
             )
             AND (scoped.input_mint = ANY(claim_mints)
               OR scoped.output_mint = ANY(claim_mints))
          UNION
          SELECT action.order_id
            FROM order_actions action
            JOIN order_intents scoped ON scoped.id = action.order_id
           WHERE action.work_state <> 'done'
             AND action.kind NOT IN ('provider_sync', 'chain_sync')
             AND scoped.cluster = obligation.cluster
             AND scoped.wallet_address = obligation.wallet_address
             AND (scoped.input_mint = ANY(claim_mints)
               OR scoped.output_mint = ANY(claim_mints))
      ) candidate ON candidate.id = order_row.id
     ORDER BY order_row.id
     FOR UPDATE OF order_row;
END;
$$;

CREATE OR REPLACE FUNCTION asset_claim_check() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
    PERFORM asset_lock_claim_scope(NEW.id);
    PERFORM asset_assert_claim(NEW.id);
    RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION asset_claim_part_check() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
    PERFORM asset_assert_claim(NEW.obligation_id);
    RETURN NULL;
END;
$$;

COMMENT ON FUNCTION asset_lock_claim_scope(UUID) IS
    'Locks direct and financially actionable aggregates intersecting a complete blocking provider claim';
