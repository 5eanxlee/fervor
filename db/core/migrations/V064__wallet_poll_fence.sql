-- Claim wallet history work with a durable generation so overlapping shards
-- cannot advance or regress the same provider checkpoint.
-- stride: destructive-review=wallet-projection-cutover-v64

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';
SET LOCAL idle_in_transaction_session_timeout = '60s';
SET LOCAL search_path = public;

ALTER TABLE wallet_sources
    ADD COLUMN projection_version SMALLINT,
    ADD COLUMN poll_seq BIGINT NOT NULL DEFAULT 0 CHECK (poll_seq >= 0),
    ADD COLUMN lease_token UUID,
    ADD COLUMN lease_owner VARCHAR(120),
    ADD COLUMN lease_until TIMESTAMPTZ,
    ADD COLUMN next_poll_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    ADD COLUMN failure_count INTEGER NOT NULL DEFAULT 0 CHECK (failure_count >= 0),
    ADD COLUMN live_cursor VARCHAR(256),
    ADD COLUMN live_high_signature VARCHAR(128),
    ADD COLUMN live_high_slot BIGINT CHECK (live_high_slot IS NULL OR live_high_slot >= 0),
    ADD CONSTRAINT wallet_source_lease_check CHECK (
        (lease_token IS NULL AND lease_owner IS NULL AND lease_until IS NULL)
        OR
        (lease_token IS NOT NULL AND lease_owner IS NOT NULL AND lease_until IS NOT NULL AND poll_seq > 0)
    );

UPDATE wallet_sources
SET projection_version = 1,
    last_signature = NULL,
    last_slot = NULL,
    backfill_before = NULL,
    backfill_pages = 0,
    backfill_complete = FALSE,
    live_cursor = NULL,
    live_high_signature = NULL,
    live_high_slot = NULL,
    next_poll_at = CURRENT_TIMESTAMP;

ALTER TABLE wallet_sources
    ALTER COLUMN projection_version SET DEFAULT 2,
    ALTER COLUMN projection_version SET NOT NULL,
    ADD CONSTRAINT wallet_projection_version_check CHECK (projection_version IN (1, 2));

CREATE INDEX wallet_sources_due_idx
    ON wallet_sources (next_poll_at, last_polled_at NULLS FIRST, id)
    WHERE status = 'active';

COMMENT ON COLUMN wallet_sources.poll_seq IS
    'Monotonic wallet poll fence; checkpoints only advance under the matching lease';
COMMENT ON COLUMN wallet_sources.live_cursor IS
    'Provider pagination token for a live catch-up range above last_slot';
COMMENT ON COLUMN wallet_sources.projection_version IS
    'Version 1 reads the legacy core projection until the version 2 market replay completes';
