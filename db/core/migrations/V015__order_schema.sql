-- Expand the legacy order aggregate into durable intent, action, evidence, and
-- recovery primitives. Runtime dual-write and backfill land separately.
-- stride: destructive-review=order-schema-v15-triggers

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';
SET LOCAL idle_in_transaction_session_timeout = '60s';
SET LOCAL search_path = public;

ALTER TABLE order_intents
    ADD COLUMN cluster VARCHAR(32),
    ADD COLUMN family VARCHAR(12),
    ADD COLUMN strategy_kind VARCHAR(12),
    ADD COLUMN trigger_state VARCHAR(12),
    ADD COLUMN fill_state VARCHAR(12),
    ADD COLUMN funds_state VARCHAR(12),
    ADD COLUMN remaining_in sol_u64,
    ADD COLUMN filled_in wide_uint,
    ADD COLUMN filled_out wide_uint,
    ADD COLUMN order_ver BIGINT NOT NULL DEFAULT 0,
    ADD COLUMN req_ver SMALLINT,
    ADD COLUMN provider_state VARCHAR(80),
    ADD COLUMN provider_at TIMESTAMPTZ,
    ADD COLUMN sync_at TIMESTAMPTZ,
    ADD CONSTRAINT order_intents_cluster_v2 CHECK (
        cluster IS NULL OR cluster IN ('mainnet-beta', 'devnet', 'testnet', 'localnet')
    ) NOT VALID,
    ADD CONSTRAINT order_intents_family_v2 CHECK (
        family IS NULL OR family IN ('price', 'dca')
    ) NOT VALID,
    ADD CONSTRAINT order_intents_kind_v2 CHECK (
        strategy_kind IS NULL OR strategy_kind IN ('single', 'oco', 'otoco', 'time_dca', 'band_dca')
    ) NOT VALID,
    ADD CONSTRAINT order_intents_trigger_v2 CHECK (
        trigger_state IS NULL OR trigger_state IN ('pending', 'open', 'triggered', 'disabled', 'expired', 'failed')
    ) NOT VALID,
    ADD CONSTRAINT order_intents_fill_v2 CHECK (
        fill_state IS NULL OR fill_state IN ('none', 'partial', 'filled', 'failed')
    ) NOT VALID,
    ADD CONSTRAINT order_intents_funds_v2 CHECK (
        funds_state IS NULL OR funds_state IN (
            'wallet', 'depositing', 'vaulted', 'mixed', 'withdrawing',
            'returned', 'spent', 'unknown'
        )
    ) NOT VALID,
    ADD CONSTRAINT order_intents_amounts_v2 CHECK (
        remaining_in IS NULL OR remaining_in <= input_amount
    ) NOT VALID,
    ADD CONSTRAINT order_intents_version_v2 CHECK (
        order_ver >= 0 AND (req_ver IS NULL OR req_ver > 0)
    ) NOT VALID;

CREATE FUNCTION order_deny_change() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
    RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '55000';
END;
$$;

CREATE TABLE order_epochs (
    scope VARCHAR(64) NOT NULL,
    epoch BIGINT NOT NULL CHECK (epoch > 0),
    region VARCHAR(32),
    mode VARCHAR(12) NOT NULL CHECK (mode IN ('frozen', 'reconcile', 'live')),
    authority VARCHAR(80) NOT NULL,
    proof_hash CHAR(64) NOT NULL CHECK (proof_hash ~ '^[0-9a-f]{64}$'),
    source_key VARCHAR(180) NOT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (scope, epoch),
    CHECK (mode = 'frozen' OR region IS NOT NULL)
);

CREATE FUNCTION order_epoch_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
    current_epoch BIGINT;
BEGIN
    IF TG_OP <> 'INSERT' THEN
        RAISE EXCEPTION 'order_epochs is append-only' USING ERRCODE = '55000';
    END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended(NEW.scope, 1937006964));
    SELECT coalesce(max(epoch), 0) INTO current_epoch
      FROM order_epochs
     WHERE scope = NEW.scope;
    IF NEW.epoch <> current_epoch + 1 THEN
        RAISE EXCEPTION 'write epoch for % must advance from % to %, received %',
            NEW.scope, current_epoch, current_epoch + 1, NEW.epoch
            USING ERRCODE = '40001';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER order_epochs_guard
    BEFORE INSERT OR UPDATE OR DELETE ON order_epochs
    FOR EACH ROW EXECUTE FUNCTION order_epoch_guard();

CREATE VIEW order_epoch_current AS
SELECT DISTINCT ON (scope)
       scope, epoch, region, mode, authority, proof_hash, source_key, created_at
  FROM order_epochs
 ORDER BY scope, epoch DESC;

CREATE TABLE order_legs (
    id UUID PRIMARY KEY,
    order_id UUID NOT NULL REFERENCES order_intents(id) ON DELETE RESTRICT,
    leg_no SMALLINT NOT NULL CHECK (leg_no >= 0),
    role VARCHAR(16) NOT NULL CHECK (role IN ('primary', 'take_profit', 'stop_loss', 'dca')),
    parent_leg UUID REFERENCES order_legs(id) ON DELETE RESTRICT,
    oco_group UUID,
    condition VARCHAR(12) NOT NULL CHECK (condition IN ('above', 'below', 'trailing', 'interval', 'band')),
    alloc_amt sol_u64,
    alloc_bps INTEGER CHECK (alloc_bps BETWEEN 1 AND 10000),
    target_usd NUMERIC(38, 18) CHECK (target_usd > 0),
    target_low_usd NUMERIC(38, 18) CHECK (target_low_usd > 0),
    target_high_usd NUMERIC(38, 18) CHECK (target_high_usd > 0),
    trail_bps INTEGER CHECK (trail_bps BETWEEN 1 AND 10000),
    slip_bps INTEGER NOT NULL CHECK (slip_bps BETWEEN 0 AND 10000),
    provider_leg_id VARCHAR(180),
    state VARCHAR(12) NOT NULL DEFAULT 'pending'
        CHECK (state IN ('pending', 'open', 'triggered', 'filled', 'disabled', 'expired', 'failed')),
    config JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (pg_column_size(config) <= 32768),
    version BIGINT NOT NULL DEFAULT 0 CHECK (version >= 0),
    provider_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (order_id, leg_no),
    CHECK (num_nonnulls(alloc_amt, alloc_bps) = 1),
    CHECK (alloc_amt IS NULL OR alloc_amt > 0),
    CHECK (
        (condition IN ('above', 'below') AND target_usd IS NOT NULL
            AND target_low_usd IS NULL AND target_high_usd IS NULL AND trail_bps IS NULL)
        OR (condition = 'trailing' AND target_usd IS NULL
            AND target_low_usd IS NULL AND target_high_usd IS NULL AND trail_bps IS NOT NULL)
        OR (condition = 'interval' AND target_usd IS NULL
            AND target_low_usd IS NULL AND target_high_usd IS NULL AND trail_bps IS NULL)
        OR (condition = 'band' AND target_usd IS NULL AND trail_bps IS NULL
            AND target_low_usd IS NOT NULL AND target_high_usd IS NOT NULL
            AND target_low_usd < target_high_usd)
    )
);

CREATE UNIQUE INDEX order_legs_provider_idx
    ON order_legs (order_id, provider_leg_id)
    WHERE provider_leg_id IS NOT NULL;
CREATE INDEX order_legs_parent_idx ON order_legs (parent_leg) WHERE parent_leg IS NOT NULL;

CREATE FUNCTION order_leg_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
    IF NEW.parent_leg IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM order_legs parent
         WHERE parent.id = NEW.parent_leg AND parent.order_id = NEW.order_id
    ) THEN
        RAISE EXCEPTION 'parent leg belongs to a different order' USING ERRCODE = '23514';
    END IF;
    IF TG_OP = 'UPDATE' THEN
        IF (to_jsonb(NEW) - ARRAY[
            'condition', 'alloc_amt', 'alloc_bps', 'target_usd', 'target_low_usd',
            'target_high_usd', 'trail_bps', 'slip_bps', 'provider_leg_id', 'state',
            'config', 'version', 'provider_at', 'updated_at'
        ]) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY[
            'condition', 'alloc_amt', 'alloc_bps', 'target_usd', 'target_low_usd',
            'target_high_usd', 'trail_bps', 'slip_bps', 'provider_leg_id', 'state',
            'config', 'version', 'provider_at', 'updated_at'
        ]) OR NEW.version <> OLD.version + 1 THEN
            RAISE EXCEPTION 'leg identity is immutable and version must advance by one'
                USING ERRCODE = '40001';
        END IF;
        NEW.updated_at := clock_timestamp();
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER order_legs_guard
    BEFORE INSERT OR UPDATE ON order_legs
    FOR EACH ROW EXECUTE FUNCTION order_leg_guard();
CREATE TRIGGER order_legs_no_delete
    BEFORE DELETE ON order_legs
    FOR EACH ROW EXECUTE FUNCTION order_deny_change();

CREATE TABLE order_actions (
    id UUID PRIMARY KEY,
    order_id UUID NOT NULL REFERENCES order_intents(id) ON DELETE RESTRICT,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    leg_id UUID REFERENCES order_legs(id) ON DELETE RESTRICT,
    parent_action UUID REFERENCES order_actions(id) ON DELETE RESTRICT,
    kind VARCHAR(20) NOT NULL CHECK (kind IN (
        'prepare', 'activate', 'edit', 'cancel_init', 'cancel_confirm',
        'provider_sync', 'chain_sync', 'expire', 'compensate'
    )),
    client_key VARCHAR(128) NOT NULL,
    req_hash CHAR(64) NOT NULL CHECK (req_hash ~ '^[0-9a-f]{64}$'),
    desired_hash CHAR(64) NOT NULL CHECK (desired_hash ~ '^[0-9a-f]{64}$'),
    expected_ver BIGINT NOT NULL CHECK (expected_ver >= 0),
    action_ver BIGINT NOT NULL DEFAULT 0 CHECK (action_ver >= 0),
    work_state VARCHAR(16) NOT NULL CHECK (work_state IN (
        'queued', 'awaiting_sig', 'ready', 'dispatching', 'reconciling', 'parked', 'done'
    )),
    effect_state VARCHAR(16) NOT NULL CHECK (effect_state IN (
        'not_possible', 'possible', 'present', 'absent', 'conflict'
    )),
    outcome VARCHAR(16) NOT NULL CHECK (outcome IN ('pending', 'succeeded', 'failed', 'manual_review')),
    block_reason VARCHAR(16) CHECK (block_reason IN ('needs_auth', 'circuit_open', 'operator_hold')),
    provider VARCHAR(32) NOT NULL,
    provider_req_id VARCHAR(180),
    provider_order_id VARCHAR(180),
    first_signature VARCHAR(128) CHECK (first_signature ~ '^[1-9A-HJ-NP-Za-km-z]{64,88}$'),
    message_hash CHAR(64) CHECK (message_hash ~ '^[0-9a-f]{64}$'),
    recent_blockhash VARCHAR(64) CHECK (recent_blockhash ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
    last_valid_height sol_u64,
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    due_at TIMESTAMPTZ NOT NULL,
    lease_owner VARCHAR(128),
    lease_gen BIGINT NOT NULL DEFAULT 0 CHECK (lease_gen >= 0),
    lease_until TIMESTAMPTZ,
    write_scope VARCHAR(64),
    write_epoch BIGINT,
    ambiguity_at TIMESTAMPTZ,
    provider_check_at TIMESTAMPTZ,
    chain_check_at TIMESTAMPTZ,
    error_code VARCHAR(80),
    error_class VARCHAR(32),
    error_message VARCHAR(500),
    http_class VARCHAR(32),
    retry_after TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (user_id, client_key),
    FOREIGN KEY (write_scope, write_epoch)
        REFERENCES order_epochs(scope, epoch) ON DELETE RESTRICT,
    CHECK (
        (num_nonnulls(lease_owner, lease_until, write_scope, write_epoch) = 0)
        OR (num_nonnulls(lease_owner, lease_until, write_scope, write_epoch) = 4 AND lease_gen > 0)
    ),
    CHECK (block_reason IS NULL OR work_state = 'parked'),
    CHECK (work_state <> 'parked' OR outcome <> 'pending' OR block_reason IS NOT NULL),
    CHECK (
        (outcome = 'pending' AND work_state <> 'done')
        OR (outcome = 'succeeded' AND work_state = 'done' AND effect_state = 'present')
        OR (outcome = 'failed' AND work_state = 'done' AND effect_state = 'absent')
        OR (outcome = 'manual_review' AND work_state = 'parked'
            AND effect_state IN ('possible', 'conflict'))
    ),
    CHECK ((work_state = 'done') = (completed_at IS NOT NULL)),
    CHECK (effect_state NOT IN ('possible', 'conflict') OR ambiguity_at IS NOT NULL),
    CHECK (work_state <> 'dispatching' OR (effect_state = 'possible' AND attempt_count > 0))
);

CREATE UNIQUE INDEX order_actions_provider_idx
    ON order_actions (provider, provider_req_id)
    WHERE provider_req_id IS NOT NULL;
CREATE INDEX order_actions_due_idx ON order_actions (due_at, id)
    WHERE work_state IN ('queued', 'ready', 'reconciling') AND block_reason IS NULL;
CREATE INDEX order_actions_open_idx ON order_actions
    (order_id, work_state, effect_state, outcome, id)
    WHERE work_state <> 'done' OR effect_state IN ('possible', 'conflict');
CREATE INDEX order_actions_lease_idx ON order_actions (lease_until, id)
    WHERE lease_owner IS NOT NULL;
CREATE INDEX order_actions_user_idx ON order_actions (user_id, created_at DESC, id);

CREATE FUNCTION order_action_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
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
            OR NEW.lease_until <= CURRENT_TIMESTAMP OR NOT EXISTS (
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
            IF OLD.lease_until <= CURRENT_TIMESTAMP
                OR NEW.lease_owner <> OLD.lease_owner
                OR NEW.write_scope <> OLD.write_scope
                OR NEW.write_epoch <> OLD.write_epoch
                OR NEW.lease_until < OLD.lease_until THEN
                RAISE EXCEPTION 'lease renewal cannot revive or replace an expired fence' USING ERRCODE = '40001';
            END IF;
        ELSIF NEW.lease_gen = OLD.lease_gen + 1 THEN
            IF OLD.lease_until > CURRENT_TIMESTAMP THEN
                RAISE EXCEPTION 'an unexpired lease cannot be reclaimed' USING ERRCODE = '40001';
            END IF;
        ELSE
            RAISE EXCEPTION 'lease generation must remain stable or advance by one' USING ERRCODE = '40001';
        END IF;
        NEW.updated_at := clock_timestamp();
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER order_actions_guard
    BEFORE INSERT OR UPDATE ON order_actions
    FOR EACH ROW EXECUTE FUNCTION order_action_guard();
CREATE TRIGGER order_actions_no_delete
    BEFORE DELETE ON order_actions
    FOR EACH ROW EXECUTE FUNCTION order_deny_change();

CREATE TABLE order_tx_blobs (
    action_id UUID PRIMARY KEY REFERENCES order_actions(id) ON DELETE RESTRICT,
    order_id UUID NOT NULL REFERENCES order_intents(id) ON DELETE RESTRICT,
    cluster VARCHAR(32) NOT NULL CHECK (cluster IN ('mainnet-beta', 'devnet', 'testnet', 'localnet')),
    wallet_address VARCHAR(64) NOT NULL CHECK (wallet_address ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
    alg VARCHAR(24) NOT NULL CHECK (alg IN ('aes_256_gcm', 'xchacha20_poly1305')),
    ciphertext BYTEA NOT NULL,
    nonce BYTEA NOT NULL,
    wrapped_key BYTEA NOT NULL,
    key_id VARCHAR(128) NOT NULL,
    aad_hash CHAR(64) NOT NULL CHECK (aad_hash ~ '^[0-9a-f]{64}$'),
    message_hash CHAR(64) NOT NULL CHECK (message_hash ~ '^[0-9a-f]{64}$'),
    first_signature VARCHAR(128) NOT NULL CHECK (first_signature ~ '^[1-9A-HJ-NP-Za-km-z]{64,88}$'),
    byte_size INTEGER NOT NULL CHECK (byte_size BETWEEN 1 AND 1232),
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK (octet_length(ciphertext) BETWEEN 17 AND 4096),
    CHECK (octet_length(wrapped_key) BETWEEN 32 AND 8192),
    CHECK ((alg = 'aes_256_gcm' AND octet_length(nonce) = 12)
        OR (alg = 'xchacha20_poly1305' AND octet_length(nonce) = 24)),
    CHECK (expires_at > created_at)
);

CREATE FUNCTION order_blob_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
    IF TG_OP = 'UPDATE' THEN
        RAISE EXCEPTION 'encrypted transaction blobs cannot be rewritten' USING ERRCODE = '55000';
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
    BEFORE INSERT OR UPDATE ON order_tx_blobs
    FOR EACH ROW EXECUTE FUNCTION order_blob_guard();

CREATE TABLE action_attempts (
    id UUID PRIMARY KEY,
    action_id UUID NOT NULL REFERENCES order_actions(id) ON DELETE RESTRICT,
    seq INTEGER NOT NULL CHECK (seq > 0),
    lease_gen BIGINT NOT NULL CHECK (lease_gen > 0),
    write_scope VARCHAR(64) NOT NULL,
    write_epoch BIGINT NOT NULL,
    endpoint VARCHAR(180) NOT NULL,
    method VARCHAR(8) NOT NULL CHECK (method IN ('GET', 'POST', 'PATCH', 'PUT', 'DELETE')),
    provider VARCHAR(32) NOT NULL,
    req_hash CHAR(64) NOT NULL CHECK (req_hash ~ '^[0-9a-f]{64}$'),
    body_hash CHAR(64) CHECK (body_hash ~ '^[0-9a-f]{64}$'),
    desired_hash CHAR(64) NOT NULL CHECK (desired_hash ~ '^[0-9a-f]{64}$'),
    provider_req_id VARCHAR(180),
    blob_action_id UUID REFERENCES order_tx_blobs(action_id) ON DELETE RESTRICT,
    send_state VARCHAR(20) NOT NULL CHECK (send_state IN ('prepared', 'started', 'response_recorded')),
    started_at TIMESTAMPTZ,
    deadline_at TIMESTAMPTZ NOT NULL,
    completed_at TIMESTAMPTZ,
    http_status INTEGER CHECK (http_status BETWEEN 100 AND 599),
    http_class VARCHAR(24) CHECK (http_class IN (
        'success', 'client_error', 'auth_error', 'rate_limited', 'conflict',
        'server_error', 'transport_error', 'timeout'
    )),
    response_hash CHAR(64) CHECK (response_hash ~ '^[0-9a-f]{64}$'),
    provider_effect_id VARCHAR(180),
    error_code VARCHAR(80),
    error_message VARCHAR(500),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (action_id, seq),
    FOREIGN KEY (write_scope, write_epoch)
        REFERENCES order_epochs(scope, epoch) ON DELETE RESTRICT,
    CHECK (blob_action_id IS NULL OR blob_action_id = action_id),
    CHECK (deadline_at > coalesce(started_at, created_at)),
    CHECK (completed_at IS NULL OR completed_at >= started_at),
    CHECK (
        (send_state = 'prepared' AND started_at IS NULL AND completed_at IS NULL
            AND num_nonnulls(http_status, http_class, response_hash, provider_effect_id,
                error_code, error_message) = 0)
        OR (send_state = 'started' AND started_at IS NOT NULL AND completed_at IS NULL
            AND num_nonnulls(http_status, http_class, response_hash, provider_effect_id,
                error_code, error_message) = 0)
        OR (send_state = 'response_recorded' AND started_at IS NOT NULL
            AND completed_at IS NOT NULL AND http_class IS NOT NULL
            AND num_nonnulls(http_status, response_hash, error_code) > 0)
    )
);

CREATE UNIQUE INDEX action_attempts_provider_idx
    ON action_attempts (provider, endpoint, provider_req_id)
    WHERE provider_req_id IS NOT NULL;
CREATE INDEX action_attempts_action_idx ON action_attempts (action_id, seq DESC);

CREATE FUNCTION action_attempt_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
    action order_actions%ROWTYPE;
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
            OR action.lease_until <= CURRENT_TIMESTAMP
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
            OR action.lease_until <= CURRENT_TIMESTAMP
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

CREATE TRIGGER action_attempts_guard
    BEFORE INSERT OR UPDATE OR DELETE ON action_attempts
    FOR EACH ROW EXECUTE FUNCTION action_attempt_guard();

CREATE TABLE order_blob_reads (
    id UUID PRIMARY KEY,
    access_key VARCHAR(180) NOT NULL UNIQUE,
    action_id UUID NOT NULL REFERENCES order_tx_blobs(action_id) ON DELETE RESTRICT,
    attempt_id UUID NOT NULL REFERENCES action_attempts(id) ON DELETE RESTRICT,
    lease_gen BIGINT NOT NULL CHECK (lease_gen > 0),
    write_scope VARCHAR(64) NOT NULL,
    write_epoch BIGINT NOT NULL,
    gateway VARCHAR(128) NOT NULL,
    purpose VARCHAR(12) NOT NULL CHECK (purpose IN ('dispatch', 'replay', 'reconcile')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (write_scope, write_epoch)
        REFERENCES order_epochs(scope, epoch) ON DELETE RESTRICT
);

CREATE FUNCTION order_blob_read_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
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
           AND action.lease_until > CURRENT_TIMESTAMP
           AND action.write_scope = NEW.write_scope
           AND action.write_epoch = NEW.write_epoch
           AND epoch.mode = 'live'
         FOR SHARE OF action;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'blob access does not match its outbound attempt' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER order_blob_reads_guard
    BEFORE INSERT ON order_blob_reads
    FOR EACH ROW EXECUTE FUNCTION order_blob_read_guard();
CREATE TRIGGER order_blob_reads_immutable
    BEFORE UPDATE OR DELETE ON order_blob_reads
    FOR EACH ROW EXECUTE FUNCTION order_deny_change();

CREATE TABLE action_obs (
    id UUID PRIMARY KEY,
    action_id UUID NOT NULL REFERENCES order_actions(id) ON DELETE RESTRICT,
    attempt_id UUID REFERENCES action_attempts(id) ON DELETE RESTRICT,
    source VARCHAR(12) NOT NULL CHECK (source IN ('provider', 'chain')),
    cluster VARCHAR(32) NOT NULL CHECK (cluster IN ('mainnet-beta', 'devnet', 'testnet', 'localnet')),
    source_key VARCHAR(220) NOT NULL,
    query_kind VARCHAR(24) NOT NULL CHECK (query_kind IN (
        'unchecked', 'found', 'queried_no_evidence', 'expired_unseen'
    )),
    provider VARCHAR(32),
    raw_state VARCHAR(80),
    norm_state VARCHAR(80),
    desired_hash CHAR(64) NOT NULL CHECK (desired_hash ~ '^[0-9a-f]{64}$'),
    effect_hash CHAR(64) CHECK (effect_hash ~ '^[0-9a-f]{64}$'),
    provider_req_id VARCHAR(180),
    provider_order_id VARCHAR(180),
    signature VARCHAR(128) CHECK (signature ~ '^[1-9A-HJ-NP-Za-km-z]{64,88}$'),
    slot BIGINT CHECK (slot BETWEEN 0 AND 9007199254740991),
    instruction_index INTEGER CHECK (instruction_index >= 0),
    event_index INTEGER CHECK (event_index >= 0),
    commitment VARCHAR(10) CHECK (commitment IN ('processed', 'confirmed', 'finalized')),
    payload_hash CHAR(64) NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
    payload_ver SMALLINT NOT NULL CHECK (payload_ver > 0),
    payload JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (pg_column_size(payload) <= 65536),
    source_at TIMESTAMPTZ,
    observed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (source, cluster, source_key),
    CHECK (
        (source = 'provider' AND provider IS NOT NULL
            AND num_nonnulls(signature, slot, instruction_index, event_index, commitment) = 0)
        OR (source = 'chain' AND provider IS NULL)
    ),
    CHECK (source <> 'provider' OR query_kind <> 'found'
        OR num_nonnulls(provider_req_id, provider_order_id) > 0),
    CHECK (source <> 'chain' OR query_kind <> 'found'
        OR num_nonnulls(signature, slot, instruction_index, event_index, commitment) = 5)
);

CREATE UNIQUE INDEX action_obs_chain_idx ON action_obs
    (cluster, signature, instruction_index, event_index, commitment)
    WHERE source = 'chain' AND query_kind = 'found';
CREATE INDEX action_obs_action_idx ON action_obs (action_id, observed_at, id);
CREATE INDEX action_obs_provider_idx ON action_obs
    (provider, provider_order_id, observed_at)
    WHERE source = 'provider' AND provider_order_id IS NOT NULL;

CREATE FUNCTION action_obs_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
    IF NEW.attempt_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM action_attempts attempt
         WHERE attempt.id = NEW.attempt_id AND attempt.action_id = NEW.action_id
    ) THEN
        RAISE EXCEPTION 'observation attempt belongs to a different action' USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (
        SELECT 1
          FROM order_actions action
          JOIN order_intents order_row ON order_row.id = action.order_id
         WHERE action.id = NEW.action_id
           AND action.desired_hash = NEW.desired_hash
           AND (order_row.cluster IS NULL OR order_row.cluster = NEW.cluster)
           AND (NEW.source <> 'provider' OR action.provider = NEW.provider)
    ) THEN
        RAISE EXCEPTION 'observation does not match its action effect, provider, or cluster'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER action_obs_guard
    BEFORE INSERT ON action_obs
    FOR EACH ROW EXECUTE FUNCTION action_obs_guard();
CREATE TRIGGER action_obs_immutable
    BEFORE UPDATE OR DELETE ON action_obs
    FOR EACH ROW EXECUTE FUNCTION order_deny_change();

CREATE TABLE order_fills (
    id UUID PRIMARY KEY,
    fill_key VARCHAR(220) NOT NULL,
    rev SMALLINT NOT NULL CHECK (rev > 0),
    supersedes UUID UNIQUE REFERENCES order_fills(id) ON DELETE RESTRICT,
    order_id UUID NOT NULL REFERENCES order_intents(id) ON DELETE RESTRICT,
    leg_id UUID REFERENCES order_legs(id) ON DELETE RESTRICT,
    action_id UUID NOT NULL REFERENCES order_actions(id) ON DELETE RESTRICT,
    obs_id UUID NOT NULL REFERENCES action_obs(id) ON DELETE RESTRICT,
    provider VARCHAR(32) NOT NULL,
    provider_fill_id VARCHAR(180),
    state VARCHAR(12) NOT NULL CHECK (state IN ('confirmed', 'finalized', 'retracted', 'disputed')),
    cluster VARCHAR(32) NOT NULL CHECK (cluster IN ('mainnet-beta', 'devnet', 'testnet', 'localnet')),
    signature VARCHAR(128) NOT NULL CHECK (signature ~ '^[1-9A-HJ-NP-Za-km-z]{64,88}$'),
    slot BIGINT NOT NULL CHECK (slot BETWEEN 0 AND 9007199254740991),
    instruction_index INTEGER NOT NULL CHECK (instruction_index >= 0),
    event_index INTEGER NOT NULL CHECK (event_index >= 0),
    commitment VARCHAR(10) NOT NULL CHECK (commitment IN ('confirmed', 'finalized')),
    input_mint VARCHAR(64) NOT NULL CHECK (input_mint ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
    output_mint VARCHAR(64) NOT NULL CHECK (output_mint ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
    input_amt sol_u64 NOT NULL CHECK (input_amt > 0),
    output_amt sol_u64 NOT NULL CHECK (output_amt > 0),
    fee_mint VARCHAR(64) CHECK (fee_mint ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
    fee_amt sol_u64,
    remaining_in sol_u64 NOT NULL,
    price_num wide_uint,
    price_den wide_uint,
    provider_at TIMESTAMPTZ,
    observed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (fill_key, rev),
    CHECK (num_nonnulls(fee_mint, fee_amt) IN (0, 2)),
    CHECK (num_nonnulls(price_num, price_den) IN (0, 2)),
    CHECK (price_den IS NULL OR price_den > 0),
    CHECK ((state = 'confirmed' AND commitment = 'confirmed')
        OR (state = 'finalized' AND commitment = 'finalized')
        OR state IN ('retracted', 'disputed'))
);

CREATE UNIQUE INDEX order_fills_chain_idx ON order_fills
    (cluster, signature, instruction_index, event_index, rev);
CREATE UNIQUE INDEX order_fills_provider_idx ON order_fills
    (provider, provider_fill_id, rev)
    WHERE provider_fill_id IS NOT NULL;
CREATE INDEX order_fills_order_idx ON order_fills (order_id, observed_at, id);

CREATE FUNCTION order_fill_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
    prior order_fills%ROWTYPE;
BEGIN
    IF NOT EXISTS (
        SELECT 1
          FROM order_actions action
          JOIN order_intents order_row ON order_row.id = action.order_id
         WHERE action.id = NEW.action_id
           AND action.order_id = NEW.order_id
           AND action.provider = NEW.provider
           AND order_row.input_mint = NEW.input_mint
           AND order_row.output_mint = NEW.output_mint
           AND (order_row.cluster IS NULL OR order_row.cluster = NEW.cluster)
    ) OR (NEW.leg_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM order_legs leg
         WHERE leg.id = NEW.leg_id AND leg.order_id = NEW.order_id
    )) OR NOT EXISTS (
        SELECT 1 FROM action_obs observation
         WHERE observation.id = NEW.obs_id AND observation.action_id = NEW.action_id
           AND (
               NEW.state IN ('retracted', 'disputed')
               OR (observation.source = 'chain' AND observation.query_kind = 'found'
                   AND observation.cluster = NEW.cluster
                   AND observation.signature = NEW.signature
                   AND observation.slot = NEW.slot
                   AND observation.instruction_index = NEW.instruction_index
                   AND observation.event_index = NEW.event_index
                   AND observation.commitment = NEW.commitment)
           )
    ) THEN
        RAISE EXCEPTION 'fill references cross order or action boundaries' USING ERRCODE = '23514';
    END IF;
    IF NEW.rev = 1 THEN
        IF NEW.supersedes IS NOT NULL THEN
            RAISE EXCEPTION 'first fill revision cannot supersede another fact' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
    END IF;
    SELECT * INTO prior FROM order_fills WHERE id = NEW.supersedes;
    IF NOT FOUND OR prior.fill_key <> NEW.fill_key OR NEW.rev <> prior.rev + 1
        OR prior.order_id <> NEW.order_id OR prior.action_id <> NEW.action_id
        OR prior.leg_id IS DISTINCT FROM NEW.leg_id
        OR prior.input_amt <> NEW.input_amt OR prior.output_amt <> NEW.output_amt
        OR prior.input_mint <> NEW.input_mint OR prior.output_mint <> NEW.output_mint
        OR prior.fee_mint IS DISTINCT FROM NEW.fee_mint
        OR prior.fee_amt IS DISTINCT FROM NEW.fee_amt
        OR prior.remaining_in <> NEW.remaining_in
        OR prior.price_num IS DISTINCT FROM NEW.price_num
        OR prior.price_den IS DISTINCT FROM NEW.price_den
        OR prior.provider <> NEW.provider
        OR prior.provider_fill_id IS DISTINCT FROM NEW.provider_fill_id
        OR prior.cluster <> NEW.cluster
        OR prior.signature <> NEW.signature
        OR prior.slot <> NEW.slot
        OR prior.instruction_index <> NEW.instruction_index OR prior.event_index <> NEW.event_index
        OR NOT (
            (prior.state = 'confirmed' AND NEW.state IN ('finalized', 'retracted', 'disputed'))
            OR (prior.state = 'finalized' AND NEW.state = 'disputed')
            OR (prior.state = 'disputed' AND NEW.state IN ('finalized', 'retracted'))
        ) THEN
        RAISE EXCEPTION 'invalid fill revision lineage' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER order_fills_guard
    BEFORE INSERT ON order_fills
    FOR EACH ROW EXECUTE FUNCTION order_fill_guard();
CREATE TRIGGER order_fills_immutable
    BEFORE UPDATE OR DELETE ON order_fills
    FOR EACH ROW EXECUTE FUNCTION order_deny_change();

CREATE VIEW order_fill_current AS
SELECT DISTINCT ON (fill_key) *
  FROM order_fills
 ORDER BY fill_key, rev DESC;

CREATE TABLE order_schedules (
    id UUID PRIMARY KEY,
    order_id UUID NOT NULL REFERENCES order_intents(id) ON DELETE RESTRICT,
    leg_id UUID NOT NULL REFERENCES order_legs(id) ON DELETE RESTRICT,
    round_no INTEGER NOT NULL CHECK (round_no >= 0),
    state VARCHAR(12) NOT NULL CHECK (state IN ('planned', 'due', 'attempted', 'filled', 'skipped', 'cancelled')),
    intended_in sol_u64 NOT NULL CHECK (intended_in > 0),
    filled_in sol_u64,
    filled_out sol_u64,
    due_at TIMESTAMPTZ NOT NULL,
    action_id UUID REFERENCES order_actions(id) ON DELETE RESTRICT,
    fill_id UUID REFERENCES order_fills(id) ON DELETE RESTRICT,
    reason VARCHAR(500),
    version BIGINT NOT NULL DEFAULT 0 CHECK (version >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (order_id, round_no),
    CHECK (num_nonnulls(filled_in, filled_out) IN (0, 2)),
    CHECK (filled_in IS NULL OR (filled_in > 0 AND filled_out > 0)),
    CHECK (state NOT IN ('attempted', 'filled') OR action_id IS NOT NULL),
    CHECK ((state = 'filled') = (fill_id IS NOT NULL))
);

CREATE INDEX order_schedules_due_idx ON order_schedules (due_at, id)
    WHERE state IN ('planned', 'due');

CREATE FUNCTION order_schedule_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM order_legs leg
         WHERE leg.id = NEW.leg_id AND leg.order_id = NEW.order_id
    ) OR (NEW.action_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM order_actions action
         WHERE action.id = NEW.action_id AND action.order_id = NEW.order_id
    )) OR (NEW.fill_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM order_fills fill
         WHERE fill.id = NEW.fill_id
           AND fill.order_id = NEW.order_id
           AND fill.leg_id = NEW.leg_id
           AND fill.action_id = NEW.action_id
    )) THEN
        RAISE EXCEPTION 'schedule references cross order boundaries' USING ERRCODE = '23514';
    END IF;
    IF TG_OP = 'UPDATE' THEN
        IF (to_jsonb(NEW) - ARRAY[
            'state', 'filled_in', 'filled_out', 'action_id', 'fill_id',
            'reason', 'version', 'updated_at'
        ]) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY[
            'state', 'filled_in', 'filled_out', 'action_id', 'fill_id',
            'reason', 'version', 'updated_at'
        ]) OR NEW.version <> OLD.version + 1 OR NOT (
            (OLD.state = 'planned' AND NEW.state IN ('due', 'skipped', 'cancelled'))
            OR (OLD.state = 'due' AND NEW.state IN ('attempted', 'skipped', 'cancelled'))
            OR (OLD.state = 'attempted' AND NEW.state IN ('filled', 'skipped'))
        ) THEN
            RAISE EXCEPTION 'schedule identity is immutable and version must advance by one'
                USING ERRCODE = '40001';
        END IF;
        NEW.updated_at := clock_timestamp();
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER order_schedules_guard
    BEFORE INSERT OR UPDATE ON order_schedules
    FOR EACH ROW EXECUTE FUNCTION order_schedule_guard();
CREATE TRIGGER order_schedules_no_delete
    BEFORE DELETE ON order_schedules
    FOR EACH ROW EXECUTE FUNCTION order_deny_change();

CREATE TABLE order_anomalies (
    id UUID PRIMARY KEY,
    anomaly_key VARCHAR(180) NOT NULL UNIQUE,
    order_id UUID NOT NULL REFERENCES order_intents(id) ON DELETE RESTRICT,
    action_id UUID REFERENCES order_actions(id) ON DELETE RESTRICT,
    leg_id UUID REFERENCES order_legs(id) ON DELETE RESTRICT,
    obligation_id UUID REFERENCES asset_obligations(id) ON DELETE RESTRICT,
    scope VARCHAR(16) NOT NULL CHECK (scope IN ('action', 'order', 'wallet_vault', 'provider')),
    kind VARCHAR(24) NOT NULL CHECK (kind IN (
        'duplicate_effect', 'provider_conflict', 'custody_deficit', 'fill_mismatch',
        'stale_epoch', 'policy_violation', 'event_gap', 'untracked_value'
    )),
    severity VARCHAR(8) NOT NULL CHECK (severity IN ('warning', 'critical')),
    state VARCHAR(12) NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'acknowledged', 'resolved')),
    blocks_actions BOOLEAN NOT NULL DEFAULT TRUE,
    detail_hash CHAR(64) NOT NULL CHECK (detail_hash ~ '^[0-9a-f]{64}$'),
    detail JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (pg_column_size(detail) <= 65536),
    resolution_obs UUID REFERENCES action_obs(id) ON DELETE RESTRICT,
    resolution_journal UUID REFERENCES asset_journals(id) ON DELETE RESTRICT,
    resolution_hash CHAR(64) CHECK (resolution_hash ~ '^[0-9a-f]{64}$'),
    opened_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    acked_at TIMESTAMPTZ,
    resolved_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK (
        (state = 'open' AND acked_at IS NULL AND resolved_at IS NULL
            AND num_nonnulls(resolution_obs, resolution_journal, resolution_hash) = 0)
        OR (state = 'acknowledged' AND acked_at IS NOT NULL AND resolved_at IS NULL
            AND num_nonnulls(resolution_obs, resolution_journal, resolution_hash) = 0)
        OR (state = 'resolved' AND resolved_at IS NOT NULL
            AND num_nonnulls(resolution_obs, resolution_journal, resolution_hash) = 1)
    ),
    CHECK (kind NOT IN (
        'duplicate_effect', 'provider_conflict', 'custody_deficit',
        'fill_mismatch', 'untracked_value'
    ) OR obligation_id IS NOT NULL),
    CHECK (kind NOT IN (
        'duplicate_effect', 'provider_conflict', 'custody_deficit',
        'fill_mismatch', 'untracked_value'
    ) OR blocks_actions),
    CHECK (state <> 'resolved' OR kind NOT IN (
        'duplicate_effect', 'provider_conflict', 'custody_deficit',
        'fill_mismatch', 'untracked_value'
    ) OR num_nonnulls(resolution_obs, resolution_journal) = 1)
);

CREATE INDEX order_anomalies_open_idx ON order_anomalies
    (severity DESC, opened_at, id) WHERE state <> 'resolved';
CREATE INDEX order_anomalies_order_idx ON order_anomalies (order_id, opened_at, id);

CREATE FUNCTION order_anomaly_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
    IF NEW.action_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM order_actions action
         WHERE action.id = NEW.action_id AND action.order_id = NEW.order_id
    ) THEN
        RAISE EXCEPTION 'anomaly action belongs to a different order' USING ERRCODE = '23514';
    END IF;
    IF NEW.leg_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM order_legs leg
         WHERE leg.id = NEW.leg_id AND leg.order_id = NEW.order_id
    ) THEN
        RAISE EXCEPTION 'anomaly leg belongs to a different order' USING ERRCODE = '23514';
    END IF;
    IF NEW.obligation_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM asset_obligations obligation
         WHERE obligation.id = NEW.obligation_id
           AND obligation.order_id = NEW.order_id
           AND (NEW.action_id IS NULL OR obligation.action_id = NEW.action_id)
    ) THEN
        RAISE EXCEPTION 'anomaly obligation belongs to a different order or action'
            USING ERRCODE = '23514';
    END IF;
    IF NEW.resolution_obs IS NOT NULL AND NOT EXISTS (
        SELECT 1
          FROM action_obs observation
          JOIN order_actions action ON action.id = observation.action_id
         WHERE observation.id = NEW.resolution_obs
           AND action.order_id = NEW.order_id
           AND (NEW.action_id IS NULL OR observation.action_id = NEW.action_id)
           AND (
               NEW.kind NOT IN (
                   'duplicate_effect', 'provider_conflict', 'custody_deficit',
                   'fill_mismatch', 'untracked_value'
               ) OR (
                   observation.source = 'chain'
                   AND observation.query_kind = 'found'
                   AND observation.commitment IN ('confirmed', 'finalized')
               )
           )
    ) THEN
        RAISE EXCEPTION 'anomaly resolution observation crosses its evidence boundary'
            USING ERRCODE = '23514';
    END IF;
    IF NEW.resolution_journal IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM asset_journals journal
         WHERE journal.id = NEW.resolution_journal
           AND journal.order_id = NEW.order_id
           AND (NEW.action_id IS NULL OR journal.action_id = NEW.action_id)
           AND journal.post_state = 'posted'
           AND journal.state IN ('confirmed', 'finalized')
    ) THEN
        RAISE EXCEPTION 'anomaly resolution journal crosses its accounting boundary'
            USING ERRCODE = '23514';
    END IF;
    IF NEW.state = 'resolved' AND NEW.kind IN (
        'duplicate_effect', 'provider_conflict', 'custody_deficit',
        'fill_mismatch', 'untracked_value'
    ) AND NOT EXISTS (
        SELECT 1 FROM asset_obligations obligation
         WHERE obligation.id = NEW.obligation_id AND obligation.state = 'cleared'
    ) THEN
        RAISE EXCEPTION 'financial anomaly cannot resolve while its obligation is active'
            USING ERRCODE = '23514';
    END IF;
    IF TG_OP = 'UPDATE' THEN
        IF (to_jsonb(NEW) - ARRAY[
            'state', 'resolution_obs', 'resolution_journal', 'resolution_hash',
            'acked_at', 'resolved_at', 'updated_at'
        ]) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY[
            'state', 'resolution_obs', 'resolution_journal', 'resolution_hash',
            'acked_at', 'resolved_at', 'updated_at'
        ]) OR NOT (
            (OLD.state = 'open' AND NEW.state IN ('acknowledged', 'resolved'))
            OR (OLD.state = 'acknowledged' AND NEW.state = 'resolved')
        ) THEN
            RAISE EXCEPTION 'invalid anomaly fact transition' USING ERRCODE = '23514';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER order_anomalies_guard
    BEFORE INSERT OR UPDATE ON order_anomalies
    FOR EACH ROW EXECUTE FUNCTION order_anomaly_guard();
CREATE TRIGGER order_anomalies_no_delete
    BEFORE DELETE ON order_anomalies
    FOR EACH ROW EXECUTE FUNCTION order_deny_change();

CREATE TABLE order_sync_cursors (
    id UUID PRIMARY KEY,
    user_id UUID REFERENCES users(id) ON DELETE RESTRICT,
    provider VARCHAR(32) NOT NULL,
    cluster VARCHAR(32) NOT NULL CHECK (cluster IN ('mainnet-beta', 'devnet', 'testnet', 'localnet')),
    wallet_address VARCHAR(64) NOT NULL CHECK (wallet_address ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
    stream VARCHAR(16) NOT NULL CHECK (stream IN ('orders', 'fills', 'history', 'chain')),
    cursor_value TEXT,
    cursor_hash CHAR(64) CHECK (cursor_hash ~ '^[0-9a-f]{64}$'),
    high_at TIMESTAMPTZ,
    high_slot BIGINT CHECK (high_slot BETWEEN 0 AND 9007199254740991),
    overlap_at TIMESTAMPTZ,
    checked_at TIMESTAMPTZ,
    next_at TIMESTAMPTZ,
    lease_owner VARCHAR(128),
    lease_gen BIGINT NOT NULL DEFAULT 0 CHECK (lease_gen >= 0),
    lease_until TIMESTAMPTZ,
    version BIGINT NOT NULL DEFAULT 0 CHECK (version >= 0),
    error_code VARCHAR(80),
    error_message VARCHAR(500),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (provider, cluster, wallet_address, stream),
    CHECK (cursor_value IS NULL OR octet_length(cursor_value) <= 4096),
    CHECK (num_nonnulls(lease_owner, lease_until) IN (0, 2)),
    CHECK (lease_owner IS NULL OR lease_gen > 0),
    CHECK (overlap_at IS NULL OR high_at IS NULL OR overlap_at <= high_at)
);

CREATE INDEX order_sync_due_idx ON order_sync_cursors (next_at, id)
    WHERE next_at IS NOT NULL AND lease_owner IS NULL;
CREATE INDEX order_sync_lease_idx ON order_sync_cursors (lease_until, id)
    WHERE lease_owner IS NOT NULL;

CREATE FUNCTION order_sync_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
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
        IF OLD.lease_until <= CURRENT_TIMESTAMP OR NEW.lease_owner <> OLD.lease_owner
            OR NEW.lease_until < OLD.lease_until THEN
            RAISE EXCEPTION 'sync lease renewal cannot revive or replace an expired owner'
                USING ERRCODE = '40001';
        END IF;
    ELSIF NEW.lease_gen = OLD.lease_gen + 1 THEN
        IF OLD.lease_until > CURRENT_TIMESTAMP THEN
            RAISE EXCEPTION 'an unexpired sync lease cannot be reclaimed' USING ERRCODE = '40001';
        END IF;
    ELSE
        RAISE EXCEPTION 'sync lease generation must remain stable or advance by one'
            USING ERRCODE = '40001';
    END IF;
    NEW.updated_at := clock_timestamp();
    RETURN NEW;
END;
$$;

CREATE TRIGGER order_sync_cursors_guard
    BEFORE UPDATE ON order_sync_cursors
    FOR EACH ROW EXECUTE FUNCTION order_sync_guard();

CREATE TABLE order_event_keys (
    event_key VARCHAR(180) PRIMARY KEY,
    event_id UUID NOT NULL UNIQUE,
    order_id UUID NOT NULL REFERENCES order_intents(id) ON DELETE RESTRICT,
    action_id UUID REFERENCES order_actions(id) ON DELETE RESTRICT,
    event_type VARCHAR(64) NOT NULL,
    order_ver BIGINT NOT NULL CHECK (order_ver >= 0),
    event_hash CHAR(64) NOT NULL CHECK (event_hash ~ '^[0-9a-f]{64}$'),
    occurred_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX order_event_keys_order_idx ON order_event_keys (order_id, order_ver, occurred_at, event_id);

CREATE FUNCTION order_event_key_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
    IF NEW.action_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM order_actions action
         WHERE action.id = NEW.action_id AND action.order_id = NEW.order_id
    ) THEN
        RAISE EXCEPTION 'event action belongs to a different order' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER order_event_keys_guard
    BEFORE INSERT ON order_event_keys
    FOR EACH ROW EXECUTE FUNCTION order_event_key_guard();
CREATE TRIGGER order_event_keys_immutable
    BEFORE UPDATE OR DELETE ON order_event_keys
    FOR EACH ROW EXECUTE FUNCTION order_deny_change();

ALTER TABLE order_events
    ADD COLUMN event_key VARCHAR(180),
    ADD COLUMN event_type VARCHAR(64),
    ADD COLUMN event_hash CHAR(64),
    ADD COLUMN order_ver BIGINT,
    ADD COLUMN action_id UUID,
    ADD COLUMN trace_id VARCHAR(64),
    ADD COLUMN actor_kind VARCHAR(16),
    ADD CONSTRAINT order_events_target_shape CHECK (
        event_key IS NULL OR (
            event_type IS NOT NULL AND event_hash ~ '^[0-9a-f]{64}$'
            AND order_ver >= 0 AND trace_id IS NOT NULL
            AND actor_kind IN ('user', 'system', 'provider', 'chain', 'operator')
        )
    ) NOT VALID;

CREATE FUNCTION order_event_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
    IF TG_OP IN ('UPDATE', 'DELETE') THEN
        IF OLD.event_key IS NOT NULL THEN
            RAISE EXCEPTION 'target order events are append-only' USING ERRCODE = '55000';
        END IF;
        RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
    END IF;
    IF NEW.event_key IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM order_event_keys event
         WHERE event.event_key = NEW.event_key
           AND event.event_id = NEW.id
           AND event.order_id = NEW.order_id
           AND event.action_id IS NOT DISTINCT FROM NEW.action_id
           AND event.event_type = NEW.event_type
           AND event.order_ver = NEW.order_ver
           AND event.event_hash = NEW.event_hash
           AND event.occurred_at = NEW.occurred_at
    ) THEN
        RAISE EXCEPTION 'order event does not match its deterministic identity' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER order_events_guard
    BEFORE INSERT OR UPDATE OR DELETE ON order_events
    FOR EACH ROW EXECUTE FUNCTION order_event_guard();

COMMENT ON TABLE order_actions IS
    'Durable desired external effects and local scheduling; attempts and observations remain separate facts';
COMMENT ON TABLE action_attempts IS
    'Outbound call identity with append-once prepared, started, and response facts';
COMMENT ON TABLE action_obs IS
    'Immutable provider and chain observations; HTTP response alone is not semantic effect proof';
COMMENT ON TABLE order_tx_blobs IS
    'Envelope-encrypted signed transaction bytes; plaintext is forbidden from PostgreSQL, Redis, and logs';
COMMENT ON TABLE order_epochs IS
    'Append-only regional write-fence history; gateway dispatch requires the latest live epoch';
COMMENT ON COLUMN order_intents.funds_state IS
    'Derived display projection only; never authority for mutation, retry, withdrawal, or settlement';
