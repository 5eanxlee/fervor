-- Fence alert edits/re-arms and retain the exact metric basis of every match.
-- stride: destructive-review=alert-match-lineage-v62

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';
SET LOCAL idle_in_transaction_session_timeout = '60s';
SET LOCAL search_path = public;

ALTER TABLE token_alerts
    ADD COLUMN generation BIGINT NOT NULL DEFAULT 1 CHECK (generation > 0);

ALTER TABLE alert_events
    ADD COLUMN alert_generation BIGINT NOT NULL DEFAULT 1 CHECK (alert_generation > 0),
    ADD COLUMN source_event_id VARCHAR(180),
    ADD COLUMN signature VARCHAR(128),
    ADD COLUMN slot BIGINT CHECK (slot IS NULL OR slot BETWEEN 0 AND 9007199254740991),
    ADD COLUMN observed_at TIMESTAMPTZ,
    ADD COLUMN received_at TIMESTAMPTZ,
    ADD COLUMN matched_at TIMESTAMPTZ,
    ADD COLUMN engine_version VARCHAR(64),
    ADD COLUMN basis_commitment VARCHAR(10) CHECK (
        basis_commitment IS NULL OR basis_commitment IN ('processed', 'confirmed', 'finalized')
    ),
    ADD COLUMN metric_confidence NUMERIC(5, 4) CHECK (
        metric_confidence IS NULL OR metric_confidence BETWEEN 0 AND 1
    ),
    ADD COLUMN metric_estimated BOOLEAN,
    ADD COLUMN metric_version VARCHAR(32),
    ADD COLUMN metric_revision BIGINT CHECK (metric_revision IS NULL OR metric_revision > 0);

UPDATE alert_events
SET source_event_id = 'legacy:' || id::text,
    observed_at = created_at,
    received_at = created_at,
    matched_at = created_at,
    engine_version = 'legacy',
    metric_confidence = 0,
    metric_estimated = true,
    metric_version = 'legacy'
WHERE source_event_id IS NULL;

ALTER TABLE alert_events
    ALTER COLUMN source_event_id SET NOT NULL,
    ALTER COLUMN observed_at SET NOT NULL,
    ALTER COLUMN received_at SET NOT NULL,
    ALTER COLUMN matched_at SET NOT NULL,
    ALTER COLUMN engine_version SET NOT NULL,
    ALTER COLUMN metric_confidence SET NOT NULL,
    ALTER COLUMN metric_estimated SET NOT NULL,
    ALTER COLUMN metric_version SET NOT NULL;

CREATE INDEX alert_events_source_idx
    ON alert_events (source_event_id, created_at DESC);

COMMENT ON COLUMN token_alerts.generation IS
    'Monotonic alert-definition fence incremented on threshold edits and re-arm';
COMMENT ON COLUMN alert_events.source_event_id IS
    'Exact metric event that caused this alert generation to transition';
