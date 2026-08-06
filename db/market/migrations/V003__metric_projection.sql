-- Durable, per-token serialized metric projection and rebuildable Redis fanout.
-- stride: destructive-review=metric-event-retention-v3

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';
SET LOCAL idle_in_transaction_session_timeout = '60s';
SET LOCAL search_path = public;

CREATE TABLE market_metric_rollups (
    token_mint VARCHAR(64) PRIMARY KEY,
    revision BIGINT NOT NULL DEFAULT 0 CHECK (revision >= 0),
    rollup JSONB NOT NULL CHECK (jsonb_typeof(rollup) = 'object'),
    latest_state JSONB CHECK (latest_state IS NULL OR jsonb_typeof(latest_state) = 'object'),
    latest_observed_at TIMESTAMPTZ,
    latest_slot BIGINT CHECK (latest_slot IS NULL OR latest_slot >= 0),
    latest_event_key CHAR(64) CHECK (
        latest_event_key IS NULL OR latest_event_key ~ '^[0-9a-f]{64}$'
    ),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE market_metric_events (
    event_key CHAR(64) PRIMARY KEY CHECK (event_key ~ '^[0-9a-f]{64}$'),
    input_hash CHAR(64) NOT NULL CHECK (input_hash ~ '^[0-9a-f]{64}$'),
    token_mint VARCHAR(64) NOT NULL,
    source_event_id VARCHAR(180) NOT NULL,
    slot BIGINT CHECK (slot IS NULL OR slot >= 0),
    observed_at TIMESTAMPTZ NOT NULL,
    revision BIGINT NOT NULL CHECK (revision > 0),
    state JSONB NOT NULL CHECK (jsonb_typeof(state) = 'object'),
    usd_value NUMERIC NOT NULL CHECK (usd_value > 0),
    base_amount NUMERIC CHECK (base_amount IS NULL OR (base_amount = trunc(base_amount) AND base_amount > 0)),
    swap_type VARCHAR(4) NOT NULL CHECK (swap_type IN ('buy', 'sell')),
    committed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    published_at TIMESTAMPTZ
) PARTITION BY HASH (event_key);

DO $partitions$
BEGIN
    FOR part IN 0..15 LOOP
        EXECUTE format(
            'CREATE TABLE market_metric_events_p%s PARTITION OF market_metric_events '
            'FOR VALUES WITH (MODULUS 16, REMAINDER %s)',
            part,
            part
        );
    END LOOP;
END
$partitions$;

CREATE INDEX market_metric_events_token_idx
    ON market_metric_events (token_mint, observed_at DESC);
CREATE INDEX market_metric_events_pending_idx
    ON market_metric_events (committed_at)
    WHERE published_at IS NULL;
CREATE INDEX market_metric_events_time_brin
    ON market_metric_events USING BRIN (committed_at);

CREATE TABLE market_metric_bootstrap (
    id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    status VARCHAR(12) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'complete')),
    horizon_start TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp() - INTERVAL '24 hours',
    cutoff_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    cursor_at TIMESTAMPTZ,
    cursor_key VARCHAR(64),
    lease_token UUID,
    lease_owner VARCHAR(120),
    lease_until TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CHECK (
        (status = 'running' AND lease_token IS NOT NULL AND lease_owner IS NOT NULL AND lease_until IS NOT NULL)
        OR (status <> 'running' AND lease_token IS NULL AND lease_owner IS NULL AND lease_until IS NULL)
    )
);

INSERT INTO market_metric_bootstrap (id) VALUES (1);

COMMENT ON TABLE market_metric_rollups IS
    'Durable bounded rolling state; the row lock is the ordered owner for one token';
COMMENT ON TABLE market_metric_events IS
    'Hash-partitioned metric states and compact tick basis retained for crash-safe fanout';
COMMENT ON TABLE market_metric_bootstrap IS
    'Leased 24-hour legacy trade replay gate that must complete before live metric consumption';
