-- Preserve every provider-reported asset leg as an unresolved claim. Provider
-- history is evidence, never chain settlement; one semantic claim may span
-- multiple mints and is cleared by one independently confirmed journal.
-- stride: destructive-review=provider-money-claims-v46

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';
SET LOCAL idle_in_transaction_session_timeout = '60s';
SET LOCAL search_path = public;

CREATE TABLE asset_claim_parts (
    obligation_id UUID NOT NULL REFERENCES asset_obligations(id) ON DELETE RESTRICT,
    line_no SMALLINT NOT NULL CHECK (line_no BETWEEN 0 AND 7),
    role VARCHAR(12) NOT NULL CHECK (role IN ('input', 'output', 'fee', 'movement')),
    mint VARCHAR(64) NOT NULL CHECK (mint ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
    amount sol_u64 NOT NULL CHECK (amount > 0),
    evidence_id UUID NOT NULL UNIQUE REFERENCES asset_evidence(id) ON DELETE RESTRICT,
    part_hash CHAR(64) NOT NULL CHECK (part_hash ~ '^[0-9a-f]{64}$'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (obligation_id, line_no),
    UNIQUE (obligation_id, role, mint)
);

CREATE INDEX asset_claim_parts_mint_idx
    ON asset_claim_parts (mint, obligation_id);

CREATE FUNCTION asset_claim_part_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
    IF TG_OP <> 'INSERT' THEN
        RAISE EXCEPTION 'asset_claim_parts is append-only' USING ERRCODE = '55000';
    END IF;

    IF NOT EXISTS (
        SELECT 1
          FROM asset_obligations obligation
          JOIN asset_evidence evidence ON evidence.id = NEW.evidence_id
         WHERE obligation.id = NEW.obligation_id
           AND evidence.source = 'provider'
           AND evidence.journal_id IS NULL
           AND evidence.effect_key = (
               SELECT opening.effect_key
                 FROM asset_evidence opening
                WHERE opening.id = obligation.open_evidence_id
           )
           AND evidence.cluster = obligation.cluster
           AND evidence.wallet_address = obligation.wallet_address
           AND evidence.vault_address IS NOT DISTINCT FROM obligation.vault_address
           AND evidence.order_id IS NOT DISTINCT FROM obligation.order_id
           AND evidence.action_id IS NOT DISTINCT FROM obligation.action_id
           AND evidence.mint = NEW.mint
    ) THEN
        RAISE EXCEPTION 'claim part crosses its obligation or provider evidence boundary'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER asset_claim_parts_guard
    BEFORE INSERT OR UPDATE OR DELETE ON asset_claim_parts
    FOR EACH ROW EXECUTE FUNCTION asset_claim_part_guard();

CREATE FUNCTION asset_claim_check() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
    IF NEW.kind IN ('deposit_unknown', 'fill_unverified', 'withdraw_unknown')
       AND NEW.amount IS NOT NULL
       AND EXISTS (
           SELECT 1 FROM asset_evidence evidence
            WHERE evidence.id = NEW.open_evidence_id AND evidence.source = 'provider'
       )
       AND NOT EXISTS (
           SELECT 1 FROM asset_claim_parts part
            WHERE part.obligation_id = NEW.id
              AND part.mint = NEW.mint
              AND part.amount = NEW.amount
              AND part.evidence_id = NEW.open_evidence_id
       ) THEN
        RAISE EXCEPTION 'provider money obligation lacks its exact primary claim part'
            USING ERRCODE = '23514';
    END IF;
    RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER asset_claim_complete
    AFTER INSERT ON asset_obligations
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION asset_claim_check();

DROP VIEW asset_circuits;

CREATE VIEW asset_circuits AS
SELECT obligation.id AS obligation_id, obligation.order_id, obligation.action_id,
       obligation.cluster, obligation.wallet_address, obligation.vault_address,
       obligation.mint, obligation.kind, obligation.state, obligation.amount,
       obligation.reason, obligation.opened_at
  FROM asset_obligations obligation
 WHERE obligation.state IN ('open', 'review') AND obligation.blocks_actions = TRUE
UNION ALL
SELECT obligation.id, obligation.order_id, obligation.action_id,
       obligation.cluster, obligation.wallet_address, obligation.vault_address,
       part.mint, obligation.kind, obligation.state, part.amount,
       obligation.reason, obligation.opened_at
  FROM asset_obligations obligation
 JOIN asset_claim_parts part ON part.obligation_id = obligation.id
 WHERE obligation.state IN ('open', 'review') AND obligation.blocks_actions = TRUE
   AND part.mint <> obligation.mint;

COMMENT ON TABLE asset_claim_parts IS
    'Exact provider-reported legs of one unresolved semantic asset claim';
