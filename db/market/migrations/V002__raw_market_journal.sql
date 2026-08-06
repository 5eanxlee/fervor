-- Durable, byte-preserving acceptance boundary for the Rust Yellowstone lane.
-- stride: destructive-review=market-raw-journal-v2

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';
SET LOCAL idle_in_transaction_session_timeout = '60s';
SET LOCAL search_path = public;

CREATE TABLE market_raw_events (
    provider VARCHAR(32) NOT NULL,
    commitment VARCHAR(10) NOT NULL
        CHECK (commitment IN ('processed', 'confirmed', 'finalized')),
    source_event_id VARCHAR(180) NOT NULL,
    subscription_id CHAR(64) NOT NULL
        CHECK (subscription_id ~ '^[0-9a-f]{64}$'),
    slot BIGINT NOT NULL CHECK (slot >= 0),
    signature VARCHAR(88) NOT NULL
        CHECK (signature ~ '^[1-9A-HJ-NP-Za-km-z]{64,88}$'),
    filters TEXT[] NOT NULL DEFAULT '{}',
    wire_format VARCHAR(40) NOT NULL
        CHECK (wire_format = 'yellowstone-protobuf-v12'),
    wire_payload BYTEA NOT NULL
        CHECK (octet_length(wire_payload) BETWEEN 1 AND 4194304),
    wire_hash BYTEA NOT NULL CHECK (octet_length(wire_hash) = 32),
    observed_at TIMESTAMPTZ NOT NULL,
    accepted_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (provider, commitment, source_event_id)
) PARTITION BY HASH (provider, commitment, source_event_id);

DO $partitions$
BEGIN
    FOR part IN 0..15 LOOP
        EXECUTE format(
            'CREATE TABLE market_raw_events_p%s PARTITION OF market_raw_events '
            'FOR VALUES WITH (MODULUS 16, REMAINDER %s)',
            part,
            part
        );
    END LOOP;
END
$partitions$;

CREATE INDEX market_raw_events_slot_idx
    ON market_raw_events (slot DESC, source_event_id);
CREATE INDEX market_raw_events_time_idx
    ON market_raw_events (accepted_at);

CREATE TABLE market_ingest_checkpoints (
    provider VARCHAR(32) NOT NULL,
    subscription_id CHAR(64) NOT NULL
        CHECK (subscription_id ~ '^[0-9a-f]{64}$'),
    commitment VARCHAR(10) NOT NULL
        CHECK (commitment IN ('processed', 'confirmed', 'finalized')),
    last_slot BIGINT NOT NULL CHECK (last_slot >= 0),
    last_event_id VARCHAR(180) NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (provider, subscription_id)
);

CREATE FUNCTION market_raw_event_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
    RAISE EXCEPTION 'market raw events are append-only' USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER market_raw_events_guard
    BEFORE UPDATE OR DELETE ON market_raw_events
    FOR EACH ROW EXECUTE FUNCTION market_raw_event_guard();

REVOKE ALL ON FUNCTION market_raw_event_guard() FROM PUBLIC;

COMMENT ON TABLE market_raw_events IS
    'Hash-partitioned immutable protobuf journal accepted before Yellowstone decode or Redis fanout';
COMMENT ON COLUMN market_raw_events.wire_payload IS
    'Protobuf encoding of geyser.SubscribeUpdateTransaction using yellowstone-grpc-proto v12';
COMMENT ON TABLE market_ingest_checkpoints IS
    'Highest durable slot per exact Rust Yellowstone subscription; replay must overlap and deduplicate';
