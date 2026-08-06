-- Immutable wallet facts and rebuildable FIFO/portfolio projections belong on
-- the write-heavy market plane; user subscriptions remain on the core plane.
-- stride: destructive-review=wallet-ledger-guard-v4

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';
SET LOCAL idle_in_transaction_session_timeout = '60s';
SET LOCAL search_path = public;

CREATE TABLE wallet_events (
    source_id UUID NOT NULL,
    event_key CHAR(64) NOT NULL CHECK (event_key ~ '^[0-9a-f]{64}$'),
    input_hash CHAR(64) NOT NULL CHECK (input_hash ~ '^[0-9a-f]{64}$'),
    wallet_address VARCHAR(44) NOT NULL,
    kind VARCHAR(24) NOT NULL CHECK (kind IN ('swap', 'transfer_in', 'transfer_out')),
    token_mint VARCHAR(64) NOT NULL,
    token_decimals SMALLINT NOT NULL CHECK (token_decimals BETWEEN 0 AND 255),
    side VARCHAR(8) NOT NULL CHECK (side IN ('buy', 'sell')),
    quantity_base NUMERIC NOT NULL CHECK (
        quantity_base = trunc(quantity_base)
        AND quantity_base BETWEEN 1 AND 18446744073709551615
    ),
    value_micro_usd NUMERIC CHECK (
        value_micro_usd IS NULL
        OR (value_micro_usd = trunc(value_micro_usd) AND value_micro_usd >= 0 AND value_micro_usd < 1e78::numeric)
    ),
    signature VARCHAR(128) NOT NULL,
    slot BIGINT CHECK (slot IS NULL OR slot >= 0),
    tx_index INTEGER CHECK (tx_index IS NULL OR tx_index >= 0),
    event_index INTEGER NOT NULL CHECK (event_index >= 0),
    provider VARCHAR(32) NOT NULL,
    commitment VARCHAR(10) CHECK (commitment IS NULL OR commitment IN ('confirmed', 'finalized')),
    raw_summary JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(raw_summary) = 'object'),
    occurred_at TIMESTAMPTZ NOT NULL,
    received_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (source_id, event_key),
    UNIQUE (source_id, signature, event_index, token_mint, side)
) PARTITION BY HASH (source_id);

DO $partitions$
BEGIN
    FOR part IN 0..15 LOOP
        EXECUTE format(
            'CREATE TABLE wallet_events_p%s PARTITION OF wallet_events '
            'FOR VALUES WITH (MODULUS 16, REMAINDER %s)',
            part,
            part
        );
    END LOOP;
END
$partitions$;

CREATE INDEX wallet_events_source_time_idx
    ON wallet_events (source_id, occurred_at DESC, event_key);
CREATE INDEX wallet_events_signature_idx
    ON wallet_events (signature, source_id);
CREATE INDEX wallet_events_time_brin
    ON wallet_events USING BRIN (occurred_at);

CREATE TABLE wallet_event_fanout (
    source_id UUID NOT NULL,
    event_key CHAR(64) NOT NULL,
    payload JSONB NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    last_error TEXT,
    published_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (source_id, event_key),
    FOREIGN KEY (source_id, event_key)
        REFERENCES wallet_events (source_id, event_key) ON DELETE CASCADE
);

CREATE INDEX wallet_event_fanout_pending_idx
    ON wallet_event_fanout (created_at)
    WHERE published_at IS NULL;

CREATE TABLE wallet_position_state (
    source_id UUID NOT NULL,
    token_mint VARCHAR(64) NOT NULL,
    token_decimals SMALLINT NOT NULL CHECK (token_decimals BETWEEN 0 AND 255),
    quantity_base NUMERIC NOT NULL DEFAULT 0 CHECK (quantity_base = trunc(quantity_base) AND quantity_base >= 0),
    cost_micro_usd NUMERIC NOT NULL DEFAULT 0 CHECK (cost_micro_usd = trunc(cost_micro_usd) AND cost_micro_usd >= 0),
    unknown_cost_base NUMERIC NOT NULL DEFAULT 0 CHECK (unknown_cost_base = trunc(unknown_cost_base) AND unknown_cost_base >= 0),
    realized_pnl_micro_usd NUMERIC NOT NULL DEFAULT 0 CHECK (realized_pnl_micro_usd = trunc(realized_pnl_micro_usd)),
    unresolved_sold_base NUMERIC NOT NULL DEFAULT 0 CHECK (unresolved_sold_base = trunc(unresolved_sold_base) AND unresolved_sold_base >= 0),
    untracked_sold_base NUMERIC NOT NULL DEFAULT 0 CHECK (untracked_sold_base = trunc(untracked_sold_base) AND untracked_sold_base >= 0),
    next_lot_seq BIGINT NOT NULL DEFAULT 1 CHECK (next_lot_seq > 0),
    revision BIGINT NOT NULL DEFAULT 0 CHECK (revision >= 0),
    last_event_key CHAR(64) NOT NULL CHECK (last_event_key ~ '^[0-9a-f]{64}$'),
    last_activity_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (source_id, token_mint),
    CHECK (unknown_cost_base <= quantity_base)
);

CREATE TABLE wallet_position_lots (
    source_id UUID NOT NULL,
    token_mint VARCHAR(64) NOT NULL,
    lot_seq BIGINT NOT NULL CHECK (lot_seq > 0),
    open_event_key CHAR(64) NOT NULL CHECK (open_event_key ~ '^[0-9a-f]{64}$'),
    remaining_base NUMERIC NOT NULL CHECK (remaining_base = trunc(remaining_base) AND remaining_base > 0),
    remaining_cost_micro_usd NUMERIC CHECK (
        remaining_cost_micro_usd IS NULL
        OR (remaining_cost_micro_usd = trunc(remaining_cost_micro_usd) AND remaining_cost_micro_usd >= 0)
    ),
    acquired_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (source_id, token_mint, lot_seq),
    UNIQUE (source_id, open_event_key),
    FOREIGN KEY (source_id, token_mint)
        REFERENCES wallet_position_state (source_id, token_mint) ON DELETE CASCADE
);

CREATE TABLE wallet_pnl_events (
    source_id UUID NOT NULL,
    event_key CHAR(64) NOT NULL CHECK (event_key ~ '^[0-9a-f]{64}$'),
    token_mint VARCHAR(64) NOT NULL,
    sold_base NUMERIC NOT NULL CHECK (sold_base = trunc(sold_base) AND sold_base > 0),
    known_cost_base NUMERIC NOT NULL CHECK (known_cost_base = trunc(known_cost_base) AND known_cost_base >= 0),
    unknown_cost_base NUMERIC NOT NULL CHECK (unknown_cost_base = trunc(unknown_cost_base) AND unknown_cost_base >= 0),
    proceeds_micro_usd NUMERIC CHECK (proceeds_micro_usd IS NULL OR proceeds_micro_usd = trunc(proceeds_micro_usd)),
    consumed_cost_micro_usd NUMERIC NOT NULL CHECK (consumed_cost_micro_usd = trunc(consumed_cost_micro_usd) AND consumed_cost_micro_usd >= 0),
    realized_pnl_micro_usd NUMERIC CHECK (realized_pnl_micro_usd IS NULL OR realized_pnl_micro_usd = trunc(realized_pnl_micro_usd)),
    occurred_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (source_id, event_key)
);

CREATE INDEX wallet_pnl_source_time_idx
    ON wallet_pnl_events (source_id, occurred_at DESC);

CREATE TABLE wallet_projection_state (
    source_id UUID PRIMARY KEY,
    revision BIGINT NOT NULL DEFAULT 0 CHECK (revision >= 0),
    event_count BIGINT NOT NULL DEFAULT 0 CHECK (event_count >= 0),
    last_event_key CHAR(64),
    last_occurred_at TIMESTAMPTZ,
    rebuilt_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE wallet_portfolio_points (
    source_id UUID NOT NULL,
    bucket_at TIMESTAMPTZ NOT NULL,
    observed_at TIMESTAMPTZ NOT NULL,
    event_key CHAR(64) NOT NULL CHECK (event_key ~ '^[0-9a-f]{64}$'),
    revision BIGINT NOT NULL CHECK (revision > 0),
    market_value_micro_usd NUMERIC NOT NULL CHECK (market_value_micro_usd = trunc(market_value_micro_usd) AND market_value_micro_usd >= 0),
    cost_micro_usd NUMERIC NOT NULL CHECK (cost_micro_usd = trunc(cost_micro_usd) AND cost_micro_usd >= 0),
    realized_pnl_micro_usd NUMERIC NOT NULL CHECK (realized_pnl_micro_usd = trunc(realized_pnl_micro_usd)),
    unknown_cost_base NUMERIC NOT NULL CHECK (unknown_cost_base = trunc(unknown_cost_base) AND unknown_cost_base >= 0),
    unresolved_sold_base NUMERIC NOT NULL CHECK (unresolved_sold_base = trunc(unresolved_sold_base) AND unresolved_sold_base >= 0),
    untracked_sold_base NUMERIC NOT NULL CHECK (untracked_sold_base = trunc(untracked_sold_base) AND untracked_sold_base >= 0),
    pnl_complete BOOLEAN NOT NULL,
    priced_assets INTEGER NOT NULL CHECK (priced_assets >= 0),
    unpriced_assets INTEGER NOT NULL CHECK (unpriced_assets >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (source_id, bucket_at)
);

CREATE INDEX wallet_portfolio_time_idx
    ON wallet_portfolio_points (source_id, bucket_at DESC);

CREATE FUNCTION wallet_event_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
    RAISE EXCEPTION 'wallet events are append-only' USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER wallet_events_guard
    BEFORE UPDATE OR DELETE ON wallet_events
    FOR EACH ROW EXECUTE FUNCTION wallet_event_guard();

REVOKE ALL ON FUNCTION wallet_event_guard() FROM PUBLIC;

COMMENT ON TABLE wallet_events IS
    'Hash-partitioned immutable wallet facts; projections can be deleted and rebuilt from this ledger';
COMMENT ON COLUMN wallet_position_state.unknown_cost_base IS
    'Open quantity received without a defensible USD acquisition cost';
COMMENT ON TABLE wallet_portfolio_points IS
    'One-minute portfolio marks with explicit priced/unpriced asset coverage';
