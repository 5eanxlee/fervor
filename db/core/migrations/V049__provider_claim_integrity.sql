-- Provider history opens an immutable, reconstructable multi-asset claim. Only
-- one exact independently confirmed journal may clear the complete claim.
-- stride: destructive-review=provider-claim-integrity-v49

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';
SET LOCAL idle_in_transaction_session_timeout = '60s';
SET LOCAL search_path = public;

ALTER TABLE asset_evidence
    ADD COLUMN payload JSONB,
    ADD CONSTRAINT asset_evidence_payload_size
        CHECK (payload IS NULL OR pg_column_size(payload) <= 16384);

ALTER TABLE asset_obligations
    ADD COLUMN claim_ver SMALLINT,
    ADD COLUMN claim_count SMALLINT,
    ADD COLUMN claim_hash CHAR(64),
    ADD CONSTRAINT asset_obligations_claim_shape CHECK (
        (claim_ver IS NULL AND claim_count IS NULL AND claim_hash IS NULL)
        OR
        (claim_ver IN (1, 2) AND claim_count BETWEEN 1 AND 8
            AND claim_hash ~ '^[0-9a-f]{64}$')
    ) NOT VALID;

LOCK TABLE asset_evidence, asset_obligations, asset_claim_parts
    IN SHARE ROW EXCLUSIVE MODE;

ALTER TABLE asset_obligations DISABLE TRIGGER asset_obligation_write_guard;

WITH legacy AS (
    SELECT part.obligation_id,
           count(*)::smallint AS claim_count,
           encode(digest(convert_to(
               string_agg(part.line_no::text || '|' || part.part_hash, E'\n' ORDER BY part.line_no),
               'UTF8'
           ), 'sha256'), 'hex') AS claim_hash
      FROM asset_claim_parts part
     GROUP BY part.obligation_id
)
UPDATE asset_obligations obligation
   SET claim_ver = 1,
       claim_count = legacy.claim_count,
       claim_hash = legacy.claim_hash
  FROM legacy
 WHERE obligation.id = legacy.obligation_id
   AND obligation.claim_ver IS NULL;

ALTER TABLE asset_obligations ENABLE TRIGGER asset_obligation_write_guard;

ALTER TABLE asset_obligations VALIDATE CONSTRAINT asset_obligations_claim_shape;

INSERT INTO order_anomalies (
    id, anomaly_key, order_id, obligation_id, scope, kind, severity,
    blocks_actions, detail_hash, detail
)
SELECT gen_random_uuid(),
       'migration:v49:legacy-claim:' || obligation.id::text,
       obligation.order_id,
       obligation.id,
       'order',
       'policy_violation',
       'critical',
       true,
       encode(digest(convert_to(
           'migration:v49:legacy-claim:' || obligation.id::text,
           'UTF8'
       ), 'sha256'), 'hex'),
       jsonb_build_object(
           'obligationId', obligation.id,
           'reason', 'legacy_provider_claim_requires_review',
           'claimVer', obligation.claim_ver
       )
  FROM asset_obligations obligation
 WHERE obligation.claim_ver = 1
   AND obligation.order_id IS NOT NULL
ON CONFLICT (anomaly_key) DO NOTHING;

INSERT INTO order_anomalies (
    id, anomaly_key, order_id, scope, kind, severity,
    blocks_actions, detail_hash, detail
)
SELECT gen_random_uuid(),
       'migration:v49:null-cluster:' || order_row.id::text,
       order_row.id,
       'order',
       'policy_violation',
       'critical',
       true,
       encode(digest(convert_to(
           'migration:v49:null-cluster:' || order_row.id::text,
           'UTF8'
       ), 'sha256'), 'hex'),
       jsonb_build_object(
           'orderId', order_row.id,
           'provider', order_row.provider,
           'providerOrderId', order_row.provider_order_id,
           'reason', 'missing_financial_cluster_identity'
       )
  FROM order_intents order_row
 WHERE order_row.cluster IS NULL
   AND order_row.provider_order_id IS NOT NULL
ON CONFLICT (anomaly_key) DO NOTHING;

CREATE OR REPLACE FUNCTION asset_claim_part_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
    obligation asset_obligations%ROWTYPE;
    evidence asset_evidence%ROWTYPE;
    expected_hash TEXT;
BEGIN
    IF TG_OP <> 'INSERT' THEN
        RAISE EXCEPTION 'asset_claim_parts is append-only' USING ERRCODE = '55000';
    END IF;

    SELECT * INTO obligation
      FROM asset_obligations
     WHERE id = NEW.obligation_id;
    SELECT * INTO evidence
      FROM asset_evidence
     WHERE id = NEW.evidence_id;

    IF obligation.id IS NULL OR obligation.claim_ver IS DISTINCT FROM 2 THEN
        RAISE EXCEPTION 'new provider claim parts require version 2 obligations'
            USING ERRCODE = '23514';
    END IF;

    IF evidence.id IS NULL
        OR evidence.source <> 'provider'
        OR evidence.journal_id IS NOT NULL
        OR evidence.effect_key <> (
            SELECT opening.effect_key
              FROM asset_evidence opening
             WHERE opening.id = obligation.open_evidence_id
        )
        OR evidence.cluster <> obligation.cluster
        OR evidence.wallet_address <> obligation.wallet_address
        OR evidence.vault_address IS DISTINCT FROM obligation.vault_address
        OR evidence.order_id IS DISTINCT FROM obligation.order_id
        OR evidence.action_id IS DISTINCT FROM obligation.action_id
        OR evidence.mint IS DISTINCT FROM NEW.mint THEN
        RAISE EXCEPTION 'claim part crosses its obligation or provider evidence boundary'
            USING ERRCODE = '23514';
    END IF;

    IF obligation.claim_ver = 2 THEN
        expected_hash := encode(digest(convert_to(
            NEW.role || '|' || NEW.mint || '|' || NEW.amount::text || '|' || NEW.evidence_id::text,
            'UTF8'
        ), 'sha256'), 'hex');
        IF NEW.part_hash <> expected_hash
            OR evidence.signature IS NULL
            OR evidence.payload IS NULL THEN
            RAISE EXCEPTION 'version 2 claim part lacks its exact signed provider document'
                USING ERRCODE = '23514';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

CREATE FUNCTION asset_assert_claim(target UUID) RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
    obligation asset_obligations%ROWTYPE;
    actual_count INTEGER;
    actual_hash TEXT;
BEGIN
    SELECT * INTO obligation FROM asset_obligations WHERE id = target;
    IF obligation.claim_ver IS NULL THEN
        RETURN;
    END IF;

    SELECT count(*),
           encode(digest(convert_to(
               string_agg(part.line_no::text || '|' || part.part_hash, E'\n' ORDER BY part.line_no),
               'UTF8'
           ), 'sha256'), 'hex')
      INTO actual_count, actual_hash
      FROM asset_claim_parts part
     WHERE part.obligation_id = target;

    IF actual_count <> obligation.claim_count OR actual_hash <> obligation.claim_hash
        OR NOT EXISTS (
            SELECT 1
              FROM asset_claim_parts part
             WHERE part.obligation_id = target
               AND part.mint = obligation.mint
               AND part.amount = obligation.amount
               AND part.evidence_id = obligation.open_evidence_id
        )
        OR (SELECT min(line_no) FROM asset_claim_parts WHERE obligation_id = target) <> 0
        OR (SELECT max(line_no) FROM asset_claim_parts WHERE obligation_id = target)
            <> obligation.claim_count - 1 THEN
        RAISE EXCEPTION 'provider money obligation lacks its exact complete claim'
            USING ERRCODE = '23514';
    END IF;

    IF obligation.claim_ver = 1 THEN
        RETURN;
    END IF;

    IF obligation.kind = 'fill_unverified' THEN
        IF actual_count <> 2
            OR (SELECT count(*) FROM asset_claim_parts
                 WHERE obligation_id = target AND role = 'input') <> 1
            OR (SELECT count(*) FROM asset_claim_parts
                 WHERE obligation_id = target AND role = 'output') <> 1
            OR (SELECT count(DISTINCT mint) FROM asset_claim_parts
                 WHERE obligation_id = target) <> 2 THEN
            RAISE EXCEPTION 'fill claim requires exact input and output legs'
                USING ERRCODE = '23514';
        END IF;
    ELSIF obligation.kind IN ('deposit_unknown', 'withdraw_unknown') THEN
        IF actual_count <> 1
            OR (SELECT count(*) FROM asset_claim_parts
                 WHERE obligation_id = target AND role = 'movement') <> 1 THEN
            RAISE EXCEPTION 'movement claim requires one exact movement leg'
                USING ERRCODE = '23514';
        END IF;
    ELSE
        RAISE EXCEPTION 'provider claim uses an unsupported obligation kind'
            USING ERRCODE = '23514';
    END IF;

    IF EXISTS (
        SELECT 1
          FROM asset_claim_parts part
          JOIN asset_evidence evidence ON evidence.id = part.evidence_id
          JOIN asset_evidence opening ON opening.id = obligation.open_evidence_id
         WHERE part.obligation_id = target
           AND (evidence.source <> 'provider'
             OR evidence.signature IS NULL
             OR evidence.payload IS NULL
             OR evidence.effect_key <> opening.effect_key)
    ) THEN
        RAISE EXCEPTION 'claim evidence is incomplete or crosses semantic effects'
            USING ERRCODE = '23514';
    END IF;
    RETURN;
END;
$$;

CREATE OR REPLACE FUNCTION asset_claim_check() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
    PERFORM asset_assert_claim(NEW.id);
    RETURN NULL;
END;
$$;

CREATE FUNCTION asset_claim_part_check() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
    PERFORM asset_assert_claim(NEW.obligation_id);
    RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER asset_claim_parts_complete
    AFTER INSERT ON asset_claim_parts
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION asset_claim_part_check();

CREATE OR REPLACE FUNCTION asset_obligation_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
    clearing_journal UUID;
    clearing_state VARCHAR(12);
    expected_kind VARCHAR(16);
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW.claim_ver IS NOT NULL
            AND (NEW.claim_ver <> 2 OR NOT NEW.blocks_actions) THEN
            RAISE EXCEPTION 'new provider claims require blocking version 2 obligations'
                USING ERRCODE = '23514';
        END IF;
        IF NEW.order_id IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM order_intents
             WHERE id = NEW.order_id AND wallet_address = NEW.wallet_address
        ) THEN
            RAISE EXCEPTION 'asset obligation order does not belong to its wallet' USING ERRCODE = '23514';
        END IF;
        IF NEW.open_evidence_id IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM asset_evidence evidence
             WHERE evidence.id = NEW.open_evidence_id
               AND evidence.cluster = NEW.cluster
               AND evidence.wallet_address = NEW.wallet_address
               AND evidence.vault_address IS NOT DISTINCT FROM NEW.vault_address
               AND evidence.mint = NEW.mint
               AND evidence.order_id IS NOT DISTINCT FROM NEW.order_id
               AND evidence.action_id IS NOT DISTINCT FROM NEW.action_id
        ) THEN
            RAISE EXCEPTION 'opening evidence does not match its obligation' USING ERRCODE = '23514';
        END IF;
        IF NEW.kind IN ('deposit_unknown', 'fill_unverified', 'withdraw_unknown')
            AND NEW.open_evidence_id IS NOT NULL
            AND EXISTS (
                SELECT 1 FROM asset_evidence evidence
                 WHERE evidence.id = NEW.open_evidence_id AND evidence.source = 'provider'
            )
            AND NEW.claim_ver IS NULL THEN
            RAISE EXCEPTION 'provider money obligation requires a complete versioned claim'
                USING ERRCODE = '23514';
        END IF;
        IF NEW.claim_ver IS NOT NULL
            AND (NEW.kind NOT IN ('deposit_unknown', 'fill_unverified', 'withdraw_unknown')
              OR NEW.amount IS NULL
              OR NOT EXISTS (
                  SELECT 1 FROM asset_evidence evidence
                   WHERE evidence.id = NEW.open_evidence_id AND evidence.source = 'provider'
              )) THEN
            RAISE EXCEPTION 'versioned claim has an invalid provider obligation boundary'
                USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
    END IF;
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'asset_obligations cannot be deleted' USING ERRCODE = '55000';
    END IF;
    IF (to_jsonb(NEW) - ARRAY['state', 'review_at', 'clear_evidence_id', 'clear_journal_id', 'cleared_at'])
       IS DISTINCT FROM
       (to_jsonb(OLD) - ARRAY['state', 'review_at', 'clear_evidence_id', 'clear_journal_id', 'cleared_at']) THEN
        RAISE EXCEPTION 'obligation facts are immutable' USING ERRCODE = '55000';
    END IF;
    IF OLD.state = 'open' AND NEW.state = 'review' THEN
        NEW.review_at := coalesce(NEW.review_at, CURRENT_TIMESTAMP);
        RETURN NEW;
    END IF;
    IF OLD.state NOT IN ('open', 'review') OR NEW.state <> 'cleared' THEN
        RAISE EXCEPTION 'invalid obligation transition % to %', OLD.state, NEW.state
            USING ERRCODE = '23514';
    END IF;

    IF OLD.claim_ver IS NOT NULL THEN
        IF NEW.clear_evidence_id IS NOT NULL OR NEW.clear_journal_id IS NULL THEN
            RAISE EXCEPTION 'provider claims require one complete settlement journal'
                USING ERRCODE = '23514';
        END IF;
        expected_kind := CASE OLD.kind
            WHEN 'deposit_unknown' THEN 'deposit'
            WHEN 'fill_unverified' THEN 'fill'
            WHEN 'withdraw_unknown' THEN 'withdrawal'
            ELSE NULL
        END;
        IF expected_kind IS NULL THEN
            RAISE EXCEPTION 'provider claim kind cannot be cleared automatically'
                USING ERRCODE = '23514';
        END IF;

        SELECT journal.state INTO clearing_state
          FROM asset_journals journal
         WHERE journal.id = NEW.clear_journal_id
           AND journal.post_state = 'posted'
           AND journal.kind = expected_kind
           AND journal.cluster = NEW.cluster
           AND journal.wallet_address = NEW.wallet_address
           AND journal.order_id IS NOT DISTINCT FROM NEW.order_id
           AND journal.action_id IS NOT DISTINCT FROM NEW.action_id
           AND NOT EXISTS (
               SELECT 1
                 FROM asset_entries entry
                 JOIN asset_accounts account ON account.id = entry.account_id
                WHERE entry.journal_id = journal.id
                  AND NOT EXISTS (
                      SELECT 1 FROM asset_claim_parts part
                       WHERE part.obligation_id = NEW.id AND part.mint = account.mint
                  )
           )
           AND NOT EXISTS (
               SELECT 1
                 FROM asset_claim_parts part
                WHERE part.obligation_id = NEW.id
                  AND (
                      (SELECT coalesce(sum(entry.amount), 0)
                         FROM asset_entries entry
                         JOIN asset_accounts account ON account.id = entry.account_id
                        WHERE entry.journal_id = journal.id
                          AND account.mint = part.mint
                          AND entry.side = 'debit') <> part.amount
                      OR
                      (SELECT coalesce(sum(entry.amount), 0)
                         FROM asset_entries entry
                         JOIN asset_accounts account ON account.id = entry.account_id
                        WHERE entry.journal_id = journal.id
                          AND account.mint = part.mint
                          AND entry.side = 'credit') <> part.amount
                      OR
                      (SELECT coalesce(sum(entry.amount), 0)
                         FROM asset_entries entry
                         JOIN asset_accounts account ON account.id = entry.account_id
                        WHERE entry.journal_id = journal.id
                          AND account.mint = part.mint
                          AND account.scope = 'vault_attr'
                          AND account.vault_address IS NOT DISTINCT FROM NEW.vault_address
                          AND account.order_id IS NOT DISTINCT FROM NEW.order_id
                          AND entry.side = 'debit') <>
                          CASE
                              WHEN OLD.kind = 'deposit_unknown' THEN part.amount
                              WHEN OLD.kind = 'fill_unverified' AND part.role = 'output' THEN part.amount
                              ELSE 0
                          END
                      OR
                      (SELECT coalesce(sum(entry.amount), 0)
                         FROM asset_entries entry
                         JOIN asset_accounts account ON account.id = entry.account_id
                        WHERE entry.journal_id = journal.id
                          AND account.mint = part.mint
                          AND account.scope = 'vault_attr'
                          AND account.vault_address IS NOT DISTINCT FROM NEW.vault_address
                          AND account.order_id IS NOT DISTINCT FROM NEW.order_id
                          AND entry.side = 'credit') <>
                          CASE
                              WHEN OLD.kind = 'withdraw_unknown' THEN part.amount
                              WHEN OLD.kind = 'fill_unverified' AND part.role = 'input' THEN part.amount
                              ELSE 0
                          END
                  )
           )
         FOR UPDATE OF journal;
        IF clearing_state IS NULL OR clearing_state NOT IN ('confirmed', 'finalized') THEN
            RAISE EXCEPTION 'settlement journal does not exactly clear every provider claim leg'
                USING ERRCODE = '23514';
        END IF;
        NEW.cleared_at := coalesce(NEW.cleared_at, CURRENT_TIMESTAMP);
        RETURN NEW;
    END IF;

    IF NEW.clear_journal_id IS NOT NULL THEN
        clearing_journal := NEW.clear_journal_id;
    ELSE
        SELECT evidence.journal_id INTO clearing_journal
          FROM asset_evidence evidence
         WHERE evidence.id = NEW.clear_evidence_id AND evidence.source = 'chain'
           AND evidence.commitment IN ('confirmed', 'finalized')
           AND evidence.cluster = NEW.cluster
           AND evidence.wallet_address = NEW.wallet_address
           AND evidence.vault_address IS NOT DISTINCT FROM NEW.vault_address
           AND evidence.mint = NEW.mint
           AND evidence.order_id IS NOT DISTINCT FROM NEW.order_id
           AND evidence.action_id IS NOT DISTINCT FROM NEW.action_id;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'clearing evidence is not independently confirmed' USING ERRCODE = '23514';
        END IF;
        IF clearing_journal IS NULL THEN
            NEW.cleared_at := coalesce(NEW.cleared_at, CURRENT_TIMESTAMP);
            RETURN NEW;
        END IF;
    END IF;

    SELECT journal.state INTO clearing_state
      FROM asset_journals journal
     WHERE journal.id = clearing_journal AND journal.post_state = 'posted'
       AND journal.cluster = NEW.cluster
       AND journal.wallet_address = NEW.wallet_address
       AND journal.order_id IS NOT DISTINCT FROM NEW.order_id
       AND journal.action_id IS NOT DISTINCT FROM NEW.action_id
       AND EXISTS (
           SELECT 1
             FROM asset_entries entry
             JOIN asset_accounts account ON account.id = entry.account_id
            WHERE entry.journal_id = journal.id AND account.mint = NEW.mint
              AND account.vault_address IS NOT DISTINCT FROM NEW.vault_address
       )
     FOR UPDATE OF journal;
    IF clearing_state IS NULL OR clearing_state NOT IN ('confirmed', 'finalized') THEN
        RAISE EXCEPTION 'clearing journal is not independently confirmed' USING ERRCODE = '23514';
    END IF;
    NEW.cleared_at := coalesce(NEW.cleared_at, CURRENT_TIMESTAMP);
    RETURN NEW;
END;
$$;

CREATE OR REPLACE VIEW asset_circuits AS
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

COMMENT ON COLUMN asset_evidence.payload IS
    'Bounded canonical provider or chain document needed to reconstruct the observed fact';
COMMENT ON COLUMN asset_obligations.claim_hash IS
    'SHA-256 over the ordered immutable claim-part hashes; version 1 claims remain quarantined';
