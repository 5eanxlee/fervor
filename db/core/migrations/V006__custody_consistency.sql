-- Close evidence-linked reversal races and validate facts that predate the
-- custody guards. A canonical movement is slot-independent; each commitment
-- observation retains its own slot in asset_evidence.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';
SET LOCAL idle_in_transaction_session_timeout = '60s';
SET LOCAL search_path = public;

-- Keep validation and guard replacement in one write-fenced transaction.
LOCK TABLE asset_journals, asset_chain_events, asset_evidence, asset_obligations
    IN SHARE ROW EXCLUSIVE MODE;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
          FROM asset_evidence evidence
          JOIN asset_journals journal ON journal.id = evidence.journal_id
         WHERE evidence.effect_key <> journal.effect_key
            OR evidence.order_id IS DISTINCT FROM journal.order_id
            OR evidence.action_id IS DISTINCT FROM journal.action_id
            OR evidence.cluster <> journal.cluster
            OR evidence.wallet_address <> journal.wallet_address
            OR (evidence.mint IS NOT NULL AND NOT EXISTS (
                SELECT 1
                  FROM asset_entries entry
                  JOIN asset_accounts account ON account.id = entry.account_id
                 WHERE entry.journal_id = journal.id
                   AND account.mint = evidence.mint
                   AND account.vault_address IS NOT DISTINCT FROM evidence.vault_address
            ))
    ) THEN
        RAISE EXCEPTION 'legacy evidence does not match its journal identity';
    END IF;

    IF EXISTS (
        SELECT 1
          FROM asset_evidence evidence
          JOIN asset_chain_events event ON event.id = evidence.chain_event_id
         WHERE evidence.source = 'chain'
           AND (event.cluster <> evidence.cluster
            OR event.signature <> evidence.signature
            OR event.instruction_index <> evidence.instruction_index
            OR event.event_index <> evidence.event_index
            OR event.journal_id IS DISTINCT FROM evidence.journal_id
            OR event.effect_key <> evidence.effect_key
            OR event.order_id IS DISTINCT FROM evidence.order_id
            OR event.action_id IS DISTINCT FROM evidence.action_id
            OR event.wallet_address <> evidence.wallet_address
            OR event.vault_address IS DISTINCT FROM evidence.vault_address
            OR event.mint <> evidence.mint)
    ) THEN
        RAISE EXCEPTION 'legacy chain observation conflicts with its canonical movement';
    END IF;

    IF EXISTS (
        SELECT 1
          FROM asset_obligations obligation
          JOIN asset_evidence evidence ON evidence.id = obligation.open_evidence_id
         WHERE evidence.cluster <> obligation.cluster
            OR evidence.wallet_address <> obligation.wallet_address
            OR evidence.vault_address IS DISTINCT FROM obligation.vault_address
            OR evidence.mint IS DISTINCT FROM obligation.mint
            OR evidence.order_id IS DISTINCT FROM obligation.order_id
            OR evidence.action_id IS DISTINCT FROM obligation.action_id
    ) THEN
        RAISE EXCEPTION 'legacy opening evidence does not match its obligation';
    END IF;

    IF EXISTS (
        SELECT 1
          FROM asset_obligations obligation
          JOIN asset_evidence evidence ON evidence.id = obligation.clear_evidence_id
         WHERE obligation.state = 'cleared'
           AND (evidence.source <> 'chain'
            OR evidence.commitment NOT IN ('confirmed', 'finalized')
            OR evidence.cluster <> obligation.cluster
            OR evidence.wallet_address <> obligation.wallet_address
            OR evidence.vault_address IS DISTINCT FROM obligation.vault_address
            OR evidence.mint IS DISTINCT FROM obligation.mint
            OR evidence.order_id IS DISTINCT FROM obligation.order_id
            OR evidence.action_id IS DISTINCT FROM obligation.action_id
            OR (evidence.journal_id IS NOT NULL AND NOT EXISTS (
                SELECT 1
                  FROM asset_journals journal
                 WHERE journal.id = evidence.journal_id
                   AND journal.post_state = 'posted'
                   AND journal.state IN ('confirmed', 'finalized')
            )))
    ) THEN
        RAISE EXCEPTION 'legacy clearing evidence is not an active identity-matched proof';
    END IF;

    IF EXISTS (
        SELECT 1
          FROM asset_obligations obligation
          JOIN asset_journals journal ON journal.id = obligation.clear_journal_id
         WHERE obligation.state = 'cleared'
           AND (journal.post_state <> 'posted'
            OR journal.state NOT IN ('confirmed', 'finalized')
            OR journal.cluster <> obligation.cluster
            OR journal.wallet_address <> obligation.wallet_address
            OR journal.order_id IS DISTINCT FROM obligation.order_id
            OR journal.action_id IS DISTINCT FROM obligation.action_id
            OR NOT EXISTS (
                SELECT 1
                  FROM asset_entries entry
                  JOIN asset_accounts account ON account.id = entry.account_id
                 WHERE entry.journal_id = journal.id
                   AND account.mint = obligation.mint
                   AND account.vault_address IS NOT DISTINCT FROM obligation.vault_address
            ))
    ) THEN
        RAISE EXCEPTION 'legacy clearing journal is not an active identity-matched proof';
    END IF;

    IF EXISTS (
        SELECT 1
          FROM asset_journals reversal
         WHERE reversal.kind = 'reversal'
           AND reversal.post_state = 'posted'
           AND reversal.state IN ('confirmed', 'finalized')
           AND NOT EXISTS (
               SELECT 1 FROM asset_journals original
                WHERE original.id = reversal.reversal_of AND original.state = 'reversed'
           )
    ) OR EXISTS (
        SELECT 1
          FROM asset_journals original
         WHERE original.state = 'reversed'
           AND NOT EXISTS (
               SELECT 1 FROM asset_journals reversal
                WHERE reversal.reversal_of = original.id
                  AND reversal.post_state = 'posted'
                  AND reversal.state IN ('confirmed', 'finalized', 'reversed')
           )
    ) THEN
        RAISE EXCEPTION 'legacy reversal pair is not atomically consistent';
    END IF;
END;
$$;

CREATE OR REPLACE FUNCTION asset_evidence_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    journal asset_journals%ROWTYPE;
    chain_event asset_chain_events%ROWTYPE;
BEGIN
    IF NEW.order_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM order_intents
         WHERE id = NEW.order_id AND wallet_address = NEW.wallet_address
    ) THEN
        RAISE EXCEPTION 'asset evidence order does not belong to its wallet' USING ERRCODE = '23514';
    END IF;

    IF NEW.source = 'chain' THEN
        SELECT * INTO chain_event FROM asset_chain_events WHERE id = NEW.chain_event_id;
        IF NOT FOUND
            OR chain_event.cluster <> NEW.cluster
            OR chain_event.signature <> NEW.signature
            OR chain_event.instruction_index <> NEW.instruction_index
            OR chain_event.event_index <> NEW.event_index
            OR chain_event.journal_id IS DISTINCT FROM NEW.journal_id
            OR chain_event.effect_key <> NEW.effect_key
            OR chain_event.order_id IS DISTINCT FROM NEW.order_id
            OR chain_event.action_id IS DISTINCT FROM NEW.action_id
            OR chain_event.wallet_address <> NEW.wallet_address
            OR chain_event.vault_address IS DISTINCT FROM NEW.vault_address
            OR chain_event.mint <> NEW.mint THEN
            RAISE EXCEPTION 'chain observation does not match its canonical event binding'
                USING ERRCODE = '23514';
        END IF;
    END IF;

    IF NEW.journal_id IS NULL THEN
        RETURN NEW;
    END IF;
    SELECT * INTO journal FROM asset_journals WHERE id = NEW.journal_id;
    IF NOT FOUND OR journal.effect_key <> NEW.effect_key
        OR journal.order_id IS DISTINCT FROM NEW.order_id
        OR journal.action_id IS DISTINCT FROM NEW.action_id
        OR journal.cluster <> NEW.cluster
        OR journal.wallet_address <> NEW.wallet_address THEN
        RAISE EXCEPTION 'evidence does not match its journal identity' USING ERRCODE = '23514';
    END IF;
    IF NEW.mint IS NOT NULL AND NOT EXISTS (
        SELECT 1
          FROM asset_entries entry
          JOIN asset_accounts account ON account.id = entry.account_id
         WHERE entry.journal_id = journal.id AND account.mint = NEW.mint
           AND account.vault_address IS NOT DISTINCT FROM NEW.vault_address
    ) THEN
        RAISE EXCEPTION 'evidence mint or vault is absent from its journal' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION asset_obligation_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    clearing_journal UUID;
    clearing_state VARCHAR(12);
BEGIN
    IF TG_OP = 'INSERT' THEN
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

CREATE OR REPLACE FUNCTION asset_journal_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'asset_journals is append-only' USING ERRCODE = '55000';
    END IF;

    PERFORM 1
      FROM asset_accounts account
      JOIN asset_entries entry ON entry.account_id = account.id
     WHERE entry.journal_id = OLD.id
     ORDER BY account.id
     FOR UPDATE OF account;

    IF OLD.post_state = 'draft' THEN
        IF NEW.post_state <> 'posted' OR NEW.state <> OLD.state
            OR (to_jsonb(NEW) - ARRAY['post_state', 'posted_at'])
               IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['post_state', 'posted_at']) THEN
            RAISE EXCEPTION 'a draft journal may only transition to posted' USING ERRCODE = '23514';
        END IF;
        NEW.posted_at := coalesce(NEW.posted_at, CURRENT_TIMESTAMP);
        RETURN NEW;
    END IF;

    IF NEW.post_state <> 'posted'
        OR (to_jsonb(NEW) - ARRAY['state', 'state_at'])
           IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['state', 'state_at']) THEN
        RAISE EXCEPTION 'posted journal facts are immutable' USING ERRCODE = '55000';
    END IF;
    IF NOT (
        (OLD.state = 'claimed' AND NEW.state IN ('confirmed', 'finalized'))
        OR (OLD.state = 'confirmed' AND NEW.state IN ('finalized', 'reversed'))
        OR (OLD.state = 'finalized' AND NEW.state = 'reversed')
    ) THEN
        RAISE EXCEPTION 'invalid journal state transition % to %', OLD.state, NEW.state
            USING ERRCODE = '23514';
    END IF;
    IF NEW.state = 'reversed' AND EXISTS (
        SELECT 1
          FROM asset_obligations obligation
         WHERE obligation.state = 'cleared'
           AND (obligation.clear_journal_id = OLD.id OR EXISTS (
               SELECT 1
                 FROM asset_evidence evidence
                WHERE evidence.id = obligation.clear_evidence_id
                  AND evidence.journal_id = OLD.id
           ))
    ) THEN
        RAISE EXCEPTION 'a journal used to clear an obligation cannot be reversed'
            USING ERRCODE = '23514';
    END IF;
    NEW.state_at := CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$;

COMMENT ON COLUMN asset_chain_events.slot IS
    'Slot of the first accepted observation; commitment-specific slots live in asset_evidence';
COMMENT ON TABLE asset_chain_events IS
    'Immutable slot-independent chain movement binding; commitment observations remain in asset_evidence';
