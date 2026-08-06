-- Distinguish the durable at-most-once reservation from actual transport entry
-- while retaining rolling compatibility with V026 runtimes.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';
SET LOCAL idle_in_transaction_session_timeout = '60s';
SET LOCAL search_path = public;

ALTER TABLE action_egress
    ADD COLUMN started_at TIMESTAMPTZ;

ALTER TABLE action_egress
    ADD CONSTRAINT action_egress_phase_order CHECK (
        (started_at IS NULL OR started_at >= forwarded_at)
        AND (completed_at IS NULL OR started_at IS NULL OR completed_at >= started_at)
    ) NOT VALID;

ALTER TABLE action_egress VALIDATE CONSTRAINT action_egress_phase_order;

CREATE OR REPLACE FUNCTION action_egress_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
    action order_actions%ROWTYPE;
    attempt action_attempts%ROWTYPE;
    target_order UUID;
    now_at TIMESTAMPTZ;
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'action egress is append-once' USING ERRCODE = '55000';
    END IF;

    IF TG_OP = 'UPDATE' THEN
        IF (to_jsonb(NEW) - ARRAY['started_at', 'completed_at']) IS DISTINCT FROM
                (to_jsonb(OLD) - ARRAY['started_at', 'completed_at'])
            OR OLD.completed_at IS NOT NULL THEN
            RAISE EXCEPTION 'invalid action egress fact transition' USING ERRCODE = '55000';
        END IF;

        IF NEW.started_at IS DISTINCT FROM OLD.started_at THEN
            IF OLD.started_at IS NOT NULL
                OR NEW.started_at IS NULL
                OR NEW.completed_at IS DISTINCT FROM OLD.completed_at THEN
                RAISE EXCEPTION 'invalid action egress fact transition' USING ERRCODE = '55000';
            END IF;
            IF NOT EXISTS (
                SELECT 1 FROM action_attempts stored_attempt
                 WHERE stored_attempt.id = NEW.attempt_id
                   AND stored_attempt.deadline_at > clock_timestamp()
            ) THEN
                RAISE EXCEPTION 'egress transport deadline elapsed before start'
                    USING ERRCODE = '40001';
            END IF;
            NEW.started_at := clock_timestamp();
            RETURN NEW;
        END IF;

        IF NEW.completed_at IS NOT NULL AND OLD.completed_at IS NULL THEN
            -- An N-1 gateway writes completion directly. Preserve that safe
            -- rollout path while recording its conservative V026 boundary.
            IF NEW.started_at IS NULL THEN NEW.started_at := OLD.forwarded_at; END IF;
            NEW.completed_at := clock_timestamp();
            RETURN NEW;
        END IF;

        RAISE EXCEPTION 'invalid action egress fact transition' USING ERRCODE = '55000';
    END IF;

    IF NEW.started_at IS NOT NULL OR NEW.completed_at IS NOT NULL THEN
        RAISE EXCEPTION 'new action egress cannot already have a transport phase'
            USING ERRCODE = '23514';
    END IF;

    -- Preserve the global lock order: aggregate, action, attempt, epoch scope.
    SELECT stored.order_id INTO target_order
      FROM order_actions stored
     WHERE stored.id = NEW.action_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'egress action does not exist' USING ERRCODE = '23514';
    END IF;
    PERFORM 1 FROM order_intents stored WHERE stored.id = target_order FOR SHARE;
    SELECT * INTO action FROM order_actions stored WHERE stored.id = NEW.action_id FOR SHARE;
    SELECT * INTO attempt FROM action_attempts stored WHERE stored.id = NEW.attempt_id FOR SHARE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'egress attempt does not exist' USING ERRCODE = '23514';
    END IF;
    PERFORM pg_advisory_xact_lock_shared(hashtextextended(action.write_scope, 1937006964));
    now_at := clock_timestamp();

    IF attempt.action_id <> action.id
        OR attempt.send_state <> 'started'
        OR attempt.deadline_at <= now_at
        OR attempt.deadline_at > action.lease_until
        OR action.work_state <> 'dispatching'
        OR action.effect_state <> 'possible'
        OR action.outcome <> 'pending'
        OR action.block_reason IS NOT NULL
        OR action.lease_owner IS NULL
        OR action.lease_until <= now_at
        OR action.lease_gen <> attempt.lease_gen
        OR action.write_scope <> attempt.write_scope
        OR action.write_epoch <> attempt.write_epoch
        OR action.provider <> attempt.provider
        OR action.req_hash <> attempt.req_hash
        OR action.desired_hash <> attempt.desired_hash
        OR action.attempt_count <> attempt.seq
        OR NEW.action_id <> action.id
        OR NEW.lease_owner <> action.lease_owner
        OR NEW.lease_gen <> attempt.lease_gen
        OR NEW.write_scope <> attempt.write_scope
        OR NEW.write_epoch <> attempt.write_epoch
        OR NEW.provider <> attempt.provider
        OR NEW.endpoint <> attempt.endpoint
        OR NEW.method <> attempt.method
        OR NEW.req_hash <> attempt.req_hash
        OR NEW.body_hash IS DISTINCT FROM attempt.body_hash
        OR NEW.desired_hash <> attempt.desired_hash
        OR NEW.blob_action_id IS DISTINCT FROM attempt.blob_action_id
        OR NOT EXISTS (
            SELECT 1 FROM order_epoch_current epoch
             WHERE epoch.scope = action.write_scope
               AND epoch.epoch = action.write_epoch
               AND epoch.mode = 'live'
        )
        OR EXISTS (
            SELECT 1 FROM order_anomalies anomaly
             WHERE anomaly.order_id = action.order_id
               AND anomaly.state <> 'resolved'
               AND anomaly.blocks_actions
        ) THEN
        RAISE EXCEPTION 'egress does not match one active fenced attempt'
            USING ERRCODE = '40001';
    END IF;

    NEW.forwarded_at := now_at;
    RETURN NEW;
END;
$$;

COMMENT ON COLUMN action_egress.forwarded_at IS
    'Durable reservation time; conservative at-most-once boundary, not proof of network I/O';
COMMENT ON COLUMN action_egress.started_at IS
    'Gateway entered provider transport after recomputing its post-commit deadline';
COMMENT ON COLUMN action_egress.completed_at IS
    'Gateway transport settled or a reserved attempt ended before transport entry';
COMMENT ON FUNCTION action_egress_guard() IS
    'Validate reservation identity and permit only monotonic transport phase facts';
