-- Make the provider mutation gateway the durable at-most-once boundary for an
-- outbound action attempt. The runtime keeps a session advisory lock through
-- the bounded network call; this trigger makes the reservation fail closed.
-- stride: destructive-review=action-egress-v26

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';
SET LOCAL idle_in_transaction_session_timeout = '60s';
SET LOCAL search_path = public;

CREATE TABLE action_egress (
    attempt_id UUID PRIMARY KEY REFERENCES action_attempts(id) ON DELETE RESTRICT,
    action_id UUID NOT NULL REFERENCES order_actions(id) ON DELETE RESTRICT,
    lease_owner VARCHAR(128) NOT NULL,
    lease_gen BIGINT NOT NULL CHECK (lease_gen > 0),
    write_scope VARCHAR(64) NOT NULL,
    write_epoch BIGINT NOT NULL,
    provider VARCHAR(32) NOT NULL,
    endpoint VARCHAR(180) NOT NULL,
    method VARCHAR(8) NOT NULL CHECK (method IN ('GET', 'POST', 'PATCH', 'PUT', 'DELETE')),
    req_hash CHAR(64) NOT NULL CHECK (req_hash ~ '^[0-9a-f]{64}$'),
    body_hash CHAR(64) CHECK (body_hash ~ '^[0-9a-f]{64}$'),
    desired_hash CHAR(64) NOT NULL CHECK (desired_hash ~ '^[0-9a-f]{64}$'),
    blob_action_id UUID REFERENCES order_tx_blobs(action_id) ON DELETE RESTRICT,
    forwarded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    completed_at TIMESTAMPTZ,
    FOREIGN KEY (write_scope, write_epoch)
        REFERENCES order_epochs(scope, epoch) ON DELETE RESTRICT,
    CHECK (blob_action_id IS NULL OR blob_action_id = action_id),
    CHECK (completed_at IS NULL OR completed_at >= forwarded_at)
);

-- The table is empty when introduced, so this ordinary partial index has no
-- deployment scan or long-running concurrent-build recovery requirement.
CREATE INDEX action_egress_inflight_idx
    ON action_egress (forwarded_at, attempt_id)
    WHERE completed_at IS NULL;

-- This trigger sorts before the existing anomaly guard. Every producer of a
-- newly blocking anomaly therefore takes the aggregate lock before inspecting
-- action or evidence rows, exactly like action admission and egress.
CREATE FUNCTION order_anomaly_lock() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
    IF NEW.blocks_actions AND NEW.state <> 'resolved' THEN
        PERFORM 1 FROM order_intents WHERE id = NEW.order_id FOR UPDATE;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'blocking anomaly order does not exist' USING ERRCODE = '23514';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER order_anomalies_00_lock
    BEFORE INSERT ON order_anomalies
    FOR EACH ROW EXECUTE FUNCTION order_anomaly_lock();

CREATE FUNCTION action_egress_guard() RETURNS trigger
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
        IF (to_jsonb(NEW) - 'completed_at') IS DISTINCT FROM
                (to_jsonb(OLD) - 'completed_at')
            OR OLD.completed_at IS NOT NULL
            OR NEW.completed_at IS NULL THEN
            RAISE EXCEPTION 'invalid action egress fact transition' USING ERRCODE = '55000';
        END IF;
        RETURN NEW;
    END IF;

    IF NEW.completed_at IS NOT NULL THEN
        RAISE EXCEPTION 'new action egress cannot already be complete' USING ERRCODE = '23514';
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

    -- The database owns the durable boundary timestamp after every lock wait.
    NEW.forwarded_at := now_at;
    RETURN NEW;
END;
$$;

CREATE TRIGGER action_egress_guard
    BEFORE INSERT OR UPDATE OR DELETE ON action_egress
    FOR EACH ROW EXECUTE FUNCTION action_egress_guard();

COMMENT ON TABLE action_egress IS
    'One durable at-most-once provider-forward reservation per fenced action attempt';
COMMENT ON COLUMN action_egress.forwarded_at IS
    'Database timestamp committed immediately before the gateway invokes provider transport';
COMMENT ON COLUMN action_egress.completed_at IS
    'Gateway transport returned or threw; provider effect remains an evidence decision';
COMMENT ON FUNCTION action_egress_guard() IS
    'Validate egress identity, deadline, lease, live epoch, and anomaly policy after all waits';
COMMENT ON FUNCTION order_anomaly_lock() IS
    'Serialize every blocking anomaly producer with action start and provider egress';
