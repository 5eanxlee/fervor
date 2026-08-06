-- Separate immutable Jupiter acknowledgement amounts from independently
-- observed Solana settlement. Existing provider-only "actual" values are
-- preserved under provider columns, then hidden from the settled projection.
-- stride: destructive-review=execution-settlement-cutover-v60

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';
SET LOCAL idle_in_transaction_session_timeout = '60s';
SET LOCAL search_path = public;

LOCK TABLE trade_executions IN SHARE ROW EXCLUSIVE MODE;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
          FROM trade_executions
         WHERE provider = 'jupiter_swap_v2'
           AND (op_token IS NOT NULL OR op_lease_until IS NOT NULL)
    ) THEN
        RAISE EXCEPTION 'execution settlement cutover requires drained Jupiter claims'
            USING ERRCODE = '55000';
    END IF;
    IF EXISTS (
        SELECT 1
          FROM trade_executions
         WHERE num_nonnulls(actual_input_amount, actual_output_amount) = 1
    ) THEN
        RAISE EXCEPTION 'execution settlement cutover found a partial provider amount pair'
            USING ERRCODE = '23514';
    END IF;
END;
$$;

ALTER TABLE trade_executions
    ADD COLUMN provider_input_amount sol_u64,
    ADD COLUMN provider_output_amount sol_u64,
    ADD COLUMN settlement_status VARCHAR(16) NOT NULL DEFAULT 'pending',
    ADD COLUMN settlement_slot BIGINT,
    ADD COLUMN settlement_commitment VARCHAR(10),
    ADD COLUMN settlement_fee_lamports sol_u64;

UPDATE trade_executions
   SET provider_input_amount = actual_input_amount,
       provider_output_amount = actual_output_amount,
       actual_input_amount = NULL,
       actual_output_amount = NULL,
       state = CASE
           WHEN provider = 'jupiter_swap_v2' AND state IN ('confirmed', 'finalized')
               THEN 'submitted'
           ELSE state
       END,
       confirmed_at = CASE
           WHEN provider = 'jupiter_swap_v2' AND state IN ('confirmed', 'finalized')
               THEN NULL
           ELSE confirmed_at
       END
 WHERE actual_input_amount IS NOT NULL
    OR (provider = 'jupiter_swap_v2' AND state IN ('confirmed', 'finalized'));

ALTER TABLE trade_executions
    ADD CONSTRAINT trade_exec_provider_amount_shape CHECK (
        num_nonnulls(provider_input_amount, provider_output_amount) IN (0, 2)
    ),
    ADD CONSTRAINT trade_exec_settlement_status CHECK (
        settlement_status IN ('pending', 'verified', 'mismatch', 'unsupported')
    ),
    ADD CONSTRAINT trade_exec_settlement_commitment CHECK (
        settlement_commitment IS NULL
        OR settlement_commitment IN ('confirmed', 'finalized')
    ),
    ADD CONSTRAINT trade_exec_settlement_slot CHECK (
        settlement_slot IS NULL OR settlement_slot BETWEEN 0 AND 9007199254740991
    ),
    ADD CONSTRAINT trade_exec_settlement_shape CHECK (
        (
            settlement_status = 'pending'
            AND num_nonnulls(
                actual_input_amount, actual_output_amount, settlement_slot,
                settlement_commitment, settlement_fee_lamports
            ) = 0
        )
        OR
        (
            settlement_status = 'unsupported'
            AND actual_input_amount IS NULL
            AND actual_output_amount IS NULL
            AND settlement_slot IS NOT NULL
            AND settlement_commitment IS NOT NULL
            AND settlement_fee_lamports IS NOT NULL
        )
        OR
        (
            settlement_status IN ('verified', 'mismatch')
            AND actual_input_amount IS NOT NULL
            AND actual_output_amount IS NOT NULL
            AND settlement_slot IS NOT NULL
            AND settlement_commitment IS NOT NULL
            AND settlement_fee_lamports IS NOT NULL
        )
    );

CREATE TABLE execution_settlements (
    execution_id UUID NOT NULL REFERENCES trade_executions(id) ON DELETE RESTRICT,
    signature VARCHAR(128) NOT NULL
        CHECK (signature ~ '^[1-9A-HJ-NP-Za-km-z]{64,88}$'),
    commitment VARCHAR(10) NOT NULL CHECK (commitment IN ('confirmed', 'finalized')),
    slot BIGINT NOT NULL CHECK (slot BETWEEN 0 AND 9007199254740991),
    status VARCHAR(16) NOT NULL CHECK (status IN ('verified', 'mismatch', 'unsupported')),
    input_amount sol_u64,
    output_amount sol_u64,
    fee_lamports sol_u64 NOT NULL,
    provider_input_amount sol_u64,
    provider_output_amount sol_u64,
    payload_hash CHAR(64) NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
    reason VARCHAR(500),
    observed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (execution_id, commitment),
    UNIQUE (signature, commitment),
    CHECK (num_nonnulls(provider_input_amount, provider_output_amount) IN (0, 2)),
    CHECK (
        (status = 'unsupported' AND input_amount IS NULL AND output_amount IS NULL)
        OR
        (status IN ('verified', 'mismatch')
            AND input_amount IS NOT NULL AND output_amount IS NOT NULL)
    ),
    CHECK ((status = 'verified' AND reason IS NULL)
        OR (status <> 'verified' AND reason IS NOT NULL))
);

CREATE FUNCTION execution_settlement_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
    execution_row trade_executions%ROWTYPE;
    confirmed_row execution_settlements%ROWTYPE;
BEGIN
    IF TG_OP <> 'INSERT' THEN
        RAISE EXCEPTION 'execution settlement evidence is append-only' USING ERRCODE = '55000';
    END IF;

    SELECT * INTO execution_row
      FROM trade_executions stored
     WHERE stored.id = NEW.execution_id
     FOR UPDATE;
    IF NOT FOUND
        OR execution_row.signature IS DISTINCT FROM NEW.signature
        OR execution_row.provider_input_amount IS DISTINCT FROM NEW.provider_input_amount
        OR execution_row.provider_output_amount IS DISTINCT FROM NEW.provider_output_amount THEN
        RAISE EXCEPTION 'execution settlement does not match its execution identity'
            USING ERRCODE = '23514';
    END IF;

    IF NEW.commitment = 'confirmed' AND EXISTS (
        SELECT 1 FROM execution_settlements settled
         WHERE settled.execution_id = NEW.execution_id
           AND settled.commitment = 'finalized'
    ) THEN
        RAISE EXCEPTION 'execution settlement commitment cannot regress'
            USING ERRCODE = '23514';
    END IF;

    IF NEW.commitment = 'finalized' THEN
        SELECT * INTO confirmed_row
          FROM execution_settlements settled
         WHERE settled.execution_id = NEW.execution_id
           AND settled.commitment = 'confirmed';
        IF FOUND AND (
            confirmed_row.signature <> NEW.signature
            OR confirmed_row.slot <> NEW.slot
            OR confirmed_row.status <> NEW.status
            OR confirmed_row.input_amount IS DISTINCT FROM NEW.input_amount
            OR confirmed_row.output_amount IS DISTINCT FROM NEW.output_amount
            OR confirmed_row.fee_lamports <> NEW.fee_lamports
            OR confirmed_row.provider_input_amount IS DISTINCT FROM NEW.provider_input_amount
            OR confirmed_row.provider_output_amount IS DISTINCT FROM NEW.provider_output_amount
            OR confirmed_row.reason IS DISTINCT FROM NEW.reason
        ) THEN
            RAISE EXCEPTION 'finalized execution settlement differs from confirmed evidence'
                USING ERRCODE = '23514';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER execution_settlements_guard
    BEFORE INSERT OR UPDATE OR DELETE ON execution_settlements
    FOR EACH ROW EXECUTE FUNCTION execution_settlement_guard();

CREATE FUNCTION execution_amount_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
    settlement_changed BOOLEAN;
BEGIN
    IF OLD.signature IS NOT NULL
        AND NEW.signature IS DISTINCT FROM OLD.signature THEN
        RAISE EXCEPTION 'execution signature is immutable once observed'
            USING ERRCODE = '55000';
    END IF;

    IF num_nonnulls(NEW.provider_input_amount, NEW.provider_output_amount) NOT IN (0, 2) THEN
        RAISE EXCEPTION 'provider settlement amounts must be written as one pair'
            USING ERRCODE = '23514';
    END IF;
    IF (
        NEW.provider_input_amount IS DISTINCT FROM OLD.provider_input_amount
        OR NEW.provider_output_amount IS DISTINCT FROM OLD.provider_output_amount
    ) AND (
        OLD.provider_input_amount IS NOT NULL
        OR OLD.provider_output_amount IS NOT NULL
        OR EXISTS (
            SELECT 1 FROM execution_settlements settled
             WHERE settled.execution_id = OLD.id
        )
    ) THEN
        RAISE EXCEPTION 'provider settlement amounts are immutable' USING ERRCODE = '55000';
    END IF;

    settlement_changed := NEW.actual_input_amount IS DISTINCT FROM OLD.actual_input_amount
        OR NEW.actual_output_amount IS DISTINCT FROM OLD.actual_output_amount
        OR NEW.settlement_status IS DISTINCT FROM OLD.settlement_status
        OR NEW.settlement_slot IS DISTINCT FROM OLD.settlement_slot
        OR NEW.settlement_commitment IS DISTINCT FROM OLD.settlement_commitment
        OR NEW.settlement_fee_lamports IS DISTINCT FROM OLD.settlement_fee_lamports;

    IF settlement_changed AND NOT EXISTS (
        SELECT 1
          FROM execution_settlements settled
         WHERE settled.execution_id = NEW.id
           AND settled.signature = NEW.signature
           AND settled.commitment = NEW.settlement_commitment
           AND settled.slot = NEW.settlement_slot
           AND settled.status = NEW.settlement_status
           AND settled.input_amount IS NOT DISTINCT FROM NEW.actual_input_amount
           AND settled.output_amount IS NOT DISTINCT FROM NEW.actual_output_amount
           AND settled.fee_lamports IS NOT DISTINCT FROM NEW.settlement_fee_lamports
           AND settled.provider_input_amount IS NOT DISTINCT FROM NEW.provider_input_amount
           AND settled.provider_output_amount IS NOT DISTINCT FROM NEW.provider_output_amount
    ) THEN
        RAISE EXCEPTION 'execution aggregate requires exact immutable settlement evidence'
            USING ERRCODE = '23514';
    END IF;

    IF OLD.settlement_status <> 'pending' AND settlement_changed AND (
        NEW.actual_input_amount IS DISTINCT FROM OLD.actual_input_amount
        OR NEW.actual_output_amount IS DISTINCT FROM OLD.actual_output_amount
        OR NEW.settlement_status IS DISTINCT FROM OLD.settlement_status
        OR NEW.settlement_slot IS DISTINCT FROM OLD.settlement_slot
        OR NEW.settlement_fee_lamports IS DISTINCT FROM OLD.settlement_fee_lamports
        OR OLD.settlement_commitment <> 'confirmed'
        OR NEW.settlement_commitment <> 'finalized'
    ) THEN
        RAISE EXCEPTION 'execution settlement may only promote confirmed evidence'
            USING ERRCODE = '55000';
    END IF;

    IF OLD.settlement_status <> 'pending'
        AND NEW.state IS DISTINCT FROM OLD.state
        AND NEW.state NOT IN ('confirmed', 'finalized') THEN
        RAISE EXCEPTION 'observed execution settlement state cannot be discarded'
            USING ERRCODE = '55000';
    END IF;

    IF NEW.provider = 'jupiter_swap_v2'
        AND NEW.state IN ('confirmed', 'finalized')
        AND (
            NEW.settlement_status NOT IN ('verified', 'mismatch')
            OR NEW.settlement_commitment IS DISTINCT FROM NEW.state
        ) THEN
        RAISE EXCEPTION 'managed swap confirmation requires independent settlement evidence'
            USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trade_executions_amount_guard
    BEFORE UPDATE ON trade_executions
    FOR EACH ROW EXECUTE FUNCTION execution_amount_guard();

REVOKE ALL ON FUNCTION execution_settlement_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION execution_amount_guard() FROM PUBLIC;

COMMENT ON TABLE execution_settlements IS
    'Append-only Solana balance evidence kept separate from immutable Jupiter acknowledgement amounts';
COMMENT ON COLUMN trade_executions.actual_input_amount IS
    'Independently observed wallet input delta; null until supported Solana settlement evidence exists';
COMMENT ON COLUMN trade_executions.provider_input_amount IS
    'Immutable Jupiter acknowledgement amount; never authoritative chain settlement';
