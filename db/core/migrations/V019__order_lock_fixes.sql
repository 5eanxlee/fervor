-- Close lock-wait and fill-consumption gaps found by the second independent
-- review. This is forward-only; recorded migrations remain immutable.
-- stride: destructive-review=order-lock-fixes-v19

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';
SET LOCAL idle_in_transaction_session_timeout = '60s';
SET LOCAL search_path = public;

-- The statement already owns the target action row lock when this BEFORE
-- trigger runs. Sample wall-clock time only after the epoch advisory lock,
-- because acquiring that lock can outlive the lease being validated.
CREATE OR REPLACE FUNCTION order_action_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
    now_at TIMESTAMPTZ;
BEGIN
    IF pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
        RAISE EXCEPTION 'financial action writes require read committed isolation'
            USING ERRCODE = '25001';
    END IF;
    IF NEW.lease_owner IS NOT NULL THEN
        PERFORM pg_advisory_xact_lock_shared(hashtextextended(NEW.write_scope, 1937006964));
        now_at := clock_timestamp();
    END IF;
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
    IF NEW.lease_owner IS NOT NULL AND (
        NEW.write_scope <> concat('provider:', NEW.provider)
        OR NEW.lease_until <= now_at OR NOT EXISTS (
            SELECT 1 FROM order_epoch_current epoch
             WHERE epoch.scope = NEW.write_scope
               AND epoch.epoch = NEW.write_epoch
               AND epoch.mode = 'live'
        )
    ) THEN
        RAISE EXCEPTION 'active action lease requires its current live provider epoch'
            USING ERRCODE = '40001';
    END IF;
    IF NEW.work_state = 'done' AND num_nonnulls(
        NEW.lease_owner, NEW.lease_until, NEW.write_scope, NEW.write_epoch
    ) <> 0 THEN
        RAISE EXCEPTION 'terminal action must release its active write fence'
            USING ERRCODE = '23514';
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
        NEW.updated_at := coalesce(now_at, clock_timestamp());
    END IF;
    RETURN NEW;
END;
$$;

-- V016 made terminal rows immutable before requiring them to clear a live
-- fence. Serialize the upgrade, journal every repaired fence as an anomaly,
-- then normalize only those impossible terminal tuples while retaining the
-- monotonic lease generation.
LOCK TABLE order_actions IN SHARE ROW EXCLUSIVE MODE;

DROP TRIGGER order_actions_terminal_guard ON order_actions;

INSERT INTO order_anomalies (
    id, anomaly_key, order_id, action_id, scope, kind, severity, detail_hash, detail
)
SELECT gen_random_uuid(),
       concat('migration:v19:terminal-fence:', action.id),
       action.order_id,
       action.id,
       'action',
       'stale_epoch',
       'critical',
       encode(digest(convert_to(fact.detail::text, 'UTF8'), 'sha256'), 'hex'),
       fact.detail
  FROM order_actions action
 CROSS JOIN LATERAL (
     SELECT jsonb_build_object(
         'repair', 'cleared_by_v019',
         'leaseOwner', action.lease_owner,
         'leaseGen', action.lease_gen::text,
         'leaseUntil', action.lease_until,
         'writeScope', action.write_scope,
         'writeEpoch', action.write_epoch::text
     ) AS detail
 ) fact
 WHERE action.work_state = 'done'
   AND action.lease_owner IS NOT NULL;

UPDATE order_actions
   SET action_ver = action_ver + 1,
       lease_owner = NULL,
       lease_until = NULL,
       write_scope = NULL,
       write_epoch = NULL
 WHERE work_state = 'done'
   AND lease_owner IS NOT NULL;

CREATE TRIGGER order_actions_terminal_guard
    BEFORE UPDATE ON order_actions
    FOR EACH ROW EXECUTE FUNCTION order_action_terminal_guard();

-- An attempt locks its action before the epoch fence, matching action updates
-- and preventing row/advisory lock inversion. Sample wall-clock time after both.
CREATE OR REPLACE FUNCTION action_attempt_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
    action order_actions%ROWTYPE;
    matched BOOLEAN;
    now_at TIMESTAMPTZ;
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'action_attempts is append-once' USING ERRCODE = '55000';
    END IF;
    IF TG_OP = 'INSERT' THEN
        SELECT * INTO action FROM order_actions WHERE id = NEW.action_id FOR UPDATE;
        matched := FOUND;
        IF matched THEN
            PERFORM pg_advisory_xact_lock_shared(hashtextextended(NEW.write_scope, 1937006964));
        END IF;
        now_at := clock_timestamp();
        IF NOT matched OR action.desired_hash <> NEW.desired_hash
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
        SELECT * INTO action FROM order_actions WHERE id = NEW.action_id FOR UPDATE;
        matched := FOUND;
        IF matched THEN
            PERFORM pg_advisory_xact_lock_shared(hashtextextended(NEW.write_scope, 1937006964));
        END IF;
        now_at := clock_timestamp();
        IF NOT matched OR action.lease_gen <> NEW.lease_gen
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

-- Lock both immutable request identity and mutable attempt state before the
-- expiry sample. This gives completion and blob access a deterministic order.
CREATE OR REPLACE FUNCTION order_blob_read_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
    attempt action_attempts%ROWTYPE;
    action order_actions%ROWTYPE;
    matched BOOLEAN;
    now_at TIMESTAMPTZ;
BEGIN
    SELECT * INTO attempt
      FROM action_attempts stored
     WHERE stored.id = NEW.attempt_id
       AND stored.action_id = NEW.action_id
       AND stored.lease_gen = NEW.lease_gen
       AND stored.write_scope = NEW.write_scope
       AND stored.write_epoch = NEW.write_epoch
       AND stored.send_state = 'started'
     FOR SHARE;
    matched := FOUND;
    IF matched THEN
        SELECT * INTO action
          FROM order_actions stored
         WHERE stored.id = NEW.action_id
         FOR SHARE;
        matched := FOUND;
    END IF;
    IF matched THEN
        PERFORM pg_advisory_xact_lock_shared(hashtextextended(NEW.write_scope, 1937006964));
    END IF;
    now_at := clock_timestamp();
    IF NOT matched
        OR action.lease_owner IS NULL
        OR action.lease_gen <> NEW.lease_gen
        OR action.write_scope <> NEW.write_scope
        OR action.write_epoch <> NEW.write_epoch
        OR action.lease_until <= now_at
        OR NOT EXISTS (
            SELECT 1 FROM order_epoch_current epoch
             WHERE epoch.scope = NEW.write_scope
               AND epoch.epoch = NEW.write_epoch
               AND epoch.mode = 'live'
        ) THEN
        RAISE EXCEPTION 'blob access does not match its active outbound attempt'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

-- V016 marked every pre-existing reservation as consumed and V015 permitted
-- target-event promotion and duplicate partition rows. Freeze both relations,
-- reject every ambiguous claim, then recover zero-event reservations as pending.
LOCK TABLE order_event_keys, order_events IN SHARE ROW EXCLUSIVE MODE;

DROP TRIGGER order_event_keys_mutation_guard ON order_event_keys;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM order_events event
         WHERE event.event_key IS NOT NULL
           AND NOT EXISTS (
               SELECT 1 FROM order_event_keys key
                WHERE key.event_key = event.event_key
                  AND key.event_id = event.id
                  AND key.order_id = event.order_id
                  AND key.action_id IS NOT DISTINCT FROM event.action_id
                  AND key.event_type = event.event_type
                  AND key.order_ver = event.order_ver
                  AND key.event_hash = event.event_hash
                  AND key.occurred_at = event.occurred_at
           )
    ) THEN
        RAISE EXCEPTION 'target order event has no exact deterministic reservation';
    END IF;
    IF EXISTS (
        SELECT key.event_key
          FROM order_event_keys key
          JOIN order_events event
            ON event.event_key = key.event_key OR event.id = key.event_id
         GROUP BY key.event_key, key.event_id, key.order_id, key.action_id,
                  key.event_type, key.order_ver, key.event_hash, key.occurred_at
        HAVING count(*) <> 1 OR NOT bool_and(
            event.event_key = key.event_key
            AND event.id = key.event_id
            AND event.order_id = key.order_id
            AND event.action_id IS NOT DISTINCT FROM key.action_id
            AND event.event_type = key.event_type
            AND event.order_ver = key.order_ver
            AND event.event_hash = key.event_hash
            AND event.occurred_at = key.occurred_at
        )
    ) THEN
        RAISE EXCEPTION 'order-event reservation is claimed by duplicate or mismatched target rows';
    END IF;
END;
$$;

UPDATE order_event_keys key
   SET materialized_at = CASE
       WHEN EXISTS (
           SELECT 1 FROM order_events event
            WHERE event.event_key = key.event_key
              AND event.id = key.event_id
              AND event.order_id = key.order_id
              AND event.action_id IS NOT DISTINCT FROM key.action_id
              AND event.event_type = key.event_type
              AND event.order_ver = key.order_ver
              AND event.event_hash = key.event_hash
              AND event.occurred_at = key.occurred_at
       ) THEN coalesce(key.materialized_at, clock_timestamp())
       ELSE NULL
   END;

CREATE OR REPLACE FUNCTION order_event_key_mutation_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'event reservations cannot be deleted' USING ERRCODE = '55000';
    END IF;
    IF OLD.materialized_at IS NOT NULL OR NEW.materialized_at IS NULL
        OR NEW.materialized_at < OLD.created_at
        OR (to_jsonb(NEW) - 'materialized_at') IS DISTINCT FROM
           (to_jsonb(OLD) - 'materialized_at')
        OR NOT EXISTS (
            SELECT 1 FROM order_events event
             WHERE event.event_key = NEW.event_key
               AND event.id = NEW.event_id
               AND event.order_id = NEW.order_id
               AND event.action_id IS NOT DISTINCT FROM NEW.action_id
               AND event.event_type = NEW.event_type
               AND event.order_ver = NEW.order_ver
               AND event.event_hash = NEW.event_hash
               AND event.occurred_at = NEW.occurred_at
        ) THEN
        RAISE EXCEPTION 'event reservation may only be consumed by its exact visible event'
            USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER order_event_keys_mutation_guard
    BEFORE UPDATE OR DELETE ON order_event_keys
    FOR EACH ROW EXECUTE FUNCTION order_event_key_mutation_guard();

-- The BEFORE trigger locks and validates the reservation; an AFTER trigger can
-- then consume it only after the target event is visible to the guard above.
CREATE OR REPLACE FUNCTION order_event_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
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
        PERFORM 1 FROM order_event_keys event
         WHERE event.event_key = NEW.event_key
           AND event.event_id = NEW.id
           AND event.order_id = NEW.order_id
           AND event.action_id IS NOT DISTINCT FROM NEW.action_id
           AND event.event_type = NEW.event_type
           AND event.order_ver = NEW.order_ver
           AND event.event_hash = NEW.event_hash
           AND event.occurred_at = NEW.occurred_at
           AND event.materialized_at IS NULL
         FOR UPDATE;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'order event reservation is missing, mismatched, or consumed'
                USING ERRCODE = '23514';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

CREATE FUNCTION order_event_consume() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
    IF NEW.event_key IS NOT NULL THEN
        UPDATE order_event_keys event
           SET materialized_at = clock_timestamp()
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
            RAISE EXCEPTION 'order event reservation could not be consumed exactly once'
                USING ERRCODE = '23514';
        END IF;
    END IF;
    RETURN NULL;
END;
$$;

CREATE TRIGGER order_events_consume
    AFTER INSERT ON order_events
    FOR EACH ROW EXECUTE FUNCTION order_event_consume();

-- Block schedule writes while proving that every fill already consumed under
-- V016 meets the stronger one-to-one and exact-principal contract.
LOCK TABLE order_schedules IN SHARE ROW EXCLUSIVE MODE;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
          FROM order_schedules schedule
          LEFT JOIN order_fills fill ON fill.id = schedule.fill_id
         WHERE schedule.state = 'filled'
           AND (
               fill.id IS NULL
               OR fill.order_id IS DISTINCT FROM schedule.order_id
               OR fill.leg_id IS DISTINCT FROM schedule.leg_id
               OR fill.action_id IS DISTINCT FROM schedule.action_id
               OR fill.state <> 'finalized'
               OR fill.input_amt IS DISTINCT FROM schedule.filled_in
               OR fill.output_amt IS DISTINCT FROM schedule.filled_out
               OR fill.input_amt IS DISTINCT FROM schedule.intended_in
               OR EXISTS (
                   SELECT 1 FROM order_fills later
                    WHERE later.fill_key = fill.fill_key AND later.rev > fill.rev
               )
           )
    ) THEN
        RAISE EXCEPTION 'existing schedule completion does not match its current finalized fill exactly';
    END IF;
    IF EXISTS (
        SELECT fill_id
          FROM order_schedules
         WHERE fill_id IS NOT NULL
         GROUP BY fill_id
        HAVING count(*) > 1
    ) THEN
        RAISE EXCEPTION 'existing finalized fill is consumed by more than one schedule';
    END IF;
END;
$$;

CREATE OR REPLACE FUNCTION order_schedule_fill_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
    target_key order_fills.fill_key%TYPE;
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
       AND fill.input_amt = NEW.intended_in
       AND NOT EXISTS (
           SELECT 1 FROM order_fills later
            WHERE later.fill_key = fill.fill_key AND later.rev > fill.rev
       )
       AND NOT EXISTS (
           SELECT 1 FROM order_schedules used
            WHERE used.fill_id = NEW.fill_id
              AND used.state = 'filled'
              AND used.id <> NEW.id
       )
     FOR SHARE OF fill;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'schedule completion must match one unconsumed current finalized fill exactly'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION order_action_guard() IS
    'Validate action identity and fence expiry after acquiring every blocking epoch lock';
COMMENT ON FUNCTION action_attempt_guard() IS
    'Validate outbound attempt state and fence expiry after acquiring epoch and action locks';
COMMENT ON FUNCTION order_blob_read_guard() IS
    'Authorize signed-blob access after locking the epoch, action, and active attempt';
COMMENT ON FUNCTION order_schedule_fill_guard() IS
    'Consume one current finalized fill for one schedule with exact principal and output amounts';
