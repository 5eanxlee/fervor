-- Freeze logical delivery inputs and fence every provider attempt so late
-- responses cannot overwrite a newer retry.
-- stride: destructive-review=notification-attempt-fence-v63

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';
SET LOCAL idle_in_transaction_session_timeout = '60s';
SET LOCAL search_path = public;

ALTER TABLE notification_deliveries
    ADD COLUMN payload JSONB,
    ADD COLUMN payload_hash CHAR(64),
    ADD COLUMN payload_version SMALLINT NOT NULL DEFAULT 0,
    ADD COLUMN claim_seq BIGINT NOT NULL DEFAULT 0,
    ADD COLUMN lease_token UUID,
    ADD COLUMN lease_owner VARCHAR(120),
    ADD COLUMN lease_until TIMESTAMPTZ;

ALTER TABLE notification_deliveries
    DROP CONSTRAINT IF EXISTS notification_deliveries_status_check;

UPDATE notification_deliveries nd
SET status = CASE
        WHEN nd.channel NOT IN ('telegram', 'discord')
             AND nd.status IN ('pending', 'sending', 'retry_scheduled', 'deferred') THEN 'failed'
        WHEN ae.id IS NULL
             AND nd.status IN ('pending', 'sending', 'retry_scheduled', 'deferred') THEN 'dead_lettered'
        WHEN nd.status = 'sending' THEN 'ambiguous'
        WHEN nd.status = 'deferred' THEN 'retry_scheduled'
        ELSE nd.status
    END,
    provider = CASE
        WHEN nd.channel IN ('telegram', 'discord') THEN nd.channel
        ELSE 'retired'
    END,
    payload = CASE
        WHEN nd.channel IN ('telegram', 'discord') AND ae.id IS NOT NULL THEN jsonb_build_object(
            'alert', jsonb_build_object(
                'id', ae.alert_id::text,
                'user_id', ae.user_id::text,
                'token_address', ae.token_address,
                'token_name', ta.token_name,
                'token_symbol', ta.token_symbol,
                'threshold_type', ae.threshold_type,
                'threshold_value', ae.threshold_value,
                'condition', ae.condition,
                'notification_type', ae.notification_type,
                'is_active', false,
                'is_triggered', true,
                'generation', ae.alert_generation,
                'created_at', ae.created_at,
                'updated_at', ae.created_at
            ),
            'currentValue', ae.current_value,
            'triggeredAt', ae.created_at
        )
        ELSE jsonb_build_object('version', 0, 'legacy', true)
    END,
    payload_version = CASE
        WHEN nd.channel IN ('telegram', 'discord') AND ae.id IS NOT NULL THEN 1
        ELSE 0
    END,
    claim_seq = attempts,
    lease_token = NULL,
    lease_owner = NULL,
    lease_until = NULL,
    next_attempt_at = CASE
        WHEN nd.status = 'deferred' THEN CURRENT_TIMESTAMP
        ELSE nd.next_attempt_at
    END,
    error_message = CASE
        WHEN nd.channel NOT IN ('telegram', 'discord')
            THEN 'Notification channel retired; only Telegram and Discord are supported'
        WHEN ae.id IS NULL AND nd.status IN ('pending', 'sending', 'retry_scheduled', 'deferred')
            THEN 'Legacy delivery has no durable alert event to reconstruct'
        WHEN nd.status = 'sending'
            THEN 'Legacy provider attempt had an unknown effect at cutover'
        ELSE nd.error_message
    END
FROM alert_events ae
LEFT JOIN token_alerts ta ON ta.id = ae.alert_id
WHERE ae.id = nd.alert_event_id;

UPDATE notification_deliveries nd
SET status = CASE
        WHEN nd.channel NOT IN ('telegram', 'discord') THEN 'failed'
        WHEN nd.status IN ('pending', 'sending', 'retry_scheduled', 'deferred') THEN 'dead_lettered'
        ELSE nd.status
    END,
    provider = CASE WHEN nd.channel IN ('telegram', 'discord') THEN nd.channel ELSE 'retired' END,
    payload = jsonb_build_object('version', 0, 'legacy', true),
    payload_version = 0,
    claim_seq = attempts,
    lease_token = NULL,
    lease_owner = NULL,
    lease_until = NULL,
    error_message = CASE
        WHEN nd.channel NOT IN ('telegram', 'discord')
            THEN 'Notification channel retired; only Telegram and Discord are supported'
        WHEN nd.status IN ('pending', 'sending', 'retry_scheduled', 'deferred')
            THEN 'Legacy delivery has no durable alert event to reconstruct'
        ELSE nd.error_message
    END
WHERE nd.payload IS NULL;

UPDATE notification_deliveries
SET payload_hash = encode(digest(payload::text, 'sha256'), 'hex');

ALTER TABLE notification_deliveries
    ADD CONSTRAINT notification_deliveries_status_check CHECK (
        status IN ('pending', 'sending', 'accepted', 'processed', 'delivered', 'deferred',
                   'retry_scheduled', 'suppressed', 'sent', 'failed', 'dead_lettered', 'ambiguous')
    );

ALTER TABLE notification_deliveries
    ALTER COLUMN provider SET NOT NULL,
    ALTER COLUMN payload SET NOT NULL,
    ALTER COLUMN payload_hash SET NOT NULL,
    ADD CONSTRAINT notification_provider_channel_check CHECK (
        (channel IN ('telegram', 'discord') AND provider = channel)
        OR (channel NOT IN ('telegram', 'discord') AND payload_version = 0 AND provider = 'retired')
    ),
    ADD CONSTRAINT notification_payload_version_check CHECK (payload_version BETWEEN 0 AND 32767),
    ADD CONSTRAINT notification_claim_seq_check CHECK (claim_seq >= 0),
    ADD CONSTRAINT notification_lease_check CHECK (
        (status = 'sending'
            AND lease_token IS NOT NULL
            AND lease_owner IS NOT NULL
            AND lease_until IS NOT NULL
            AND claim_seq > 0)
        OR
        (status <> 'sending'
            AND lease_token IS NULL
            AND lease_owner IS NULL
            AND lease_until IS NULL)
    );

CREATE TABLE notification_attempts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    delivery_id UUID NOT NULL REFERENCES notification_deliveries(id) ON DELETE CASCADE,
    claim_seq BIGINT NOT NULL CHECK (claim_seq > 0),
    lease_token UUID NOT NULL UNIQUE,
    lease_owner VARCHAR(120) NOT NULL,
    provider VARCHAR(32) NOT NULL,
    request_key CHAR(64) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'claimed' CHECK (
        status IN ('claimed', 'accepted', 'retryable', 'permanent', 'expired', 'deferred', 'ambiguous')
    ),
    effect VARCHAR(12) NOT NULL DEFAULT 'none' CHECK (
        effect IN ('none', 'accepted', 'unknown')
    ),
    provider_message_id VARCHAR(255),
    provider_status VARCHAR(64),
    error_code VARCHAR(128),
    error_message TEXT,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    retry_at TIMESTAMPTZ,
    started_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    finished_at TIMESTAMPTZ,
    UNIQUE (delivery_id, claim_seq)
);

CREATE INDEX notification_lease_due_idx
    ON notification_deliveries (lease_until, id)
    WHERE status = 'sending';

CREATE INDEX notification_attempt_delivery_idx
    ON notification_attempts (delivery_id, claim_seq DESC);

UPDATE token_alerts
SET is_active = FALSE, cleared_at = COALESCE(cleared_at, CURRENT_TIMESTAMP)
WHERE notification_type NOT IN ('telegram', 'discord') AND is_active = TRUE;

UPDATE notification_queue
SET status = 'failed', attempts = attempts + 1
WHERE type NOT IN ('telegram', 'discord') AND status = 'pending';

UPDATE user_notification_preferences
SET enabled = FALSE, alert_notifications_enabled = FALSE, updated_at = CURRENT_TIMESTAMP
WHERE channel NOT IN ('telegram', 'discord', 'extension')
  AND (enabled = TRUE OR alert_notifications_enabled = TRUE);

ALTER TABLE notification_deliveries
    ADD CONSTRAINT notification_live_channel_check
    CHECK (channel IN ('telegram', 'discord')) NOT VALID;

ALTER TABLE token_alerts
    ADD CONSTRAINT token_alert_live_channel_check
    CHECK (notification_type IN ('telegram', 'discord')) NOT VALID;

ALTER TABLE notification_queue
    ADD CONSTRAINT notification_queue_live_channel_check
    CHECK (type IN ('telegram', 'discord')) NOT VALID;

ALTER TABLE user_notification_preferences
    ADD CONSTRAINT notification_preference_live_channel_check
    CHECK (channel IN ('telegram', 'discord', 'extension')) NOT VALID;

CREATE OR REPLACE FUNCTION enforce_notification_delivery_freeze()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
    IF OLD.payload_version > 0 AND (
        NEW.alert_event_id IS DISTINCT FROM OLD.alert_event_id
        OR NEW.alert_id IS DISTINCT FROM OLD.alert_id
        OR NEW.channel IS DISTINCT FROM OLD.channel
        OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
        OR NEW.provider IS DISTINCT FROM OLD.provider
        OR NEW.recipient_hash IS DISTINCT FROM OLD.recipient_hash
        OR NEW.locale IS DISTINCT FROM OLD.locale
        OR NEW.timezone IS DISTINCT FROM OLD.timezone
        OR NEW.payload IS DISTINCT FROM OLD.payload
        OR NEW.payload_hash IS DISTINCT FROM OLD.payload_hash
        OR NEW.payload_version IS DISTINCT FROM OLD.payload_version
        OR NEW.max_attempts IS DISTINCT FROM OLD.max_attempts
    ) THEN
        RAISE EXCEPTION 'notification delivery inputs are immutable' USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER notification_delivery_freeze
    BEFORE UPDATE ON notification_deliveries
    FOR EACH ROW EXECUTE FUNCTION enforce_notification_delivery_freeze();

CREATE OR REPLACE FUNCTION enforce_notification_attempt_identity()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
    IF NEW.delivery_id IS DISTINCT FROM OLD.delivery_id
        OR NEW.claim_seq IS DISTINCT FROM OLD.claim_seq
        OR NEW.lease_token IS DISTINCT FROM OLD.lease_token
        OR NEW.lease_owner IS DISTINCT FROM OLD.lease_owner
        OR NEW.provider IS DISTINCT FROM OLD.provider
        OR NEW.request_key IS DISTINCT FROM OLD.request_key THEN
        RAISE EXCEPTION 'notification attempt identity is immutable' USING ERRCODE = '55000';
    END IF;
    IF OLD.status <> 'claimed' THEN
        RAISE EXCEPTION 'notification attempt is terminal' USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER notification_attempt_identity
    BEFORE UPDATE ON notification_attempts
    FOR EACH ROW EXECUTE FUNCTION enforce_notification_attempt_identity();

COMMENT ON COLUMN notification_deliveries.payload IS
    'Immutable rendered-input snapshot used by every retry of this logical delivery';
COMMENT ON COLUMN notification_deliveries.claim_seq IS
    'Monotonic provider-attempt fence; every claim receives a new lease token';
COMMENT ON TABLE notification_attempts IS
    'Append-mostly provider attempt journal including explicit ambiguous effects';
