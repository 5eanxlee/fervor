-- Close correctness gaps found during the first independent review of the
-- normalized order schema. This is forward-only; V015 remains immutable.
-- stride: destructive-review=order-schema-fixes-v16

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';
SET LOCAL idle_in_transaction_session_timeout = '60s';
SET LOCAL search_path = public;

-- Transaction timestamps do not advance while a transaction is paused. Each
-- fence guard therefore samples wall-clock time once and uses that sample for
-- every expiry decision in the call.
CREATE OR REPLACE FUNCTION order_action_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
    now_at TIMESTAMPTZ := clock_timestamp();
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM order_intents order_row
         WHERE order_row.id = NEW.order_id AND order_row.user_id = NEW.user_id
    ) THEN
        RAISE EXCEPTION 'action order does not belong to its user' USING ERRCODE = '23514';
    END IF;
    IF NEW.leg_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM order_legs leg
         WHERE leg.id = NEW.leg_id AND leg.order_id = NEW.order_id
    ) THEN
        RAISE EXCEPTION 'action leg belongs to a different order' USING ERRCODE = '23514';
    END IF;
    IF NEW.parent_action IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM order_actions parent
         WHERE parent.id = NEW.parent_action AND parent.order_id = NEW.order_id
    ) THEN
        RAISE EXCEPTION 'parent action belongs to a different order' USING ERRCODE = '23514';
    END IF;
    IF NEW.lease_owner IS NOT NULL THEN
        PERFORM pg_advisory_xact_lock_shared(hashtextextended(NEW.write_scope, 1937006964));
        IF NEW.write_scope <> concat('provider:', NEW.provider)
            OR NEW.lease_until <= now_at OR NOT EXISTS (
            SELECT 1 FROM order_epoch_current epoch
             WHERE epoch.scope = NEW.write_scope
               AND epoch.epoch = NEW.write_epoch
               AND epoch.mode = 'live'
        ) THEN
            RAISE EXCEPTION 'active action lease requires its current live provider epoch'
                USING ERRCODE = '40001';
        END IF;
    END IF;
    IF TG_OP = 'UPDATE' AND (
        to_jsonb(NEW) - ARRAY[
            'work_state', 'effect_state', 'outcome', 'block_reason', 'provider_req_id',
            'provider_order_id', 'first_signature', 'message_hash', 'recent_blockhash',
            'last_valid_height', 'attempt_count', 'due_at', 'lease_owner', 'lease_gen',
            'lease_until', 'write_scope', 'write_epoch', 'ambiguity_at', 'provider_check_at',
            'chain_check_at', 'error_code', 'error_class', 'error_message', 'http_class',
            'retry_after', 'completed_at', 'action_ver', 'updated_at'
        ]
    ) IS DISTINCT FROM (
        to_jsonb(OLD) - ARRAY[
            'work_state', 'effect_state', 'outcome', 'block_reason', 'provider_req_id',
            'provider_order_id', 'first_signature', 'message_hash', 'recent_blockhash',
            'last_valid_height', 'attempt_count', 'due_at', 'lease_owner', 'lease_gen',
            'lease_until', 'write_scope', 'write_epoch', 'ambiguity_at', 'provider_check_at',
            'chain_check_at', 'error_code', 'error_class', 'error_message', 'http_class',
            'retry_after', 'completed_at', 'action_ver', 'updated_at'
        ]
    ) THEN
        RAISE EXCEPTION 'action identity is immutable' USING ERRCODE = '55000';
    END IF;
    IF TG_OP = 'UPDATE' THEN
        IF NEW.action_ver <> OLD.action_ver + 1 THEN
            RAISE EXCEPTION 'action version must advance by one' USING ERRCODE = '40001';
        END IF;
        IF NEW.attempt_count < OLD.attempt_count OR NEW.attempt_count > OLD.attempt_count + 1 THEN
            RAISE EXCEPTION 'action attempt count must remain stable or advance by one'
                USING ERRCODE = '40001';
        END IF;
        IF (NEW.message_hash IS DISTINCT FROM OLD.message_hash
            OR NEW.first_signature IS DISTINCT FROM OLD.first_signature)
            AND EXISTS (SELECT 1 FROM order_tx_blobs blob WHERE blob.action_id = OLD.id) THEN
            RAISE EXCEPTION 'committed transaction identity cannot change' USING ERRCODE = '55000';
        END IF;
        IF OLD.lease_owner IS NULL AND NEW.lease_owner IS NULL THEN
            IF NEW.lease_gen <> OLD.lease_gen THEN
                RAISE EXCEPTION 'inactive lease generation cannot change' USING ERRCODE = '40001';
            END IF;
        ELSIF OLD.lease_owner IS NULL AND NEW.lease_owner IS NOT NULL THEN
            IF NEW.lease_gen <> OLD.lease_gen + 1 THEN
                RAISE EXCEPTION 'new lease must advance its generation' USING ERRCODE = '40001';
            END IF;
        ELSIF OLD.lease_owner IS NOT NULL AND NEW.lease_owner IS NULL THEN
            IF NEW.lease_gen <> OLD.lease_gen THEN
                RAISE EXCEPTION 'lease release must retain its generation' USING ERRCODE = '40001';
            END IF;
        ELSIF NEW.lease_gen = OLD.lease_gen THEN
            IF OLD.lease_until <= now_at
                OR NEW.lease_owner <> OLD.lease_owner
                OR NEW.write_scope <> OLD.write_scope
                OR NEW.write_epoch <> OLD.write_epoch
                OR NEW.lease_until < OLD.lease_until THEN
                RAISE EXCEPTION 'lease renewal cannot revive or replace an expired fence'
                    USING ERRCODE = '40001';
            END IF;
        ELSIF NEW.lease_gen = OLD.lease_gen + 1 THEN
            IF OLD.lease_until > now_at THEN
                RAISE EXCEPTION 'an unexpired lease cannot be reclaimed' USING ERRCODE = '40001';
            END IF;
        ELSE
            RAISE EXCEPTION 'lease generation must remain stable or advance by one'
                USING ERRCODE = '40001';
        END IF;
        NEW.updated_at := now_at;
    END IF;
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION action_attempt_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
    action order_actions%ROWTYPE;
    now_at TIMESTAMPTZ := clock_timestamp();
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'action_attempts is append-once' USING ERRCODE = '55000';
    END IF;
    IF TG_OP = 'INSERT' THEN
        PERFORM pg_advisory_xact_lock_shared(hashtextextended(NEW.write_scope, 1937006964));
        SELECT * INTO action FROM order_actions WHERE id = NEW.action_id FOR UPDATE;
        IF NOT FOUND OR action.desired_hash <> NEW.desired_hash
            OR action.provider <> NEW.provider
            OR action.lease_gen <> NEW.lease_gen
            OR action.write_scope <> NEW.write_scope
            OR action.write_epoch <> NEW.write_epoch
            OR action.lease_owner IS NULL
            OR action.lease_until <= now_at
            OR action.attempt_count <> NEW.seq
            OR NEW.send_state = 'response_recorded'
            OR (NEW.send_state = 'started' AND (
                action.work_state <> 'dispatching' OR action.effect_state <> 'possible'
            ))
            OR NOT EXISTS (
                SELECT 1 FROM order_epoch_current epoch
                 WHERE epoch.scope = NEW.write_scope
                   AND epoch.epoch = NEW.write_epoch
                   AND epoch.mode = 'live'
            ) THEN
            RAISE EXCEPTION 'attempt does not match the active action fence' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
    END IF;
    IF (to_jsonb(NEW) - ARRAY[
        'send_state', 'started_at', 'completed_at', 'http_status', 'http_class',
        'response_hash', 'provider_effect_id', 'error_code', 'error_message'
    ]) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY[
        'send_state', 'started_at', 'completed_at', 'http_status', 'http_class',
        'response_hash', 'provider_effect_id', 'error_code', 'error_message'
    ]) THEN
        RAISE EXCEPTION 'attempt request identity is immutable' USING ERRCODE = '55000';
    END IF;
    IF NOT ((OLD.send_state = 'prepared' AND NEW.send_state = 'started')
        OR (OLD.send_state = 'started' AND NEW.send_state = 'response_recorded')) THEN
        RAISE EXCEPTION 'invalid attempt fact transition % to %', OLD.send_state, NEW.send_state
            USING ERRCODE = '23514';
    END IF;
    IF OLD.send_state = 'started' AND NEW.started_at IS DISTINCT FROM OLD.started_at THEN
        RAISE EXCEPTION 'attempt start time is immutable after dispatch' USING ERRCODE = '55000';
    END IF;
    IF OLD.send_state = 'prepared' THEN
        PERFORM pg_advisory_xact_lock_shared(hashtextextended(NEW.write_scope, 1937006964));
        SELECT * INTO action FROM order_actions WHERE id = NEW.action_id FOR UPDATE;
        IF NOT FOUND OR action.lease_gen <> NEW.lease_gen
            OR action.write_scope <> NEW.write_scope
            OR action.write_epoch <> NEW.write_epoch
            OR action.lease_owner IS NULL
            OR action.lease_until <= now_at
            OR action.attempt_count <> NEW.seq
            OR action.work_state <> 'dispatching'
            OR action.effect_state <> 'possible'
            OR NOT EXISTS (
                SELECT 1 FROM order_epoch_current epoch
                 WHERE epoch.scope = NEW.write_scope
                   AND epoch.epoch = NEW.write_epoch
                   AND epoch.mode = 'live'
            ) THEN
            RAISE EXCEPTION 'attempt start does not match the active action fence'
                USING ERRCODE = '23514';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION order_blob_read_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
    now_at TIMESTAMPTZ := clock_timestamp();
BEGIN
    PERFORM pg_advisory_xact_lock_shared(hashtextextended(NEW.write_scope, 1937006964));
    PERFORM 1
      FROM action_attempts attempt
      JOIN order_actions action ON action.id = attempt.action_id
      JOIN order_epoch_current epoch
        ON epoch.scope = action.write_scope AND epoch.epoch = action.write_epoch
     WHERE attempt.id = NEW.attempt_id AND attempt.action_id = NEW.action_id
       AND attempt.lease_gen = NEW.lease_gen
       AND attempt.write_scope = NEW.write_scope
       AND attempt.write_epoch = NEW.write_epoch
       AND attempt.send_state = 'started'
       AND action.lease_owner IS NOT NULL
       AND action.lease_gen = NEW.lease_gen
       AND action.lease_until > now_at
       AND action.write_scope = NEW.write_scope
       AND action.write_epoch = NEW.write_epoch
       AND epoch.mode = 'live'
     FOR SHARE OF action;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'blob access does not match its active outbound attempt'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER order_sync_cursors_guard ON order_sync_cursors;

CREATE OR REPLACE FUNCTION order_sync_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
    now_at TIMESTAMPTZ := clock_timestamp();
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'sync cursors cannot be deleted' USING ERRCODE = '55000';
    END IF;
    IF TG_OP = 'INSERT' THEN
        IF NEW.version <> 0 OR NEW.lease_gen <> 0
            OR NEW.lease_owner IS NOT NULL OR NEW.lease_until IS NOT NULL THEN
            RAISE EXCEPTION 'sync cursor must start without a lease at version zero'
                USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
    END IF;
    IF (to_jsonb(NEW) - ARRAY[
        'cursor_value', 'cursor_hash', 'high_at', 'high_slot', 'overlap_at', 'checked_at',
        'next_at', 'lease_owner', 'lease_gen', 'lease_until', 'version', 'error_code',
        'error_message', 'updated_at'
    ]) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY[
        'cursor_value', 'cursor_hash', 'high_at', 'high_slot', 'overlap_at', 'checked_at',
        'next_at', 'lease_owner', 'lease_gen', 'lease_until', 'version', 'error_code',
        'error_message', 'updated_at'
    ]) OR NEW.version <> OLD.version + 1 THEN
        RAISE EXCEPTION 'sync cursor identity is immutable and version must advance by one'
            USING ERRCODE = '40001';
    END IF;
    IF (OLD.high_slot IS NOT NULL AND (NEW.high_slot IS NULL OR NEW.high_slot < OLD.high_slot))
        OR (OLD.high_at IS NOT NULL AND (NEW.high_at IS NULL OR NEW.high_at < OLD.high_at))
        OR (OLD.checked_at IS NOT NULL AND (NEW.checked_at IS NULL OR NEW.checked_at < OLD.checked_at)) THEN
        RAISE EXCEPTION 'sync cursor high-water marks cannot regress' USING ERRCODE = '40001';
    END IF;
    IF OLD.lease_owner IS NULL AND NEW.lease_owner IS NULL THEN
        IF NEW.lease_gen <> OLD.lease_gen THEN
            RAISE EXCEPTION 'inactive sync lease generation cannot change' USING ERRCODE = '40001';
        END IF;
    ELSIF OLD.lease_owner IS NULL AND NEW.lease_owner IS NOT NULL THEN
        IF NEW.lease_gen <> OLD.lease_gen + 1 THEN
            RAISE EXCEPTION 'new sync lease must advance its generation' USING ERRCODE = '40001';
        END IF;
    ELSIF OLD.lease_owner IS NOT NULL AND NEW.lease_owner IS NULL THEN
        IF NEW.lease_gen <> OLD.lease_gen THEN
            RAISE EXCEPTION 'sync lease release must retain its generation' USING ERRCODE = '40001';
        END IF;
    ELSIF NEW.lease_gen = OLD.lease_gen THEN
        IF OLD.lease_until <= now_at OR NEW.lease_owner <> OLD.lease_owner
            OR NEW.lease_until < OLD.lease_until THEN
            RAISE EXCEPTION 'sync lease renewal cannot revive or replace an expired owner'
                USING ERRCODE = '40001';
        END IF;
    ELSIF NEW.lease_gen = OLD.lease_gen + 1 THEN
        IF OLD.lease_until > now_at THEN
            RAISE EXCEPTION 'an unexpired sync lease cannot be reclaimed' USING ERRCODE = '40001';
        END IF;
    ELSE
        RAISE EXCEPTION 'sync lease generation must remain stable or advance by one'
            USING ERRCODE = '40001';
    END IF;
    NEW.updated_at := now_at;
    RETURN NEW;
END;
$$;

CREATE TRIGGER order_sync_cursors_guard
    BEFORE INSERT OR UPDATE OR DELETE ON order_sync_cursors
    FOR EACH ROW EXECUTE FUNCTION order_sync_guard();

-- A reservation is consumed by exactly one target event. Legacy events may
-- remain mutable during compatibility, but cannot be promoted around the
-- reservation protocol.
ALTER TABLE order_event_keys
    ADD COLUMN materialized_at TIMESTAMPTZ;

DROP TRIGGER order_event_keys_immutable ON order_event_keys;

UPDATE order_event_keys
   SET materialized_at = created_at;

CREATE OR REPLACE FUNCTION order_event_key_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
    IF NEW.materialized_at IS NOT NULL THEN
        RAISE EXCEPTION 'event reservation must start unconsumed' USING ERRCODE = '23514';
    END IF;
    IF NEW.action_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM order_actions action
         WHERE action.id = NEW.action_id AND action.order_id = NEW.order_id
    ) THEN
        RAISE EXCEPTION 'event action belongs to a different order' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

CREATE FUNCTION order_event_key_mutation_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'event reservations cannot be deleted' USING ERRCODE = '55000';
    END IF;
    IF OLD.materialized_at IS NOT NULL OR NEW.materialized_at IS NULL
        OR NEW.materialized_at < OLD.created_at
        OR (to_jsonb(NEW) - 'materialized_at') IS DISTINCT FROM
           (to_jsonb(OLD) - 'materialized_at') THEN
        RAISE EXCEPTION 'event reservation may only be consumed once' USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER order_event_keys_mutation_guard
    BEFORE UPDATE OR DELETE ON order_event_keys
    FOR EACH ROW EXECUTE FUNCTION order_event_key_mutation_guard();

CREATE OR REPLACE FUNCTION order_event_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
    now_at TIMESTAMPTZ := clock_timestamp();
BEGIN
    IF TG_OP IN ('UPDATE', 'DELETE') THEN
        IF OLD.event_key IS NOT NULL
            OR (TG_OP = 'UPDATE' AND OLD.event_key IS NULL AND NEW.event_key IS NOT NULL) THEN
            RAISE EXCEPTION 'target events are append-only and legacy events cannot be promoted'
                USING ERRCODE = '55000';
        END IF;
        RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
    END IF;
    IF NEW.event_key IS NOT NULL THEN
        UPDATE order_event_keys event
           SET materialized_at = now_at
         WHERE event.event_key = NEW.event_key
           AND event.event_id = NEW.id
           AND event.order_id = NEW.order_id
           AND event.action_id IS NOT DISTINCT FROM NEW.action_id
           AND event.event_type = NEW.event_type
           AND event.order_ver = NEW.order_ver
           AND event.event_hash = NEW.event_hash
           AND event.occurred_at = NEW.occurred_at
           AND event.materialized_at IS NULL;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'order event reservation is missing, mismatched, or consumed'
                USING ERRCODE = '23514';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

-- Encrypted rows retain durable identity for attempts and access evidence. Once
-- terminal and expired, the gateway proves external key destruction and scrubs
-- the live tuple to fixed sentinels instead of breaking those references.
ALTER TABLE order_tx_blobs
    ADD COLUMN destroyed_at TIMESTAMPTZ,
    ADD COLUMN destroy_ref VARCHAR(180),
    ADD COLUMN purged_at TIMESTAMPTZ,
    ADD CONSTRAINT order_tx_blobs_purge_shape CHECK (
        num_nonnulls(destroyed_at, destroy_ref, purged_at) IN (0, 3)
        AND (purged_at IS NULL OR destroyed_at <= purged_at)
    ) NOT VALID;

DROP TRIGGER order_tx_blobs_guard ON order_tx_blobs;

CREATE OR REPLACE FUNCTION order_blob_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
    now_at TIMESTAMPTZ := clock_timestamp();
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'encrypted transaction blob identity cannot be deleted' USING ERRCODE = '55000';
    END IF;
    IF TG_OP = 'UPDATE' THEN
        IF OLD.purged_at IS NOT NULL OR NEW.purged_at IS NULL
            OR NEW.destroyed_at IS NULL OR NEW.destroy_ref IS NULL
            OR NEW.destroyed_at > now_at OR OLD.expires_at > now_at
            OR NEW.key_id <> 'destroyed'
            OR NEW.ciphertext <> decode(repeat('00', 17), 'hex')
            OR NEW.wrapped_key <> decode(repeat('00', 32), 'hex')
            OR NEW.nonce <> decode(repeat('00', CASE WHEN OLD.alg = 'aes_256_gcm' THEN 12 ELSE 24 END), 'hex')
            OR (to_jsonb(NEW) - ARRAY[
                'ciphertext', 'nonce', 'wrapped_key', 'key_id',
                'destroyed_at', 'destroy_ref', 'purged_at'
            ]) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY[
                'ciphertext', 'nonce', 'wrapped_key', 'key_id',
                'destroyed_at', 'destroy_ref', 'purged_at'
            ]) THEN
            RAISE EXCEPTION 'encrypted blob may only become an expired destruction tombstone'
                USING ERRCODE = '55000';
        END IF;
        PERFORM 1 FROM order_actions action
         WHERE action.id = OLD.action_id
           AND action.work_state = 'done'
           AND action.outcome IN ('succeeded', 'failed')
         FOR UPDATE;
        IF NOT FOUND OR EXISTS (
            SELECT 1 FROM action_attempts attempt
             WHERE attempt.action_id = OLD.action_id
               AND attempt.send_state <> 'response_recorded'
        ) THEN
            RAISE EXCEPTION 'encrypted blob cannot be purged before terminal attempt recovery'
                USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
    END IF;
    PERFORM 1
      FROM order_actions action
      JOIN order_intents order_row ON order_row.id = action.order_id
     WHERE action.id = NEW.action_id
       AND action.order_id = NEW.order_id
       AND action.message_hash = NEW.message_hash
       AND action.first_signature = NEW.first_signature
       AND order_row.wallet_address = NEW.wallet_address
       AND order_row.cluster = NEW.cluster
     FOR UPDATE OF action;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'encrypted blob does not match its committed action' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER order_tx_blobs_guard
    BEFORE INSERT OR UPDATE OR DELETE ON order_tx_blobs
    FOR EACH ROW EXECUTE FUNCTION order_blob_guard();

CREATE FUNCTION purge_order_tx_blob(target UUID, proof VARCHAR, destroyed TIMESTAMPTZ)
RETURNS BOOLEAN
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
    changed BOOLEAN;
BEGIN
    IF proof IS NULL OR btrim(proof) = '' OR destroyed IS NULL THEN
        RAISE EXCEPTION 'destruction proof and time are required' USING ERRCODE = '22023';
    END IF;
    UPDATE order_tx_blobs blob
       SET ciphertext = decode(repeat('00', 17), 'hex'),
           nonce = decode(repeat('00', CASE WHEN blob.alg = 'aes_256_gcm' THEN 12 ELSE 24 END), 'hex'),
           wrapped_key = decode(repeat('00', 32), 'hex'),
           key_id = 'destroyed',
           destroyed_at = destroyed,
           destroy_ref = proof,
           purged_at = clock_timestamp()
     WHERE blob.action_id = target AND blob.purged_at IS NULL;
    changed := FOUND;
    RETURN changed;
END;
$$;

CREATE FUNCTION order_action_terminal_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
    IF OLD.work_state = 'done' THEN
        RAISE EXCEPTION 'terminal order actions cannot be rewritten' USING ERRCODE = '55000';
    END IF;
    IF EXISTS (
        SELECT 1 FROM order_tx_blobs blob
         WHERE blob.action_id = OLD.id AND blob.purged_at IS NOT NULL
    ) THEN
        RAISE EXCEPTION 'action with a destroyed transaction key cannot be reopened'
            USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER order_actions_terminal_guard
    BEFORE UPDATE ON order_actions
    FOR EACH ROW EXECUTE FUNCTION order_action_terminal_guard();

-- Financial schedule completion consumes one stable finalized fill revision.
-- The fill-key lock serializes future revisions with that consumption.
CREATE FUNCTION order_fill_serial_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
    PERFORM pg_advisory_xact_lock(hashtextextended(NEW.fill_key, 1937006964));
    IF EXISTS (
        SELECT 1
          FROM order_schedules schedule
          JOIN order_fills fill ON fill.id = schedule.fill_id
         WHERE schedule.state = 'filled' AND fill.fill_key = NEW.fill_key
    ) THEN
        RAISE EXCEPTION 'a financially consumed fill lineage cannot be revised'
            USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER order_fills_serial_guard
    BEFORE INSERT ON order_fills
    FOR EACH ROW EXECUTE FUNCTION order_fill_serial_guard();

CREATE FUNCTION order_schedule_fill_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
    target_key VARCHAR(180);
BEGIN
    IF NEW.state <> 'filled' THEN
        RETURN NEW;
    END IF;
    SELECT fill.fill_key INTO target_key FROM order_fills fill WHERE fill.id = NEW.fill_id;
    IF target_key IS NULL THEN
        RAISE EXCEPTION 'filled schedule requires an existing fill' USING ERRCODE = '23514';
    END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended(target_key, 1937006964));
    PERFORM 1
      FROM order_fills fill
     WHERE fill.id = NEW.fill_id
       AND fill.order_id = NEW.order_id
       AND fill.leg_id = NEW.leg_id
       AND fill.action_id = NEW.action_id
       AND fill.state = 'finalized'
       AND fill.input_amt = NEW.filled_in
       AND fill.output_amt = NEW.filled_out
       AND fill.input_amt <= NEW.intended_in
       AND NOT EXISTS (
           SELECT 1 FROM order_fills later
            WHERE later.fill_key = fill.fill_key AND later.rev > fill.rev
       )
     FOR SHARE OF fill;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'schedule completion must match the current finalized fill exactly'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER order_schedules_fill_guard
    BEFORE INSERT OR UPDATE ON order_schedules
    FOR EACH ROW EXECUTE FUNCTION order_schedule_fill_guard();

-- Hold a share lock on a journal while an anomaly consumes it as resolution
-- evidence. A concurrent reversal either happens first and fails resolution,
-- or waits and is rejected after the resolved anomaly commits.
CREATE FUNCTION order_anomaly_resolution_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
    IF NEW.resolution_journal IS NOT NULL THEN
        PERFORM 1 FROM asset_journals journal
         WHERE journal.id = NEW.resolution_journal
           AND journal.order_id = NEW.order_id
           AND (NEW.action_id IS NULL OR journal.action_id = NEW.action_id)
           AND journal.post_state = 'posted'
           AND journal.state IN ('confirmed', 'finalized')
         FOR SHARE;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'anomaly resolution requires a current posted journal'
                USING ERRCODE = '23514';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER order_anomalies_resolution_guard
    BEFORE INSERT OR UPDATE ON order_anomalies
    FOR EACH ROW EXECUTE FUNCTION order_anomaly_resolution_guard();

CREATE FUNCTION order_resolution_journal_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
    IF OLD.state <> 'reversed' AND NEW.state = 'reversed' AND EXISTS (
        SELECT 1 FROM order_anomalies anomaly
         WHERE anomaly.resolution_journal = OLD.id AND anomaly.state = 'resolved'
    ) THEN
        RAISE EXCEPTION 'journal consumed by a resolved anomaly cannot be reversed'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER asset_journal_order_resolution_guard
    BEFORE UPDATE ON asset_journals
    FOR EACH ROW EXECUTE FUNCTION order_resolution_journal_guard();

COMMENT ON COLUMN order_event_keys.materialized_at IS
    'Atomic one-time consumption marker written by the target order-event trigger';
COMMENT ON COLUMN order_tx_blobs.destroy_ref IS
    'Gateway-supplied reference proving external envelope-key destruction before tuple scrubbing';
COMMENT ON FUNCTION purge_order_tx_blob(UUID, VARCHAR, TIMESTAMPTZ) IS
    'Scrub expired terminal ciphertext only after the caller has destroyed its external envelope key';
