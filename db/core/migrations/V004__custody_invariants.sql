-- Bind chain observations to one semantic movement and serialize obligation
-- clearing with reversal on the journal row shared by both operations.
-- stride: destructive-review=custody-invariants-v4

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';
SET LOCAL idle_in_transaction_session_timeout = '60s';
SET LOCAL search_path = public;

CREATE TABLE asset_chain_events (
    id UUID PRIMARY KEY,
    cluster VARCHAR(32) NOT NULL CHECK (cluster IN ('mainnet-beta', 'devnet', 'testnet', 'localnet')),
    signature VARCHAR(128) NOT NULL CHECK (signature ~ '^[1-9A-HJ-NP-Za-km-z]{64,88}$'),
    instruction_index INTEGER NOT NULL CHECK (instruction_index >= 0),
    event_index INTEGER NOT NULL CHECK (event_index >= 0),
    slot BIGINT NOT NULL CHECK (slot BETWEEN 0 AND 9007199254740991),
    journal_id UUID REFERENCES asset_journals(id) ON DELETE RESTRICT,
    effect_key VARCHAR(180) NOT NULL,
    order_id UUID REFERENCES order_intents(id) ON DELETE RESTRICT,
    action_id UUID,
    wallet_address VARCHAR(64) NOT NULL CHECK (wallet_address ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
    vault_address VARCHAR(64) CHECK (vault_address ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
    mint VARCHAR(64) NOT NULL CHECK (mint ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (cluster, signature, instruction_index, event_index)
);

ALTER TABLE asset_evidence
    ADD COLUMN chain_event_id UUID REFERENCES asset_chain_events(id) ON DELETE RESTRICT,
    ADD COLUMN legacy_source_key VARCHAR(220),
    ADD COLUMN vault_address VARCHAR(64)
        CHECK (vault_address ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$');

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM asset_evidence
         WHERE source = 'chain'
           AND (instruction_index IS NULL OR event_index IS NULL OR mint IS NULL)
    ) THEN
        RAISE EXCEPTION 'existing chain evidence lacks a deterministic event discriminator or mint';
    END IF;

    IF EXISTS (
        SELECT 1
          FROM asset_evidence
         WHERE source = 'chain'
         GROUP BY cluster, signature, instruction_index, event_index
        HAVING count(DISTINCT jsonb_build_array(
            journal_id, effect_key, order_id, action_id, wallet_address, mint
        )) > 1
    ) THEN
        RAISE EXCEPTION 'one chain event is bound to conflicting semantic movements';
    END IF;

    IF EXISTS (
        SELECT evidence.id
          FROM asset_evidence evidence
          JOIN asset_entries entry ON entry.journal_id = evidence.journal_id
          JOIN asset_accounts account ON account.id = entry.account_id
         WHERE evidence.source = 'chain' AND account.vault_address IS NOT NULL
         GROUP BY evidence.id
        HAVING count(DISTINCT account.vault_address) > 1
    ) OR EXISTS (
        SELECT evidence.id
          FROM asset_evidence evidence
          JOIN asset_obligations obligation
            ON obligation.open_evidence_id = evidence.id OR obligation.clear_evidence_id = evidence.id
         WHERE evidence.source = 'chain' AND obligation.vault_address IS NOT NULL
         GROUP BY evidence.id
        HAVING count(DISTINCT obligation.vault_address) > 1
    ) THEN
        RAISE EXCEPTION 'existing chain evidence has conflicting physical vault identities';
    END IF;
END;
$$;

INSERT INTO asset_chain_events (
    id, cluster, signature, instruction_index, event_index, slot, journal_id,
    effect_key, order_id, action_id, wallet_address, vault_address, mint
)
SELECT DISTINCT ON (cluster, signature, instruction_index, event_index)
       gen_random_uuid(), cluster, signature, instruction_index, event_index, slot,
       journal_id, effect_key, order_id, action_id, wallet_address,
       coalesce(journal_vault.vault_address, obligation_vault.vault_address), mint
  FROM asset_evidence evidence
  LEFT JOIN LATERAL (
      SELECT min(account.vault_address) AS vault_address
        FROM asset_entries entry
        JOIN asset_accounts account ON account.id = entry.account_id
       WHERE entry.journal_id = evidence.journal_id AND account.vault_address IS NOT NULL
  ) journal_vault ON TRUE
  LEFT JOIN LATERAL (
      SELECT min(obligation.vault_address) AS vault_address
        FROM asset_obligations obligation
       WHERE obligation.open_evidence_id = evidence.id OR obligation.clear_evidence_id = evidence.id
  ) obligation_vault ON TRUE
 WHERE source = 'chain'
 ORDER BY cluster, signature, instruction_index, event_index, observed_at, evidence.id;

-- DDL takes an access-exclusive table lock. Concurrent writers therefore wait
-- until the append-only trigger is restored at this transaction's commit.
ALTER TABLE asset_evidence DISABLE TRIGGER asset_evidence_immutable;
UPDATE asset_evidence evidence
   SET chain_event_id = event.id,
       vault_address = event.vault_address,
       legacy_source_key = CASE
           WHEN evidence.source_key = concat(
               evidence.signature, ':', evidence.instruction_index, ':',
               evidence.event_index, ':', evidence.commitment
           ) THEN NULL
           ELSE evidence.source_key
       END,
       source_key = concat(
           evidence.signature, ':', evidence.instruction_index, ':',
           evidence.event_index, ':', evidence.commitment
       )
  FROM asset_chain_events event
 WHERE evidence.source = 'chain'
   AND event.cluster = evidence.cluster
   AND event.signature = evidence.signature
   AND event.instruction_index = evidence.instruction_index
   AND event.event_index = evidence.event_index;
ALTER TABLE asset_evidence ENABLE TRIGGER asset_evidence_immutable;

ALTER TABLE asset_evidence
    ADD CONSTRAINT asset_evidence_chain_shape CHECK (
        (source = 'chain' AND chain_event_id IS NOT NULL AND mint IS NOT NULL
            AND instruction_index IS NOT NULL AND event_index IS NOT NULL
            AND source_key = concat(signature, ':', instruction_index, ':', event_index, ':', commitment)
            AND (legacy_source_key IS NULL OR legacy_source_key <> source_key))
        OR
        (source <> 'chain' AND chain_event_id IS NULL AND legacy_source_key IS NULL)
    );

CREATE UNIQUE INDEX asset_evidence_chain_commit_idx
    ON asset_evidence (chain_event_id, commitment)
    WHERE source = 'chain';

CREATE UNIQUE INDEX asset_evidence_legacy_key_idx
    ON asset_evidence (cluster, legacy_source_key)
    WHERE source = 'chain' AND legacy_source_key IS NOT NULL;

COMMENT ON COLUMN asset_evidence.legacy_source_key IS
    'Pre-V4 chain idempotency key retained only for exact application replay';

CREATE TRIGGER asset_chain_events_immutable
    BEFORE UPDATE OR DELETE ON asset_chain_events
    FOR EACH ROW EXECUTE FUNCTION asset_deny_mutation();

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
            OR chain_event.slot <> NEW.slot
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
           AND (NEW.vault_address IS NULL OR account.vault_address = NEW.vault_address)
    ) THEN
        RAISE EXCEPTION 'evidence mint or vault is absent from its journal' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION asset_obligation_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
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
        -- The journal row is the stable coordination lock shared with reversal.
        SELECT journal.state INTO clearing_state
          FROM asset_journals journal
         WHERE journal.id = NEW.clear_journal_id AND journal.post_state = 'posted'
           AND journal.cluster = NEW.cluster
           AND journal.wallet_address = NEW.wallet_address
           AND (NEW.order_id IS NULL OR journal.order_id = NEW.order_id)
           AND (NEW.action_id IS NULL OR journal.action_id = NEW.action_id)
           AND EXISTS (
               SELECT 1
                 FROM asset_entries entry
                 JOIN asset_accounts account ON account.id = entry.account_id
                WHERE entry.journal_id = journal.id AND account.mint = NEW.mint
                  AND (NEW.vault_address IS NULL OR account.vault_address = NEW.vault_address)
           )
         FOR UPDATE OF journal;
        IF clearing_state IS NULL OR clearing_state NOT IN ('confirmed', 'finalized') THEN
            RAISE EXCEPTION 'clearing journal is not independently confirmed' USING ERRCODE = '23514';
        END IF;
    ELSIF NOT EXISTS (
        SELECT 1 FROM asset_evidence evidence
         WHERE evidence.id = NEW.clear_evidence_id AND evidence.source = 'chain'
           AND evidence.commitment IN ('confirmed', 'finalized')
           AND evidence.cluster = NEW.cluster
           AND evidence.wallet_address = NEW.wallet_address
           AND evidence.vault_address IS NOT DISTINCT FROM NEW.vault_address
           AND evidence.mint = NEW.mint
           AND (NEW.order_id IS NULL OR evidence.order_id = NEW.order_id)
           AND (NEW.action_id IS NULL OR evidence.action_id = NEW.action_id)
    ) THEN
        RAISE EXCEPTION 'clearing evidence is not independently confirmed' USING ERRCODE = '23514';
    END IF;
    NEW.cleared_at := coalesce(NEW.cleared_at, CURRENT_TIMESTAMP);
    RETURN NEW;
END;
$$;

CREATE FUNCTION asset_reversal_pair_check() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.kind = 'reversal' AND NEW.post_state = 'posted'
        AND NEW.state IN ('confirmed', 'finalized')
        AND NOT EXISTS (
            SELECT 1 FROM asset_journals original
             WHERE original.id = NEW.reversal_of AND original.state = 'reversed'
        ) THEN
        RAISE EXCEPTION 'a confirmed reversal and its source transition must commit atomically'
            USING ERRCODE = '23514';
    END IF;
    IF NEW.state = 'reversed' AND NOT EXISTS (
        SELECT 1 FROM asset_journals reversal
         WHERE reversal.reversal_of = NEW.id AND reversal.post_state = 'posted'
           AND reversal.state IN ('confirmed', 'finalized', 'reversed')
    ) THEN
        RAISE EXCEPTION 'a reversed journal requires its confirmed reversal in the same transaction'
            USING ERRCODE = '23514';
    END IF;
    RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER asset_reversal_pair
    AFTER INSERT OR UPDATE ON asset_journals
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION asset_reversal_pair_check();

COMMENT ON TABLE asset_chain_events IS
    'Immutable canonical chain movement binding; commitment observations remain in asset_evidence';
