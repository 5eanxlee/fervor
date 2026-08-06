-- Stride fresh schema baseline.
-- stride: destructive-review=legacy-v1-constraint-replacement
--
-- Populated pre-Flyway databases use the separately verified baseline workflow.
-- Replaying idempotent DDL over them could bless drift and retain broad locks.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';
SET LOCAL idle_in_transaction_session_timeout = '60s';
SET LOCAL search_path = public;

DO $migration$
DECLARE
    object_count integer;
BEGIN
    SELECT count(*)::integer
      INTO object_count
      FROM (
        SELECT c.oid
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public'
           AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f', 'c')
        UNION ALL
        SELECT p.oid
          FROM pg_proc p
          JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public'
           AND NOT EXISTS (
             SELECT 1 FROM pg_depend d
              WHERE d.classid = 'pg_proc'::regclass
                AND d.objid = p.oid AND d.deptype = 'e'
           )
        UNION ALL
        SELECT t.oid
          FROM pg_type t
          JOIN pg_namespace n ON n.oid = t.typnamespace
         WHERE n.nspname = 'public'
           AND t.typrelid = 0
           AND NOT EXISTS (
             SELECT 1 FROM pg_depend d
              WHERE d.classid = 'pg_type'::regclass
                AND d.objid = t.oid AND d.deptype IN ('e', 'i')
           )
        UNION ALL
        SELECT o.oid
          FROM pg_operator o
          JOIN pg_namespace n ON n.oid = o.oprnamespace
         WHERE n.nspname = 'public'
        UNION ALL
        SELECT c.oid
          FROM pg_collation c
          JOIN pg_namespace n ON n.oid = c.collnamespace
         WHERE n.nspname = 'public'
        UNION ALL
        SELECT e.oid
          FROM pg_extension e
          JOIN pg_namespace n ON n.oid = e.extnamespace
         WHERE n.nspname = 'public'
        UNION ALL
        SELECT d.oid
          FROM pg_default_acl d
          LEFT JOIN pg_namespace n ON n.oid = d.defaclnamespace
         WHERE d.defaclrole = current_user::regrole
           AND (d.defaclnamespace = 0 OR n.nspname = 'public')
      ) application_object;

    IF object_count <> 0 THEN
        RAISE EXCEPTION
          'V001 requires an empty public schema; use the verified legacy adoption workflow (% application objects found)',
          object_count;
    END IF;
END
$migration$;

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        wallet_address VARCHAR(44) UNIQUE,
        email VARCHAR(255),
        telegram_chat_id VARCHAR(255) UNIQUE,
        discord_user_id VARCHAR(255) UNIQUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

CREATE TABLE IF NOT EXISTS token_alerts (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID REFERENCES users(id) ON DELETE CASCADE,
        token_address VARCHAR(44) NOT NULL,
        token_name VARCHAR(255),
        token_symbol VARCHAR(10),
        threshold_type VARCHAR(32) NOT NULL CHECK (threshold_type IN ('price', 'market_cap', 'liquidity', 'volume_1m', 'volume_5m', 'volume_1h', 'volume_6h', 'volume_24h', 'buy_count_1m', 'buy_count_5m', 'buy_count_1h', 'buy_count_6h', 'buy_count_24h', 'sell_count_1m', 'sell_count_5m', 'sell_count_1h', 'sell_count_6h', 'sell_count_24h', 'tx_count_1m', 'tx_count_5m', 'tx_count_1h', 'tx_count_6h', 'tx_count_24h')),
        threshold_value DECIMAL(20, 8) NOT NULL,
        condition VARCHAR(10) NOT NULL CHECK (condition IN ('above', 'below')),
        notification_type VARCHAR(20) NOT NULL DEFAULT 'email',
        circulating_supply DECIMAL(30, 8),
        current_market_cap DECIMAL(30, 2),
        is_active BOOLEAN DEFAULT TRUE,
        is_triggered BOOLEAN DEFAULT FALSE,
        triggered_at TIMESTAMP,
        cleared_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

CREATE TABLE IF NOT EXISTS token_data (
        address VARCHAR(44) PRIMARY KEY,
        name VARCHAR(255),
        symbol VARCHAR(10),
        price DECIMAL(20, 8),
        market_cap DECIMAL(30, 2),
        last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

ALTER TABLE token_alerts DROP CONSTRAINT IF EXISTS token_alerts_threshold_type_check;
      ALTER TABLE token_alerts ALTER COLUMN threshold_type TYPE VARCHAR(32);
      ALTER TABLE token_alerts ADD CONSTRAINT token_alerts_threshold_type_check
        CHECK (threshold_type IN ('price', 'market_cap', 'liquidity', 'volume_1m', 'volume_5m', 'volume_1h', 'volume_6h', 'volume_24h', 'buy_count_1m', 'buy_count_5m', 'buy_count_1h', 'buy_count_6h', 'buy_count_24h', 'sell_count_1m', 'sell_count_5m', 'sell_count_1h', 'sell_count_6h', 'sell_count_24h', 'tx_count_1m', 'tx_count_5m', 'tx_count_1h', 'tx_count_6h', 'tx_count_24h'));

CREATE TABLE IF NOT EXISTS tokens (
        mint VARCHAR(64) PRIMARY KEY,
        decimals INTEGER,
        name VARCHAR(255),
        symbol VARCHAR(32),
        image TEXT,
        metadata_uri TEXT,
        socials JSONB,
        creator VARCHAR(64),
        deployer VARCHAR(64),
        launchpad VARCHAR(64),
        lifecycle_status VARCHAR(32),
        price_usd DECIMAL(30, 12),
        price_sol DECIMAL(30, 12),
        market_cap_usd DECIMAL(30, 2),
        fdv_usd DECIMAL(30, 2),
        liquidity_usd DECIMAL(30, 2),
        total_supply DECIMAL(40, 8),
        circulating_supply DECIMAL(40, 8),
        source VARCHAR(64),
        observed_at TIMESTAMP,
        stale BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

CREATE TABLE IF NOT EXISTS token_metadata (
        mint VARCHAR(64) PRIMARY KEY REFERENCES tokens(mint) ON DELETE CASCADE,
        name VARCHAR(255),
        symbol VARCHAR(32),
        decimals INTEGER,
        image TEXT,
        metadata_uri TEXT,
        description TEXT,
        socials JSONB,
        source VARCHAR(64),
        observed_at TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

CREATE TABLE IF NOT EXISTS pools (
        pool_address VARCHAR(64) PRIMARY KEY,
        protocol VARCHAR(64) NOT NULL,
        base_mint VARCHAR(64) NOT NULL,
        quote_mint VARCHAR(64),
        launchpad VARCHAR(64),
        lifecycle_status VARCHAR(32),
        source VARCHAR(64),
        source_event_id VARCHAR(180),
        observed_at TIMESTAMP,
        received_at TIMESTAMP,
        confidence DECIMAL(5, 4),
        stale BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

CREATE TABLE IF NOT EXISTS pool_accounts (
        pool_address VARCHAR(64) REFERENCES pools(pool_address) ON DELETE CASCADE,
        account_role VARCHAR(64) NOT NULL,
        account_address VARCHAR(64) NOT NULL,
        source VARCHAR(64),
        observed_at TIMESTAMP,
        PRIMARY KEY (pool_address, account_role)
      );

CREATE TABLE IF NOT EXISTS trades (
        id UUID DEFAULT gen_random_uuid(),
        idempotency_key VARCHAR(64) NOT NULL,
        token_mint VARCHAR(64) NOT NULL,
        pool_address VARCHAR(64),
        protocol VARCHAR(64),
        maker VARCHAR(64),
        side VARCHAR(10) CHECK (side IN ('buy', 'sell')),
        token_amount DECIMAL(40, 12),
        sol_amount DECIMAL(40, 12),
        usd_amount DECIMAL(40, 12),
        price_sol DECIMAL(30, 12),
        price_usd DECIMAL(30, 12),
        signature VARCHAR(128),
        slot BIGINT,
        instruction_index INTEGER DEFAULT 0,
        event_index INTEGER DEFAULT 0,
        source VARCHAR(64) NOT NULL,
        source_event_id VARCHAR(180) NOT NULL,
        observed_at TIMESTAMP NOT NULL,
        received_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        confidence DECIMAL(5, 4),
        stale BOOLEAN DEFAULT FALSE
      ) PARTITION BY RANGE (observed_at);

CREATE TABLE IF NOT EXISTS trades_default PARTITION OF trades DEFAULT;

ALTER TABLE trades ADD COLUMN IF NOT EXISTS quote_mint VARCHAR(64);
      ALTER TABLE trades ADD COLUMN IF NOT EXISTS quote_amount DECIMAL(40, 12);
      ALTER TABLE trades ADD COLUMN IF NOT EXISTS token_amount_raw NUMERIC(78, 0);
      ALTER TABLE trades ADD COLUMN IF NOT EXISTS quote_amount_raw NUMERIC(78, 0);
      ALTER TABLE trades ADD COLUMN IF NOT EXISTS token_decimals INTEGER;
      ALTER TABLE trades ADD COLUMN IF NOT EXISTS quote_decimals INTEGER;
      ALTER TABLE trades ADD COLUMN IF NOT EXISTS program_id VARCHAR(64);
      ALTER TABLE trades ADD COLUMN IF NOT EXISTS route JSONB;
      ALTER TABLE trades ADD COLUMN IF NOT EXISTS quote_kind VARCHAR(24);
      ALTER TABLE trades ADD COLUMN IF NOT EXISTS decode_version VARCHAR(32);
      ALTER TABLE trades ADD COLUMN IF NOT EXISTS compute_units BIGINT;

CREATE TABLE IF NOT EXISTS market_state_snapshots (
        id UUID DEFAULT gen_random_uuid(),
        idempotency_key VARCHAR(64) NOT NULL,
        token_mint VARCHAR(64) NOT NULL,
        pool_address VARCHAR(64),
        protocol VARCHAR(64),
        price_usd DECIMAL(30, 12),
        price_sol DECIMAL(30, 12),
        market_cap_usd DECIMAL(30, 2),
        fdv_usd DECIMAL(30, 2),
        liquidity_usd DECIMAL(30, 2),
        liquidity_sol DECIMAL(30, 12),
        total_supply DECIMAL(40, 8),
        circulating_supply DECIMAL(40, 8),
        source VARCHAR(64) NOT NULL,
        source_event_id VARCHAR(180) NOT NULL,
        signature VARCHAR(128),
        slot BIGINT,
        observed_at TIMESTAMP NOT NULL,
        received_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        confidence DECIMAL(5, 4),
        stale BOOLEAN DEFAULT FALSE
      ) PARTITION BY RANGE (observed_at);

CREATE TABLE IF NOT EXISTS market_state_snapshots_default PARTITION OF market_state_snapshots DEFAULT;

ALTER TABLE market_state_snapshots ADD COLUMN IF NOT EXISTS volume_usd JSONB;
      ALTER TABLE market_state_snapshots ADD COLUMN IF NOT EXISTS buy_count JSONB;
      ALTER TABLE market_state_snapshots ADD COLUMN IF NOT EXISTS sell_count JSONB;
      ALTER TABLE market_state_snapshots ADD COLUMN IF NOT EXISTS tx_count JSONB;
      ALTER TABLE market_state_snapshots ADD COLUMN IF NOT EXISTS unique_buyers JSONB;
      ALTER TABLE market_state_snapshots ADD COLUMN IF NOT EXISTS unique_sellers JSONB;

CREATE TABLE IF NOT EXISTS candles (
        id UUID DEFAULT gen_random_uuid(),
        token_mint VARCHAR(64) NOT NULL,
        pool_address VARCHAR(64),
        interval_name VARCHAR(8) NOT NULL,
        bucket_start TIMESTAMP NOT NULL,
        open_at TIMESTAMP,
        close_at TIMESTAMP,
        open_usd DECIMAL(30, 12),
        high_usd DECIMAL(30, 12),
        low_usd DECIMAL(30, 12),
        close_usd DECIMAL(30, 12),
        volume_usd DECIMAL(40, 12),
        buy_count INTEGER DEFAULT 0,
        sell_count INTEGER DEFAULT 0,
        tx_count INTEGER DEFAULT 0,
        source VARCHAR(64) NOT NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      ) PARTITION BY RANGE (bucket_start);

CREATE TABLE IF NOT EXISTS candles_default PARTITION OF candles DEFAULT;

ALTER TABLE candles ADD COLUMN IF NOT EXISTS open_at TIMESTAMP;
      ALTER TABLE candles ADD COLUMN IF NOT EXISTS close_at TIMESTAMP;
      ALTER TABLE candles ADD COLUMN IF NOT EXISTS open_key VARCHAR(128);
      ALTER TABLE candles ADD COLUMN IF NOT EXISTS close_key VARCHAR(128);

CREATE TABLE IF NOT EXISTS candle_projection_events (
        idempotency_key VARCHAR(128) PRIMARY KEY,
        token_mint VARCHAR(64) NOT NULL,
        source_event_id VARCHAR(180) NOT NULL,
        observed_at TIMESTAMP NOT NULL,
        projected_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      ) PARTITION BY HASH (idempotency_key);

CREATE TABLE IF NOT EXISTS candle_projection_events_0
        PARTITION OF candle_projection_events FOR VALUES WITH (MODULUS 32, REMAINDER 0);

CREATE TABLE IF NOT EXISTS candle_projection_events_1
        PARTITION OF candle_projection_events FOR VALUES WITH (MODULUS 32, REMAINDER 1);

CREATE TABLE IF NOT EXISTS candle_projection_events_2
        PARTITION OF candle_projection_events FOR VALUES WITH (MODULUS 32, REMAINDER 2);

CREATE TABLE IF NOT EXISTS candle_projection_events_3
        PARTITION OF candle_projection_events FOR VALUES WITH (MODULUS 32, REMAINDER 3);

CREATE TABLE IF NOT EXISTS candle_projection_events_4
        PARTITION OF candle_projection_events FOR VALUES WITH (MODULUS 32, REMAINDER 4);

CREATE TABLE IF NOT EXISTS candle_projection_events_5
        PARTITION OF candle_projection_events FOR VALUES WITH (MODULUS 32, REMAINDER 5);

CREATE TABLE IF NOT EXISTS candle_projection_events_6
        PARTITION OF candle_projection_events FOR VALUES WITH (MODULUS 32, REMAINDER 6);

CREATE TABLE IF NOT EXISTS candle_projection_events_7
        PARTITION OF candle_projection_events FOR VALUES WITH (MODULUS 32, REMAINDER 7);

CREATE TABLE IF NOT EXISTS candle_projection_events_8
        PARTITION OF candle_projection_events FOR VALUES WITH (MODULUS 32, REMAINDER 8);

CREATE TABLE IF NOT EXISTS candle_projection_events_9
        PARTITION OF candle_projection_events FOR VALUES WITH (MODULUS 32, REMAINDER 9);

CREATE TABLE IF NOT EXISTS candle_projection_events_10
        PARTITION OF candle_projection_events FOR VALUES WITH (MODULUS 32, REMAINDER 10);

CREATE TABLE IF NOT EXISTS candle_projection_events_11
        PARTITION OF candle_projection_events FOR VALUES WITH (MODULUS 32, REMAINDER 11);

CREATE TABLE IF NOT EXISTS candle_projection_events_12
        PARTITION OF candle_projection_events FOR VALUES WITH (MODULUS 32, REMAINDER 12);

CREATE TABLE IF NOT EXISTS candle_projection_events_13
        PARTITION OF candle_projection_events FOR VALUES WITH (MODULUS 32, REMAINDER 13);

CREATE TABLE IF NOT EXISTS candle_projection_events_14
        PARTITION OF candle_projection_events FOR VALUES WITH (MODULUS 32, REMAINDER 14);

CREATE TABLE IF NOT EXISTS candle_projection_events_15
        PARTITION OF candle_projection_events FOR VALUES WITH (MODULUS 32, REMAINDER 15);

CREATE TABLE IF NOT EXISTS candle_projection_events_16
        PARTITION OF candle_projection_events FOR VALUES WITH (MODULUS 32, REMAINDER 16);

CREATE TABLE IF NOT EXISTS candle_projection_events_17
        PARTITION OF candle_projection_events FOR VALUES WITH (MODULUS 32, REMAINDER 17);

CREATE TABLE IF NOT EXISTS candle_projection_events_18
        PARTITION OF candle_projection_events FOR VALUES WITH (MODULUS 32, REMAINDER 18);

CREATE TABLE IF NOT EXISTS candle_projection_events_19
        PARTITION OF candle_projection_events FOR VALUES WITH (MODULUS 32, REMAINDER 19);

CREATE TABLE IF NOT EXISTS candle_projection_events_20
        PARTITION OF candle_projection_events FOR VALUES WITH (MODULUS 32, REMAINDER 20);

CREATE TABLE IF NOT EXISTS candle_projection_events_21
        PARTITION OF candle_projection_events FOR VALUES WITH (MODULUS 32, REMAINDER 21);

CREATE TABLE IF NOT EXISTS candle_projection_events_22
        PARTITION OF candle_projection_events FOR VALUES WITH (MODULUS 32, REMAINDER 22);

CREATE TABLE IF NOT EXISTS candle_projection_events_23
        PARTITION OF candle_projection_events FOR VALUES WITH (MODULUS 32, REMAINDER 23);

CREATE TABLE IF NOT EXISTS candle_projection_events_24
        PARTITION OF candle_projection_events FOR VALUES WITH (MODULUS 32, REMAINDER 24);

CREATE TABLE IF NOT EXISTS candle_projection_events_25
        PARTITION OF candle_projection_events FOR VALUES WITH (MODULUS 32, REMAINDER 25);

CREATE TABLE IF NOT EXISTS candle_projection_events_26
        PARTITION OF candle_projection_events FOR VALUES WITH (MODULUS 32, REMAINDER 26);

CREATE TABLE IF NOT EXISTS candle_projection_events_27
        PARTITION OF candle_projection_events FOR VALUES WITH (MODULUS 32, REMAINDER 27);

CREATE TABLE IF NOT EXISTS candle_projection_events_28
        PARTITION OF candle_projection_events FOR VALUES WITH (MODULUS 32, REMAINDER 28);

CREATE TABLE IF NOT EXISTS candle_projection_events_29
        PARTITION OF candle_projection_events FOR VALUES WITH (MODULUS 32, REMAINDER 29);

CREATE TABLE IF NOT EXISTS candle_projection_events_30
        PARTITION OF candle_projection_events FOR VALUES WITH (MODULUS 32, REMAINDER 30);

CREATE TABLE IF NOT EXISTS candle_projection_events_31
        PARTITION OF candle_projection_events FOR VALUES WITH (MODULUS 32, REMAINDER 31);

CREATE TABLE IF NOT EXISTS liquidity_snapshots (
        id UUID DEFAULT gen_random_uuid(),
        idempotency_key VARCHAR(64) NOT NULL,
        token_mint VARCHAR(64) NOT NULL,
        pool_address VARCHAR(64),
        protocol VARCHAR(64),
        token_reserve DECIMAL(40, 12),
        sol_reserve DECIMAL(40, 12),
        liquidity_usd DECIMAL(30, 2),
        liquidity_sol DECIMAL(30, 12),
        change_type VARCHAR(16),
        source VARCHAR(64) NOT NULL,
        source_event_id VARCHAR(180) NOT NULL,
        signature VARCHAR(128),
        slot BIGINT,
        observed_at TIMESTAMP NOT NULL,
        received_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        confidence DECIMAL(5, 4),
        stale BOOLEAN DEFAULT FALSE
      ) PARTITION BY RANGE (observed_at);

CREATE TABLE IF NOT EXISTS liquidity_snapshots_default PARTITION OF liquidity_snapshots DEFAULT;

CREATE TABLE IF NOT EXISTS provider_checkpoints (
        provider VARCHAR(64) NOT NULL,
        subscription_id VARCHAR(180) NOT NULL,
        region VARCHAR(32),
        commitment VARCHAR(20) NOT NULL,
        last_processed_slot BIGINT NOT NULL DEFAULT 0,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (provider, subscription_id)
      );

CREATE TABLE IF NOT EXISTS provider_event_errors (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        provider VARCHAR(64) NOT NULL,
        source_event_id VARCHAR(180),
        event_type VARCHAR(64),
        slot BIGINT,
        signature VARCHAR(128),
        error_class VARCHAR(120) NOT NULL,
        error_message TEXT NOT NULL,
        payload_summary JSONB,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

CREATE TABLE IF NOT EXISTS notification_queue (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        alert_id UUID REFERENCES token_alerts(id) ON DELETE CASCADE,
        type VARCHAR(20) NOT NULL,
        recipient VARCHAR(255) NOT NULL,
        subject VARCHAR(255),
        message TEXT NOT NULL,
        status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
        attempts INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        sent_at TIMESTAMP
      );

CREATE TABLE IF NOT EXISTS user_email_addresses (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        email VARCHAR(320) NOT NULL,
        email_hash VARCHAR(64) NOT NULL,
        status VARCHAR(32) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'unsubscribed', 'bounced', 'spam_reported', 'suppressed', 'removed')),
        is_primary BOOLEAN NOT NULL DEFAULT FALSE,
        enable_alerts_after_verification BOOLEAN NOT NULL DEFAULT FALSE,
        verified_at TIMESTAMP,
        verification_token_hash VARCHAR(64),
        verification_expires_at TIMESTAMP,
        last_verification_sent_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, email_hash)
      );

CREATE TABLE IF NOT EXISTS user_notification_preferences (
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        channel VARCHAR(20) NOT NULL CHECK (channel IN ('email', 'telegram', 'discord', 'extension')),
        enabled BOOLEAN NOT NULL DEFAULT FALSE,
        alert_notifications_enabled BOOLEAN NOT NULL DEFAULT TRUE,
        marketing_enabled BOOLEAN NOT NULL DEFAULT FALSE,
        locale VARCHAR(16) NOT NULL DEFAULT 'en',
        timezone VARCHAR(64) NOT NULL DEFAULT 'UTC',
        quiet_hours JSONB,
        digest_mode VARCHAR(20) NOT NULL DEFAULT 'instant' CHECK (digest_mode IN ('instant', 'hourly', 'daily')),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY(user_id, channel)
      );

ALTER TABLE user_email_addresses ADD COLUMN IF NOT EXISTS enable_alerts_after_verification BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS email_suppressions (
        email_hash VARCHAR(64) PRIMARY KEY,
        user_id UUID REFERENCES users(id) ON DELETE SET NULL,
        scope VARCHAR(32) NOT NULL DEFAULT 'alerts' CHECK (scope IN ('alerts', 'marketing', 'all')),
        reason VARCHAR(40) NOT NULL CHECK (reason IN ('unsubscribe', 'bounce', 'spam_report', 'dropped', 'admin', 'gdpr_delete')),
        source VARCHAR(40) NOT NULL CHECK (source IN ('sendgrid_webhook', 'unsubscribe_link', 'admin', 'migration')),
        suppressed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        metadata JSONB
      );

CREATE TABLE IF NOT EXISTS monitored_tokens (
        token_address VARCHAR(44) PRIMARY KEY,
        token_name VARCHAR(255),
        token_symbol VARCHAR(10),
        active_alert_count INTEGER NOT NULL DEFAULT 0,
        shard_id INTEGER NOT NULL DEFAULT 0,
        shard_count INTEGER NOT NULL DEFAULT 1,
        status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'disabled')),
        last_subscribed_at TIMESTAMP,
        last_tick_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

CREATE TABLE IF NOT EXISTS token_ticks (
        id UUID DEFAULT gen_random_uuid(),
        token_address VARCHAR(44) NOT NULL,
        signature VARCHAR(128) NOT NULL,
        slot BIGINT,
        block_time TIMESTAMP,
        price DECIMAL(30, 12),
        market_cap DECIMAL(30, 2),
        usd_value DECIMAL(30, 8),
        swap_type VARCHAR(10),
        received_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      ) PARTITION BY RANGE (received_at);

CREATE TABLE IF NOT EXISTS token_ticks_default PARTITION OF token_ticks DEFAULT;

CREATE TABLE IF NOT EXISTS alert_events (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        alert_id UUID REFERENCES token_alerts(id) ON DELETE CASCADE,
        user_id UUID REFERENCES users(id) ON DELETE CASCADE,
        token_address VARCHAR(44) NOT NULL,
        threshold_type VARCHAR(20) NOT NULL,
        threshold_value DECIMAL(20, 8) NOT NULL,
        condition VARCHAR(10) NOT NULL,
        current_value DECIMAL(30, 12) NOT NULL,
        notification_type VARCHAR(20) NOT NULL CHECK (notification_type IN ('email', 'telegram', 'discord', 'extension')),
        idempotency_key VARCHAR(64) UNIQUE NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

CREATE TABLE IF NOT EXISTS trade_quotes (
        id UUID PRIMARY KEY,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        wallet_address VARCHAR(44) NOT NULL,
        provider VARCHAR(32) NOT NULL,
        provider_quote_id VARCHAR(180) NOT NULL,
        input_mint VARCHAR(64) NOT NULL,
        output_mint VARCHAR(64) NOT NULL,
        input_amount NUMERIC(78, 0) NOT NULL,
        output_amount NUMERIC(78, 0) NOT NULL,
        min_output_amount NUMERIC(78, 0) NOT NULL,
        slippage_bps INTEGER NOT NULL,
        fee_payer VARCHAR(64),
        transaction_digest CHAR(64) NOT NULL,
        integrity_digest CHAR(64) NOT NULL,
        state VARCHAR(20) NOT NULL DEFAULT 'quoted' CHECK (state IN ('quoted', 'consumed', 'expired')),
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

CREATE TABLE IF NOT EXISTS trade_executions (
        id UUID PRIMARY KEY,
        quote_id UUID NOT NULL UNIQUE REFERENCES trade_quotes(id) ON DELETE RESTRICT,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        wallet_address VARCHAR(44) NOT NULL,
        provider VARCHAR(32) NOT NULL,
        idempotency_key VARCHAR(128) NOT NULL,
        state VARCHAR(20) NOT NULL CHECK (state IN ('signed', 'submitted', 'processed', 'confirmed', 'finalized', 'failed', 'expired', 'replaced')),
        signature VARCHAR(128),
        input_mint VARCHAR(64) NOT NULL,
        output_mint VARCHAR(64) NOT NULL,
        expected_input_amount NUMERIC(78, 0) NOT NULL,
        expected_output_amount NUMERIC(78, 0) NOT NULL,
        actual_input_amount NUMERIC(78, 0),
        actual_output_amount NUMERIC(78, 0),
        signed_tx_digest CHAR(64) NOT NULL,
        error_code VARCHAR(80),
        error_message VARCHAR(500),
        op_token VARCHAR(64),
        op_lease_until TIMESTAMPTZ,
        provider_status VARCHAR(80),
        submitted_at TIMESTAMPTZ,
        confirmed_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, idempotency_key)
      );

CREATE TABLE IF NOT EXISTS execution_events (
        id UUID DEFAULT gen_random_uuid(),
        execution_id UUID NOT NULL REFERENCES trade_executions(id) ON DELETE CASCADE,
        state VARCHAR(20) NOT NULL,
        trace_id VARCHAR(64) NOT NULL,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        occurred_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      ) PARTITION BY RANGE (occurred_at);

CREATE TABLE IF NOT EXISTS execution_events_default PARTITION OF execution_events DEFAULT;

CREATE TABLE IF NOT EXISTS order_intents (
        id UUID PRIMARY KEY,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        provider VARCHAR(32) NOT NULL,
        provider_order_id VARCHAR(180),
        client_order_id VARCHAR(128) NOT NULL,
        request_digest CHAR(64) NOT NULL,
        wallet_address VARCHAR(44) NOT NULL,
        order_type VARCHAR(20) NOT NULL CHECK (order_type IN ('single', 'oco')),
        state VARCHAR(24) NOT NULL CHECK (state IN ('preparing', 'prepared', 'activating', 'open', 'executing', 'partially_filled', 'filled', 'cancel_pending', 'cancelled', 'expired', 'failed')),
        input_mint VARCHAR(64) NOT NULL,
        output_mint VARCHAR(64) NOT NULL,
        input_amount NUMERIC(78, 0) NOT NULL,
        trigger_mint VARCHAR(64) NOT NULL,
        params JSONB NOT NULL,
        deposit_request_id VARCHAR(180),
        prepared_tx TEXT,
        receiver_address VARCHAR(64),
        deposit_signature VARCHAR(128),
        fill_signature VARCHAR(128),
        cancel_request_id VARCHAR(180),
        cancel_tx TEXT,
        cancel_signature VARCHAR(128),
        raw_state VARCHAR(80),
        error_code VARCHAR(80),
        error_message VARCHAR(500),
        op_token VARCHAR(64),
        op_lease_until TIMESTAMPTZ,
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, client_order_id),
        UNIQUE(provider, provider_order_id)
      );

CREATE TABLE IF NOT EXISTS order_events (
        id UUID DEFAULT gen_random_uuid(),
        order_id UUID NOT NULL REFERENCES order_intents(id) ON DELETE CASCADE,
        state VARCHAR(24) NOT NULL,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        occurred_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      ) PARTITION BY RANGE (occurred_at);

CREATE TABLE IF NOT EXISTS order_events_default PARTITION OF order_events DEFAULT;

CREATE TABLE IF NOT EXISTS wallet_sources (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        wallet_address VARCHAR(44) NOT NULL UNIQUE,
        provider VARCHAR(32) NOT NULL,
        status VARCHAR(16) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'error')),
        last_signature VARCHAR(128),
        last_slot BIGINT,
        backfill_before VARCHAR(128),
        backfill_pages INTEGER NOT NULL DEFAULT 0,
        backfill_complete BOOLEAN NOT NULL DEFAULT FALSE,
        last_polled_at TIMESTAMPTZ,
        error_code VARCHAR(80),
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

CREATE TABLE IF NOT EXISTS tracked_wallets (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        source_id UUID NOT NULL REFERENCES wallet_sources(id) ON DELETE CASCADE,
        label VARCHAR(64),
        notify BOOLEAN NOT NULL DEFAULT FALSE,
        status VARCHAR(16) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused')),
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, source_id)
      );

CREATE TABLE IF NOT EXISTS wallet_activity (
        id UUID DEFAULT gen_random_uuid(),
        idempotency_key VARCHAR(180) NOT NULL,
        source_id UUID NOT NULL REFERENCES wallet_sources(id) ON DELETE CASCADE,
        kind VARCHAR(24) NOT NULL CHECK (kind IN ('swap', 'transfer_in', 'transfer_out')),
        token_mint VARCHAR(64),
        side VARCHAR(8) CHECK (side IN ('buy', 'sell')),
        quantity_base NUMERIC(78, 0),
        value_micro_usd NUMERIC(78, 0),
        signature VARCHAR(128) NOT NULL,
        slot BIGINT,
        instruction_index INTEGER NOT NULL DEFAULT 0,
        event_index INTEGER NOT NULL DEFAULT 0,
        provider VARCHAR(32) NOT NULL,
        raw_summary JSONB,
        occurred_at TIMESTAMPTZ NOT NULL,
        received_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      ) PARTITION BY RANGE (occurred_at);

CREATE TABLE IF NOT EXISTS wallet_activity_default PARTITION OF wallet_activity DEFAULT;

CREATE TABLE IF NOT EXISTS wallet_positions (
        source_id UUID NOT NULL REFERENCES wallet_sources(id) ON DELETE CASCADE,
        token_mint VARCHAR(64) NOT NULL,
        quantity_base NUMERIC(78, 0) NOT NULL DEFAULT 0,
        cost_micro_usd NUMERIC(78, 0) NOT NULL DEFAULT 0,
        realized_pnl_micro_usd NUMERIC(78, 0) NOT NULL DEFAULT 0,
        untracked_sold_base NUMERIC(78, 0) NOT NULL DEFAULT 0,
        lots JSONB NOT NULL DEFAULT '[]'::jsonb,
        last_activity_at TIMESTAMPTZ,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (source_id, token_mint)
      );

CREATE TABLE IF NOT EXISTS notification_deliveries (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        alert_event_id UUID REFERENCES alert_events(id) ON DELETE CASCADE,
        alert_id UUID REFERENCES token_alerts(id) ON DELETE CASCADE,
        channel VARCHAR(20) NOT NULL CHECK (channel IN ('email', 'telegram', 'discord', 'extension')),
        idempotency_key VARCHAR(128) UNIQUE NOT NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'accepted', 'processed', 'delivered', 'deferred', 'retry_scheduled', 'suppressed', 'sent', 'failed', 'dead_lettered')),
        user_id UUID REFERENCES users(id) ON DELETE SET NULL,
        provider VARCHAR(32),
        provider_message_id VARCHAR(255),
        provider_status VARCHAR(64),
        recipient_hash VARCHAR(64),
        template_id VARCHAR(128),
        locale VARCHAR(16),
        timezone VARCHAR(64),
        next_attempt_at TIMESTAMP,
        last_attempt_at TIMESTAMP,
        max_attempts INTEGER NOT NULL DEFAULT 5,
        retry_seq INTEGER NOT NULL DEFAULT 0,
        region VARCHAR(32),
        metadata JSONB,
        attempts INTEGER NOT NULL DEFAULT 0,
        error_message TEXT,
        sent_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

CREATE TABLE IF NOT EXISTS event_outbox (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        stream VARCHAR(80) NOT NULL,
        event_key VARCHAR(180) NOT NULL,
        payload JSONB NOT NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'publishing', 'published', 'failed')),
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        lease_until TIMESTAMPTZ,
        locked_by VARCHAR(120),
        last_error TEXT,
        published_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(stream, event_key)
      );

CREATE TABLE IF NOT EXISTS notification_provider_events (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        provider VARCHAR(32) NOT NULL,
        event_id VARCHAR(255) NOT NULL,
        delivery_id UUID REFERENCES notification_deliveries(id) ON DELETE SET NULL,
        sg_message_id VARCHAR(255),
        email_hash VARCHAR(64),
        event_type VARCHAR(40) NOT NULL,
        reason TEXT,
        payload JSONB NOT NULL,
        occurred_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(provider, event_id)
      );

CREATE TABLE IF NOT EXISTS user_presets (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID REFERENCES users(id) ON DELETE CASCADE,
        preset_type VARCHAR(20) NOT NULL CHECK (preset_type IN ('price_increase', 'price_decrease')),
        percentages INTEGER[] NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, preset_type)
      );

CREATE TABLE IF NOT EXISTS auth_nonces (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        wallet_address VARCHAR(44) NOT NULL,
        nonce_hash VARCHAR(64) NOT NULL,
        expires_at TIMESTAMP NOT NULL,
        used BOOLEAN DEFAULT FALSE,
        used_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

CREATE TABLE IF NOT EXISTS discord_linking_tokens (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        token_hash VARCHAR(64) UNIQUE,
        token VARCHAR(64),
        discord_user_id VARCHAR(255) NOT NULL,
        discord_username VARCHAR(255),
        expires_at TIMESTAMP NOT NULL,
        used BOOLEAN DEFAULT FALSE,
        wallet_address VARCHAR(44),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

CREATE TABLE IF NOT EXISTS extension_linking_tokens (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        token_hash VARCHAR(64) UNIQUE,
        token VARCHAR(64),
        connection_id VARCHAR(100) NOT NULL,
        extension_id VARCHAR(100),
        expires_at TIMESTAMP NOT NULL,
        used BOOLEAN DEFAULT FALSE,
        wallet_address VARCHAR(44),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

CREATE TABLE IF NOT EXISTS user_extensions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID REFERENCES users(id) ON DELETE CASCADE,
        connection_id VARCHAR(100) NOT NULL,
        extension_id VARCHAR(100),
        session_id VARCHAR(64),
        extension_token_hash VARCHAR(64),
        extension_token VARCHAR(512),
        revoked_at TIMESTAMP,
        linked_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_active TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id)
      );

ALTER TABLE users ALTER COLUMN telegram_chat_id DROP NOT NULL;

ALTER TABLE token_alerts ADD COLUMN IF NOT EXISTS circulating_supply DECIMAL(30, 8);

ALTER TABLE token_alerts ADD COLUMN IF NOT EXISTS current_market_cap DECIMAL(30, 2);

ALTER TABLE token_alerts ADD COLUMN IF NOT EXISTS cleared_at TIMESTAMP;

ALTER TABLE trade_quotes ADD COLUMN IF NOT EXISTS fee_payer VARCHAR(64);

ALTER TABLE trade_executions ADD COLUMN IF NOT EXISTS op_token VARCHAR(64);

ALTER TABLE trade_executions ADD COLUMN IF NOT EXISTS op_lease_until TIMESTAMPTZ;

ALTER TABLE order_intents ADD COLUMN IF NOT EXISTS op_token VARCHAR(64);

ALTER TABLE order_intents ADD COLUMN IF NOT EXISTS op_lease_until TIMESTAMPTZ;

ALTER TABLE users ADD COLUMN IF NOT EXISTS discord_user_id VARCHAR(255);

ALTER TABLE discord_linking_tokens ADD COLUMN IF NOT EXISTS token_hash VARCHAR(64);

ALTER TABLE extension_linking_tokens ADD COLUMN IF NOT EXISTS token_hash VARCHAR(64);

ALTER TABLE user_extensions ADD COLUMN IF NOT EXISTS extension_id VARCHAR(100);

ALTER TABLE user_extensions ADD COLUMN IF NOT EXISTS session_id VARCHAR(64);

ALTER TABLE user_extensions ADD COLUMN IF NOT EXISTS extension_token_hash VARCHAR(64);

ALTER TABLE user_extensions ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMP;

ALTER TABLE notification_deliveries ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE notification_deliveries ADD COLUMN IF NOT EXISTS provider VARCHAR(32);

ALTER TABLE notification_deliveries ADD COLUMN IF NOT EXISTS provider_message_id VARCHAR(255);

ALTER TABLE notification_deliveries ADD COLUMN IF NOT EXISTS provider_status VARCHAR(64);

ALTER TABLE notification_deliveries ADD COLUMN IF NOT EXISTS recipient_hash VARCHAR(64);

ALTER TABLE notification_deliveries ADD COLUMN IF NOT EXISTS template_id VARCHAR(128);

ALTER TABLE notification_deliveries ADD COLUMN IF NOT EXISTS locale VARCHAR(16);

ALTER TABLE notification_deliveries ADD COLUMN IF NOT EXISTS timezone VARCHAR(64);

ALTER TABLE notification_deliveries ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMP;

ALTER TABLE notification_deliveries ADD COLUMN IF NOT EXISTS last_attempt_at TIMESTAMP;

ALTER TABLE notification_deliveries ADD COLUMN IF NOT EXISTS max_attempts INTEGER NOT NULL DEFAULT 5;

ALTER TABLE notification_deliveries ADD COLUMN IF NOT EXISTS retry_seq INTEGER NOT NULL DEFAULT 0;

ALTER TABLE notification_deliveries ADD COLUMN IF NOT EXISTS region VARCHAR(32);

ALTER TABLE notification_deliveries ADD COLUMN IF NOT EXISTS metadata JSONB;

INSERT INTO monitored_tokens (token_address, token_name, token_symbol, active_alert_count, shard_id, shard_count, status)
      SELECT
        token_address,
        MAX(token_name),
        MAX(token_symbol),
        COUNT(*)::int,
        0,
        1,
        'active'
      FROM token_alerts
      WHERE is_active = true AND is_triggered = false
      GROUP BY token_address
      ON CONFLICT (token_address) DO UPDATE SET
        token_name = COALESCE(EXCLUDED.token_name, monitored_tokens.token_name),
        token_symbol = COALESCE(EXCLUDED.token_symbol, monitored_tokens.token_symbol),
        active_alert_count = EXCLUDED.active_alert_count,
        status = CASE WHEN EXCLUDED.active_alert_count > 0 THEN 'active' ELSE 'disabled' END,
        updated_at = CURRENT_TIMESTAMP;

ALTER TABLE token_alerts DROP CONSTRAINT IF EXISTS token_alerts_notification_type_check;

ALTER TABLE token_alerts
      ADD CONSTRAINT token_alerts_notification_type_check
      CHECK (notification_type IN ('email', 'telegram', 'discord', 'extension'));

ALTER TABLE notification_queue DROP CONSTRAINT IF EXISTS notification_queue_type_check;

ALTER TABLE notification_queue
      ADD CONSTRAINT notification_queue_type_check
      CHECK (type IN ('email', 'telegram', 'discord', 'extension'));

ALTER TABLE notification_deliveries DROP CONSTRAINT IF EXISTS notification_deliveries_status_check;

ALTER TABLE notification_deliveries
      ADD CONSTRAINT notification_deliveries_status_check
      CHECK (status IN ('pending', 'sending', 'accepted', 'processed', 'delivered', 'deferred', 'retry_scheduled', 'suppressed', 'sent', 'failed', 'dead_lettered'));

ALTER TABLE discord_linking_tokens ALTER COLUMN token DROP NOT NULL;

ALTER TABLE extension_linking_tokens ALTER COLUMN token DROP NOT NULL;

ALTER TABLE user_extensions ALTER COLUMN extension_token DROP NOT NULL;

UPDATE discord_linking_tokens
      SET used = TRUE
      WHERE token_hash IS NULL AND used = FALSE;

UPDATE extension_linking_tokens
      SET used = TRUE
      WHERE token_hash IS NULL AND used = FALSE;

UPDATE user_extensions
      SET revoked_at = CURRENT_TIMESTAMP
      WHERE extension_token_hash IS NULL AND revoked_at IS NULL;

INSERT INTO user_email_addresses (user_id, email, email_hash, status, is_primary)
      SELECT id, lower(trim(email)), encode(digest(lower(trim(email)), 'sha256'), 'hex'), 'pending', TRUE
      FROM users
      WHERE email IS NOT NULL AND trim(email) <> ''
      ON CONFLICT (user_id, email_hash) DO NOTHING;

INSERT INTO user_notification_preferences (user_id, channel, enabled, alert_notifications_enabled)
      SELECT id, 'email', FALSE, TRUE
      FROM users
      ON CONFLICT (user_id, channel) DO NOTHING;

INSERT INTO user_notification_preferences (user_id, channel, enabled, alert_notifications_enabled)
      SELECT id, 'telegram', TRUE, TRUE
      FROM users
      WHERE telegram_chat_id IS NOT NULL
      ON CONFLICT (user_id, channel) DO UPDATE SET enabled = TRUE, updated_at = CURRENT_TIMESTAMP;

INSERT INTO user_notification_preferences (user_id, channel, enabled, alert_notifications_enabled)
      SELECT id, 'discord', TRUE, TRUE
      FROM users
      WHERE discord_user_id IS NOT NULL
      ON CONFLICT (user_id, channel) DO UPDATE SET enabled = TRUE, updated_at = CURRENT_TIMESTAMP;

CREATE INDEX IF NOT EXISTS idx_users_wallet_address ON users(wallet_address);

CREATE INDEX IF NOT EXISTS idx_token_alerts_user_id ON token_alerts(user_id);

CREATE INDEX IF NOT EXISTS idx_token_alerts_token_address ON token_alerts(token_address);

CREATE INDEX IF NOT EXISTS idx_token_alerts_active ON token_alerts(is_active) WHERE is_active = TRUE;

CREATE INDEX IF NOT EXISTS idx_token_alerts_active_token ON token_alerts(token_address) WHERE is_active = TRUE AND is_triggered = FALSE;

CREATE INDEX IF NOT EXISTS idx_token_alerts_active_user_time ON token_alerts(user_id, created_at DESC) WHERE is_active = TRUE;

CREATE INDEX IF NOT EXISTS idx_token_alerts_user_time ON token_alerts(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_notification_queue_status ON notification_queue(status) WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_user_email_addresses_user_primary ON user_email_addresses(user_id, is_primary) WHERE status IN ('pending', 'active');

CREATE INDEX IF NOT EXISTS idx_user_email_addresses_hash ON user_email_addresses(email_hash);

CREATE INDEX IF NOT EXISTS idx_user_email_addresses_verification ON user_email_addresses(verification_token_hash) WHERE verification_token_hash IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_user_notification_preferences_enabled ON user_notification_preferences(channel, enabled) WHERE enabled = TRUE;

CREATE INDEX IF NOT EXISTS idx_tokens_updated ON tokens(updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_tokens_lifecycle ON tokens(lifecycle_status);

CREATE INDEX IF NOT EXISTS idx_pools_base_mint ON pools(base_mint);

CREATE INDEX IF NOT EXISTS idx_pools_protocol ON pools(protocol);

CREATE UNIQUE INDEX IF NOT EXISTS idx_trades_idempotent ON trades(idempotency_key, observed_at);

CREATE INDEX IF NOT EXISTS idx_trades_token_time ON trades(token_mint, observed_at DESC);

CREATE INDEX IF NOT EXISTS idx_trades_pool_time ON trades(pool_address, observed_at DESC);

CREATE INDEX IF NOT EXISTS idx_trades_observed_brin ON trades USING BRIN(observed_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_market_state_idempotent ON market_state_snapshots(idempotency_key, observed_at);

CREATE INDEX IF NOT EXISTS idx_market_state_token_time ON market_state_snapshots(token_mint, observed_at DESC);

CREATE INDEX IF NOT EXISTS idx_market_state_observed_brin ON market_state_snapshots USING BRIN(observed_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_candles_bucket ON candles(token_mint, interval_name, bucket_start);

CREATE INDEX IF NOT EXISTS idx_candles_pool_bucket ON candles(pool_address, interval_name, bucket_start DESC);

CREATE INDEX IF NOT EXISTS idx_candle_projection_time ON candle_projection_events(observed_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_liquidity_idempotent ON liquidity_snapshots(idempotency_key, observed_at);

CREATE INDEX IF NOT EXISTS idx_liquidity_token_time ON liquidity_snapshots(token_mint, observed_at DESC);

CREATE INDEX IF NOT EXISTS idx_provider_event_errors_provider_time ON provider_event_errors(provider, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_monitored_tokens_shard ON monitored_tokens(shard_id, shard_count, status);

CREATE INDEX IF NOT EXISTS idx_monitored_tokens_status ON monitored_tokens(status) WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_token_ticks_received_brin ON token_ticks USING BRIN(received_at);

CREATE INDEX IF NOT EXISTS idx_token_ticks_token_time ON token_ticks(token_address, received_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_token_ticks_idempotent ON token_ticks(received_at, token_address, signature);

CREATE INDEX IF NOT EXISTS idx_alert_events_alert_id ON alert_events(alert_id);

CREATE INDEX IF NOT EXISTS idx_alert_events_token ON alert_events(token_address, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_alert_events_user_time ON alert_events(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_alert_events_created ON alert_events(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_trade_quotes_user_time ON trade_quotes(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_trade_quotes_expiry ON trade_quotes(state, expires_at) WHERE state = 'quoted';

CREATE INDEX IF NOT EXISTS idx_trade_executions_user_time ON trade_executions(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_trade_executions_signature ON trade_executions(signature) WHERE signature IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_trade_executions_state ON trade_executions(state, updated_at) WHERE state IN ('signed', 'submitted', 'processed');

CREATE INDEX IF NOT EXISTS idx_execution_events_execution_time ON execution_events(execution_id, occurred_at);

CREATE INDEX IF NOT EXISTS idx_execution_events_time_brin ON execution_events USING BRIN(occurred_at);

CREATE INDEX IF NOT EXISTS idx_order_intents_user_time ON order_intents(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_order_intents_open_expiry ON order_intents(expires_at) WHERE state IN ('open', 'executing', 'partially_filled');

CREATE INDEX IF NOT EXISTS idx_order_intents_provider_id ON order_intents(provider, provider_order_id) WHERE provider_order_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_order_events_order_time ON order_events(order_id, occurred_at);

CREATE INDEX IF NOT EXISTS idx_order_events_time_brin ON order_events USING BRIN(occurred_at);

CREATE INDEX IF NOT EXISTS idx_tracked_wallets_user ON tracked_wallets(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_tracked_wallets_source ON tracked_wallets(source_id) WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_wallet_sources_poll ON wallet_sources(last_polled_at NULLS FIRST) WHERE status = 'active';

CREATE UNIQUE INDEX IF NOT EXISTS idx_wallet_activity_idempotent ON wallet_activity(occurred_at, idempotency_key);

CREATE INDEX IF NOT EXISTS idx_wallet_activity_source_time ON wallet_activity(source_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_wallet_activity_signature ON wallet_activity(signature);

CREATE INDEX IF NOT EXISTS idx_wallet_activity_time_brin ON wallet_activity USING BRIN(occurred_at);

CREATE INDEX IF NOT EXISTS idx_notification_deliveries_status ON notification_deliveries(status) WHERE status IN ('pending', 'failed', 'retry_scheduled');

CREATE INDEX IF NOT EXISTS idx_notification_deliveries_due_retry ON notification_deliveries(status, next_attempt_at) WHERE status IN ('pending', 'retry_scheduled');

CREATE INDEX IF NOT EXISTS idx_notification_deliveries_user_time ON notification_deliveries(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_notification_deliveries_provider_message ON notification_deliveries(provider, provider_message_id);

CREATE INDEX IF NOT EXISTS idx_notification_deliveries_recipient_time ON notification_deliveries(recipient_hash, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_event_outbox_due ON event_outbox(next_attempt_at, created_at) WHERE status IN ('pending', 'publishing');

CREATE INDEX IF NOT EXISTS idx_event_outbox_published ON event_outbox(published_at) WHERE status = 'published';

CREATE INDEX IF NOT EXISTS idx_notification_provider_events_delivery ON notification_provider_events(delivery_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_notification_provider_events_message ON notification_provider_events(provider, sg_message_id);

CREATE INDEX IF NOT EXISTS idx_notification_provider_events_email ON notification_provider_events(email_hash, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_user_presets_user_id ON user_presets(user_id);

CREATE INDEX IF NOT EXISTS idx_auth_nonces_wallet_hash ON auth_nonces(wallet_address, nonce_hash);

CREATE INDEX IF NOT EXISTS idx_auth_nonces_expires ON auth_nonces(expires_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_discord_linking_tokens_token_hash ON discord_linking_tokens(token_hash) WHERE token_hash IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_discord_linking_tokens_expires ON discord_linking_tokens(expires_at);

CREATE INDEX IF NOT EXISTS idx_discord_linking_tokens_discord_user_id ON discord_linking_tokens(discord_user_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_extension_linking_tokens_token_hash ON extension_linking_tokens(token_hash) WHERE token_hash IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_extension_linking_tokens_expires ON extension_linking_tokens(expires_at);

CREATE INDEX IF NOT EXISTS idx_extension_linking_tokens_connection_id ON extension_linking_tokens(connection_id);

CREATE INDEX IF NOT EXISTS idx_user_extensions_user_id ON user_extensions(user_id);

CREATE INDEX IF NOT EXISTS idx_user_extensions_connection_id ON user_extensions(connection_id);

CREATE INDEX IF NOT EXISTS idx_user_extensions_session_id ON user_extensions(session_id);

CREATE INDEX IF NOT EXISTS idx_user_extensions_token_hash ON user_extensions(extension_token_hash);

CREATE OR REPLACE FUNCTION update_updated_at_column()
      RETURNS TRIGGER AS $$
      BEGIN
        NEW.updated_at = CURRENT_TIMESTAMP;
        RETURN NEW;
      END;
      $$ language 'plpgsql';

DROP TRIGGER IF EXISTS update_users_updated_at ON users;
      CREATE TRIGGER update_users_updated_at
        BEFORE UPDATE ON users
        FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_token_alerts_updated_at ON token_alerts;
      CREATE TRIGGER update_token_alerts_updated_at
        BEFORE UPDATE ON token_alerts
        FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_monitored_tokens_updated_at ON monitored_tokens;
      CREATE TRIGGER update_monitored_tokens_updated_at
        BEFORE UPDATE ON monitored_tokens
        FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_tokens_updated_at ON tokens;
      CREATE TRIGGER update_tokens_updated_at
        BEFORE UPDATE ON tokens
        FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_pools_updated_at ON pools;
      CREATE TRIGGER update_pools_updated_at
        BEFORE UPDATE ON pools
        FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_notification_deliveries_updated_at ON notification_deliveries;
      CREATE TRIGGER update_notification_deliveries_updated_at
        BEFORE UPDATE ON notification_deliveries
        FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_trade_quotes_updated_at ON trade_quotes;
      CREATE TRIGGER update_trade_quotes_updated_at
        BEFORE UPDATE ON trade_quotes
        FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_trade_executions_updated_at ON trade_executions;
      CREATE TRIGGER update_trade_executions_updated_at
        BEFORE UPDATE ON trade_executions
        FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_order_intents_updated_at ON order_intents;
      CREATE TRIGGER update_order_intents_updated_at
        BEFORE UPDATE ON order_intents
        FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_wallet_sources_updated_at ON wallet_sources;
      CREATE TRIGGER update_wallet_sources_updated_at
        BEFORE UPDATE ON wallet_sources
        FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_tracked_wallets_updated_at ON tracked_wallets;
      CREATE TRIGGER update_tracked_wallets_updated_at
        BEFORE UPDATE ON tracked_wallets
        FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_user_email_addresses_updated_at ON user_email_addresses;
      CREATE TRIGGER update_user_email_addresses_updated_at
        BEFORE UPDATE ON user_email_addresses
        FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_user_notification_preferences_updated_at ON user_notification_preferences;
      CREATE TRIGGER update_user_notification_preferences_updated_at
        BEFORE UPDATE ON user_notification_preferences
        FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
