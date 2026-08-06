-- Jupiter Trigger V2 uses one physical vault per wallet. vault_attr accounts are
-- Stride attributions inside that shared vault, never separate on-chain accounts.
-- stride: destructive-review=custody-ledger-v3

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';
SET LOCAL idle_in_transaction_session_timeout = '60s';
SET LOCAL search_path = public;

CREATE TABLE asset_accounts (
    id UUID PRIMARY KEY,
    account_key VARCHAR(180) NOT NULL UNIQUE,
    cluster VARCHAR(32) NOT NULL CHECK (cluster IN ('mainnet-beta', 'devnet', 'testnet', 'localnet')),
    wallet_address VARCHAR(64) NOT NULL CHECK (wallet_address ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
    vault_address VARCHAR(64) CHECK (vault_address ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
    order_id UUID REFERENCES order_intents(id) ON DELETE RESTRICT,
    mint VARCHAR(64) NOT NULL CHECK (mint ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
    scope VARCHAR(16) NOT NULL CHECK (scope IN ('wallet', 'vault_attr', 'execution', 'fee', 'suspense')),
    external_id VARCHAR(180) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK (scope <> 'vault_attr' OR (vault_address IS NOT NULL AND order_id IS NOT NULL))
);

CREATE INDEX asset_accounts_order_idx ON asset_accounts (order_id, mint, scope)
    WHERE order_id IS NOT NULL;
CREATE INDEX asset_accounts_vault_idx ON asset_accounts (cluster, vault_address, mint)
    WHERE vault_address IS NOT NULL;

CREATE TABLE asset_journals (
    id UUID PRIMARY KEY,
    effect_key VARCHAR(180) NOT NULL UNIQUE,
    req_hash CHAR(64) NOT NULL CHECK (req_hash ~ '^[0-9a-f]{64}$'),
    cluster VARCHAR(32) NOT NULL CHECK (cluster IN ('mainnet-beta', 'devnet', 'testnet', 'localnet')),
    wallet_address VARCHAR(64) NOT NULL CHECK (wallet_address ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
    order_id UUID REFERENCES order_intents(id) ON DELETE RESTRICT,
    leg_id UUID,
    action_id UUID,
    kind VARCHAR(16) NOT NULL CHECK (kind IN ('deposit', 'fill', 'withdrawal', 'fee', 'reversal')),
    state VARCHAR(12) NOT NULL DEFAULT 'claimed'
        CHECK (state IN ('claimed', 'confirmed', 'finalized', 'reversed', 'disputed')),
    post_state VARCHAR(8) NOT NULL DEFAULT 'draft' CHECK (post_state IN ('draft', 'posted')),
    reversal_of UUID REFERENCES asset_journals(id) ON DELETE RESTRICT,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (pg_column_size(metadata) <= 65536),
    occurred_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    posted_at TIMESTAMPTZ,
    state_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK ((kind = 'reversal') = (reversal_of IS NOT NULL)),
    CHECK ((post_state = 'posted') = (posted_at IS NOT NULL))
);

CREATE UNIQUE INDEX asset_journals_reversal_idx ON asset_journals (reversal_of)
    WHERE reversal_of IS NOT NULL;
CREATE INDEX asset_journals_order_idx ON asset_journals (order_id, occurred_at, id)
    WHERE order_id IS NOT NULL;
CREATE INDEX asset_journals_state_idx ON asset_journals (state, occurred_at, id)
    WHERE post_state = 'posted';

CREATE TABLE asset_entries (
    journal_id UUID NOT NULL REFERENCES asset_journals(id) ON DELETE RESTRICT,
    line_no SMALLINT NOT NULL CHECK (line_no >= 0),
    account_id UUID NOT NULL REFERENCES asset_accounts(id) ON DELETE RESTRICT,
    side VARCHAR(6) NOT NULL CHECK (side IN ('debit', 'credit')),
    amount sol_u64 NOT NULL CHECK (amount > 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (journal_id, line_no),
    UNIQUE (journal_id, account_id)
);

CREATE INDEX asset_entries_account_idx ON asset_entries (account_id, journal_id);

CREATE TABLE asset_evidence (
    id UUID PRIMARY KEY,
    journal_id UUID REFERENCES asset_journals(id) ON DELETE RESTRICT,
    effect_key VARCHAR(180) NOT NULL,
    evidence_hash CHAR(64) NOT NULL CHECK (evidence_hash ~ '^[0-9a-f]{64}$'),
    order_id UUID REFERENCES order_intents(id) ON DELETE RESTRICT,
    action_id UUID,
    cluster VARCHAR(32) NOT NULL CHECK (cluster IN ('mainnet-beta', 'devnet', 'testnet', 'localnet')),
    wallet_address VARCHAR(64) NOT NULL CHECK (wallet_address ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
    mint VARCHAR(64) CHECK (mint ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
    source VARCHAR(12) NOT NULL CHECK (source IN ('provider', 'chain')),
    source_key VARCHAR(220) NOT NULL,
    raw_state VARCHAR(80),
    commitment VARCHAR(10) CHECK (commitment IN ('processed', 'confirmed', 'finalized')),
    signature VARCHAR(128) CHECK (signature ~ '^[1-9A-HJ-NP-Za-km-z]{64,88}$'),
    slot BIGINT CHECK (slot BETWEEN 0 AND 9007199254740991),
    instruction_index INTEGER CHECK (instruction_index >= 0),
    event_index INTEGER CHECK (event_index >= 0),
    payload_hash CHAR(64) NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
    source_at TIMESTAMPTZ,
    observed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (source, cluster, source_key),
    CHECK (source <> 'chain' OR (signature IS NOT NULL AND slot IS NOT NULL AND commitment IS NOT NULL))
);

CREATE INDEX asset_evidence_journal_idx ON asset_evidence (journal_id, source, commitment)
    WHERE journal_id IS NOT NULL;
CREATE INDEX asset_evidence_effect_idx ON asset_evidence (effect_key, observed_at, id);

CREATE TABLE asset_obligations (
    id UUID PRIMARY KEY,
    obligation_key VARCHAR(180) NOT NULL UNIQUE,
    req_hash CHAR(64) NOT NULL CHECK (req_hash ~ '^[0-9a-f]{64}$'),
    order_id UUID REFERENCES order_intents(id) ON DELETE RESTRICT,
    action_id UUID,
    cluster VARCHAR(32) NOT NULL CHECK (cluster IN ('mainnet-beta', 'devnet', 'testnet', 'localnet')),
    wallet_address VARCHAR(64) NOT NULL CHECK (wallet_address ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
    vault_address VARCHAR(64) CHECK (vault_address ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
    mint VARCHAR(64) NOT NULL CHECK (mint ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
    kind VARCHAR(24) NOT NULL CHECK (kind IN (
        'deposit_unknown', 'provider_missing', 'fill_unverified', 'return_due',
        'withdraw_unknown', 'evidence_conflict', 'deficit'
    )),
    state VARCHAR(8) NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'review', 'cleared')),
    amount sol_u64,
    blocks_actions BOOLEAN NOT NULL DEFAULT TRUE,
    open_evidence_id UUID REFERENCES asset_evidence(id) ON DELETE RESTRICT,
    clear_evidence_id UUID REFERENCES asset_evidence(id) ON DELETE RESTRICT,
    clear_journal_id UUID REFERENCES asset_journals(id) ON DELETE RESTRICT,
    reason VARCHAR(500) NOT NULL,
    opened_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    review_at TIMESTAMPTZ,
    cleared_at TIMESTAMPTZ,
    CHECK (order_id IS NOT NULL OR action_id IS NOT NULL OR open_evidence_id IS NOT NULL),
    CHECK (
        (state = 'cleared' AND cleared_at IS NOT NULL
            AND num_nonnulls(clear_evidence_id, clear_journal_id) = 1)
        OR
        (state <> 'cleared' AND cleared_at IS NULL
            AND num_nonnulls(clear_evidence_id, clear_journal_id) = 0)
    )
);

CREATE UNIQUE INDEX asset_obligations_open_ev_idx ON asset_obligations (open_evidence_id)
    WHERE open_evidence_id IS NOT NULL;
CREATE UNIQUE INDEX asset_obligations_clear_ev_idx ON asset_obligations (clear_evidence_id)
    WHERE clear_evidence_id IS NOT NULL;
CREATE UNIQUE INDEX asset_obligations_clear_journal_idx ON asset_obligations (clear_journal_id)
    WHERE clear_journal_id IS NOT NULL;
CREATE INDEX asset_obligations_active_idx ON asset_obligations
    (cluster, wallet_address, vault_address, mint, order_id, opened_at, id)
    WHERE state IN ('open', 'review');

CREATE FUNCTION asset_account_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.order_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM order_intents
         WHERE id = NEW.order_id AND wallet_address = NEW.wallet_address
    ) THEN
        RAISE EXCEPTION 'asset account order does not belong to its wallet' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER asset_account_insert_guard
    BEFORE INSERT ON asset_accounts
    FOR EACH ROW EXECUTE FUNCTION asset_account_guard();

CREATE FUNCTION asset_deny_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER asset_accounts_immutable
    BEFORE UPDATE OR DELETE ON asset_accounts
    FOR EACH ROW EXECUTE FUNCTION asset_deny_mutation();
CREATE TRIGGER asset_entries_immutable
    BEFORE UPDATE OR DELETE ON asset_entries
    FOR EACH ROW EXECUTE FUNCTION asset_deny_mutation();
CREATE TRIGGER asset_evidence_immutable
    BEFORE UPDATE OR DELETE ON asset_evidence
    FOR EACH ROW EXECUTE FUNCTION asset_deny_mutation();

CREATE FUNCTION asset_entry_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    current_state VARCHAR(8);
BEGIN
    SELECT post_state INTO current_state FROM asset_journals WHERE id = NEW.journal_id;
    IF current_state IS DISTINCT FROM 'draft' THEN
        RAISE EXCEPTION 'entries may only be added to a draft journal' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER asset_entry_insert_guard
    BEFORE INSERT ON asset_entries
    FOR EACH ROW EXECUTE FUNCTION asset_entry_guard();

CREATE FUNCTION asset_lock_accounts() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    PERFORM 1
      FROM asset_accounts account
      JOIN (SELECT DISTINCT account_id FROM inserted_entries) inserted
        ON inserted.account_id = account.id
      ORDER BY account.id
      FOR UPDATE OF account;
    RETURN NULL;
END;
$$;

CREATE TRIGGER asset_entry_account_lock
    AFTER INSERT ON asset_entries
    REFERENCING NEW TABLE AS inserted_entries
    FOR EACH STATEMENT EXECUTE FUNCTION asset_lock_accounts();

CREATE FUNCTION asset_evidence_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    journal asset_journals%ROWTYPE;
BEGIN
    IF NEW.order_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM order_intents
         WHERE id = NEW.order_id AND wallet_address = NEW.wallet_address
    ) THEN
        RAISE EXCEPTION 'asset evidence order does not belong to its wallet' USING ERRCODE = '23514';
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
    ) THEN
        RAISE EXCEPTION 'evidence mint is absent from its journal' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER asset_evidence_insert_guard
    BEFORE INSERT ON asset_evidence
    FOR EACH ROW EXECUTE FUNCTION asset_evidence_guard();

CREATE FUNCTION asset_assert_journal(target UUID) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
    journal asset_journals%ROWTYPE;
    line_count INTEGER;
BEGIN
    SELECT * INTO journal FROM asset_journals WHERE id = target;
    IF NOT FOUND OR journal.post_state <> 'posted' THEN
        RAISE EXCEPTION 'journal % was not posted atomically', target USING ERRCODE = '23514';
    END IF;

    IF journal.order_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM order_intents
         WHERE id = journal.order_id AND wallet_address = journal.wallet_address
    ) THEN
        RAISE EXCEPTION 'journal order does not belong to its wallet' USING ERRCODE = '23514';
    END IF;

    SELECT count(*) INTO line_count FROM asset_entries WHERE journal_id = target;
    IF line_count < 2 OR line_count > 64 THEN
        RAISE EXCEPTION 'journal % must contain 2 to 64 entries', target USING ERRCODE = '23514';
    END IF;

    IF EXISTS (
        SELECT 1
          FROM asset_entries entry
          JOIN asset_accounts account ON account.id = entry.account_id
         WHERE entry.journal_id = target
           AND (account.cluster <> journal.cluster
             OR account.wallet_address <> journal.wallet_address
             OR (account.order_id IS NOT NULL AND account.order_id IS DISTINCT FROM journal.order_id))
    ) THEN
        RAISE EXCEPTION 'journal % crosses its wallet, cluster, or order attribution', target
            USING ERRCODE = '23514';
    END IF;

    IF (
        SELECT count(DISTINCT account.vault_address)
          FROM asset_entries entry
          JOIN asset_accounts account ON account.id = entry.account_id
         WHERE entry.journal_id = target AND account.vault_address IS NOT NULL
    ) > 1 THEN
        RAISE EXCEPTION 'journal % crosses physical vaults', target USING ERRCODE = '23514';
    END IF;

    IF EXISTS (
        SELECT account.mint
          FROM asset_entries entry
          JOIN asset_accounts account ON account.id = entry.account_id
         WHERE entry.journal_id = target
         GROUP BY account.mint
        HAVING sum(CASE entry.side WHEN 'debit' THEN entry.amount ELSE -entry.amount END) <> 0
    ) THEN
        RAISE EXCEPTION 'journal % is not balanced for every mint', target USING ERRCODE = '23514';
    END IF;

    IF journal.kind = 'reversal' THEN
        IF NOT EXISTS (
            SELECT 1 FROM asset_journals original
             WHERE original.id = journal.reversal_of
               AND original.cluster = journal.cluster
               AND original.wallet_address = journal.wallet_address
               AND original.order_id IS NOT DISTINCT FROM journal.order_id
        ) THEN
            RAISE EXCEPTION 'reversal journal % crosses its source identity', target
                USING ERRCODE = '23514';
        END IF;
        IF EXISTS (
            WITH original AS (
                SELECT account_id,
                       sum(CASE side WHEN 'debit' THEN amount ELSE -amount END) AS delta
                  FROM asset_entries WHERE journal_id = journal.reversal_of GROUP BY account_id
            ), correction AS (
                SELECT account_id,
                       sum(CASE side WHEN 'debit' THEN amount ELSE -amount END) AS delta
                  FROM asset_entries WHERE journal_id = target GROUP BY account_id
            )
            SELECT 1 FROM original
            FULL JOIN correction USING (account_id)
            WHERE coalesce(original.delta, 0) + coalesce(correction.delta, 0) <> 0
        ) THEN
            RAISE EXCEPTION 'reversal journal % does not exactly negate its source', target
                USING ERRCODE = '23514';
        END IF;
    END IF;

    IF journal.state IN ('confirmed', 'finalized') AND NOT EXISTS (
        SELECT 1 FROM asset_evidence evidence
         WHERE evidence.journal_id = target AND evidence.source = 'chain'
           AND (journal.state = 'confirmed' AND evidence.commitment IN ('confirmed', 'finalized')
             OR journal.state = 'finalized' AND evidence.commitment = 'finalized')
    ) THEN
        RAISE EXCEPTION 'journal % lacks independent chain evidence for state %', target, journal.state
            USING ERRCODE = '23514';
    END IF;

    IF journal.state = 'reversed' AND NOT EXISTS (
        SELECT 1 FROM asset_journals reversal
         WHERE reversal.reversal_of = target AND reversal.post_state = 'posted'
           AND reversal.state IN ('confirmed', 'finalized', 'reversed')
    ) THEN
        RAISE EXCEPTION 'journal % is reversed without a confirmed reversal', target
            USING ERRCODE = '23514';
    END IF;

    IF journal.state IN ('confirmed', 'finalized', 'reversed') AND EXISTS (
        WITH affected AS (
            SELECT DISTINCT account_id FROM asset_entries WHERE journal_id = target
        )
        SELECT account.id
          FROM affected
          JOIN asset_accounts account ON account.id = affected.account_id
          JOIN asset_entries entry ON entry.account_id = account.id
          JOIN asset_journals posted ON posted.id = entry.journal_id
         WHERE account.scope = 'vault_attr' AND posted.post_state = 'posted'
           AND posted.state IN ('confirmed', 'finalized', 'reversed')
         GROUP BY account.id
        HAVING sum(CASE entry.side WHEN 'debit' THEN entry.amount ELSE -entry.amount END) < 0
    ) THEN
        RAISE EXCEPTION 'confirmed order vault attribution cannot be negative' USING ERRCODE = '23514';
    END IF;
END;
$$;

CREATE FUNCTION asset_journal_guard() RETURNS trigger
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
        SELECT 1 FROM asset_obligations
         WHERE clear_journal_id = OLD.id AND state = 'cleared'
    ) THEN
        RAISE EXCEPTION 'a journal used to clear an obligation cannot be reversed'
            USING ERRCODE = '23514';
    END IF;
    NEW.state_at := CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$;

CREATE TRIGGER asset_journal_update_guard
    BEFORE UPDATE OR DELETE ON asset_journals
    FOR EACH ROW EXECUTE FUNCTION asset_journal_guard();

CREATE FUNCTION set_asset_journal_state(target UUID, state_name VARCHAR) RETURNS BOOLEAN
LANGUAGE plpgsql AS $$
DECLARE
    changed BOOLEAN;
BEGIN
    PERFORM 1
      FROM asset_accounts account
      JOIN asset_entries entry ON entry.account_id = account.id
     WHERE entry.journal_id = target
     ORDER BY account.id
     FOR UPDATE OF account;

    UPDATE asset_journals
       SET state = state_name
     WHERE id = target AND post_state = 'posted'
       AND (
         (state = 'claimed' AND state_name IN ('confirmed', 'finalized'))
         OR (state = 'confirmed' AND state_name IN ('finalized', 'reversed'))
         OR (state = 'finalized' AND state_name = 'reversed')
       );
    changed := FOUND;
    IF changed THEN
        PERFORM asset_assert_journal(target);
    END IF;
    RETURN changed;
END;
$$;

CREATE FUNCTION asset_journal_check() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    PERFORM asset_assert_journal(NEW.id);
    RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER asset_journal_balanced
    AFTER INSERT OR UPDATE ON asset_journals
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION asset_journal_check();

CREATE FUNCTION post_asset_journal(document JSONB) RETURNS UUID
LANGUAGE plpgsql AS $$
DECLARE
    target_id UUID := (document->>'id')::uuid;
    existing asset_journals%ROWTYPE;
BEGIN
    IF jsonb_typeof(document->'entries') <> 'array'
        OR jsonb_array_length(document->'entries') NOT BETWEEN 2 AND 64 THEN
        RAISE EXCEPTION 'journal entries must be an array with 2 to 64 lines' USING ERRCODE = '22023';
    END IF;

    INSERT INTO asset_journals (
        id, effect_key, req_hash, cluster, wallet_address, order_id, leg_id, action_id,
        kind, reversal_of, metadata, occurred_at
    ) VALUES (
        target_id, document->>'effectKey', document->>'reqHash', document->>'cluster',
        document->>'walletAddress', nullif(document->>'orderId', '')::uuid,
        nullif(document->>'legId', '')::uuid, nullif(document->>'actionId', '')::uuid,
        document->>'kind', nullif(document->>'reversalOf', '')::uuid,
        coalesce(document->'metadata', '{}'::jsonb), (document->>'occurredAt')::timestamptz
    )
    ON CONFLICT (effect_key) DO NOTHING;

    IF NOT FOUND THEN
        SELECT * INTO existing FROM asset_journals WHERE effect_key = document->>'effectKey';
        IF existing.req_hash <> document->>'reqHash' OR existing.post_state <> 'posted' THEN
            RAISE EXCEPTION 'effect key conflicts with another journal request' USING ERRCODE = '23505';
        END IF;
        RETURN existing.id;
    END IF;

    INSERT INTO asset_entries (journal_id, line_no, account_id, side, amount)
    SELECT target_id, line."lineNo", line."accountId", line.side, line.amount::sol_u64
      FROM jsonb_to_recordset(document->'entries') AS line(
          "lineNo" SMALLINT,
          "accountId" UUID,
          side VARCHAR(6),
          amount NUMERIC
      );

    UPDATE asset_journals
       SET post_state = 'posted', posted_at = CURRENT_TIMESTAMP
     WHERE id = target_id;
    PERFORM asset_assert_journal(target_id);
    RETURN target_id;
END;
$$;

CREATE FUNCTION asset_obligation_guard() RETURNS trigger
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
        SELECT journal.state INTO clearing_state
          FROM asset_journals journal
         WHERE journal.id = NEW.clear_journal_id AND journal.post_state = 'posted'
           AND journal.cluster = NEW.cluster
           AND journal.wallet_address = NEW.wallet_address
           AND (NEW.order_id IS NULL OR journal.order_id = NEW.order_id)
           AND (NEW.order_id IS NOT NULL OR NEW.action_id IS NULL OR journal.action_id = NEW.action_id)
           AND EXISTS (
               SELECT 1
                 FROM asset_entries entry
                 JOIN asset_accounts account ON account.id = entry.account_id
                WHERE entry.journal_id = journal.id AND account.mint = NEW.mint
           );
        IF clearing_state NOT IN ('confirmed', 'finalized') THEN
            RAISE EXCEPTION 'clearing journal is not independently confirmed' USING ERRCODE = '23514';
        END IF;
    ELSIF NOT EXISTS (
        SELECT 1 FROM asset_evidence evidence
         WHERE evidence.id = NEW.clear_evidence_id AND evidence.source = 'chain'
           AND evidence.commitment IN ('confirmed', 'finalized')
           AND evidence.cluster = NEW.cluster
           AND evidence.wallet_address = NEW.wallet_address
           AND evidence.mint = NEW.mint
           AND (NEW.order_id IS NULL OR evidence.order_id = NEW.order_id)
           AND (NEW.order_id IS NOT NULL OR NEW.action_id IS NULL OR evidence.action_id = NEW.action_id)
    ) THEN
        RAISE EXCEPTION 'clearing evidence is not independently confirmed' USING ERRCODE = '23514';
    END IF;
    NEW.cleared_at := coalesce(NEW.cleared_at, CURRENT_TIMESTAMP);
    RETURN NEW;
END;
$$;

CREATE TRIGGER asset_obligation_write_guard
    BEFORE INSERT OR UPDATE OR DELETE ON asset_obligations
    FOR EACH ROW EXECUTE FUNCTION asset_obligation_guard();

CREATE VIEW asset_balances AS
SELECT account.id AS account_id,
       account.cluster,
       account.wallet_address,
       account.vault_address,
       account.order_id,
       account.mint,
       account.scope,
       coalesce(sum(CASE WHEN journal.state IN ('confirmed', 'finalized', 'reversed')
                         THEN CASE entry.side WHEN 'debit' THEN entry.amount ELSE -entry.amount END
                         ELSE 0 END), 0) AS confirmed_amount,
       coalesce(sum(CASE WHEN journal.state = 'claimed'
                         THEN CASE entry.side WHEN 'debit' THEN entry.amount ELSE -entry.amount END
                         ELSE 0 END), 0) AS claimed_delta,
       count(*) FILTER (WHERE journal.post_state = 'posted') AS entry_count,
       max(journal.occurred_at) FILTER (WHERE journal.post_state = 'posted') AS last_entry_at
  FROM asset_accounts account
  LEFT JOIN asset_entries entry ON entry.account_id = account.id
  LEFT JOIN asset_journals journal ON journal.id = entry.journal_id AND journal.post_state = 'posted'
 GROUP BY account.id;

CREATE VIEW asset_circuits AS
SELECT id AS obligation_id, order_id, action_id, cluster, wallet_address, vault_address,
       mint, kind, state, amount, reason, opened_at
  FROM asset_obligations
 WHERE state IN ('open', 'review') AND blocks_actions = TRUE;

COMMENT ON TABLE asset_journals IS 'Balanced custody journal; lifecycle events remain in order_events';
COMMENT ON COLUMN asset_accounts.scope IS 'vault_attr is a local order attribution inside a shared provider vault';
COMMENT ON VIEW asset_balances IS 'Rebuildable projection; journals, entries, evidence, and obligations remain authoritative';
