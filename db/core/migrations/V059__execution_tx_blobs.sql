-- Preserve the exact wallet-signed swap payload before the first managed
-- landing call. The provider acknowledgement is mutable evidence and is not
-- part of this immutable transaction identity.
-- stride: destructive-review=immutable-execution-blob-delete-guard-v59

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';
SET LOCAL idle_in_transaction_session_timeout = '60s';
SET LOCAL search_path = public;

-- V059 is a drained cutover. This barrier waits for any claim transaction that
-- began on N-1, then prevents another writer from crossing the trigger install.
LOCK TABLE trade_executions IN SHARE ROW EXCLUSIVE MODE;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
          FROM trade_executions
         WHERE provider = 'jupiter_swap_v2'
           AND (op_token IS NOT NULL OR op_lease_until IS NOT NULL)
    ) THEN
        RAISE EXCEPTION 'execution blob cutover requires drained Jupiter claims'
            USING ERRCODE = '55000';
    END IF;
END;
$$;

CREATE TABLE execution_tx_blobs (
    execution_id UUID PRIMARY KEY REFERENCES trade_executions(id) ON DELETE RESTRICT,
    quote_id UUID NOT NULL REFERENCES trade_quotes(id) ON DELETE RESTRICT,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    provider VARCHAR(32) NOT NULL CHECK (provider = 'jupiter_swap_v2'),
    provider_quote_id VARCHAR(180) NOT NULL,
    wallet_address VARCHAR(64) NOT NULL
        CHECK (wallet_address ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
    fee_payer VARCHAR(64) NOT NULL
        CHECK (fee_payer ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
    alg VARCHAR(24) NOT NULL CHECK (alg = 'aes_256_gcm'),
    ciphertext BYTEA NOT NULL CHECK (octet_length(ciphertext) BETWEEN 17 AND 1248),
    nonce BYTEA NOT NULL CHECK (octet_length(nonce) = 12),
    wrapped_key BYTEA NOT NULL CHECK (octet_length(wrapped_key) BETWEEN 32 AND 8192),
    key_id VARCHAR(2048) NOT NULL CHECK (length(key_id) BETWEEN 1 AND 2048),
    aad_hash CHAR(64) NOT NULL CHECK (aad_hash ~ '^[0-9a-f]{64}$'),
    message_hash CHAR(64) NOT NULL CHECK (message_hash ~ '^[0-9a-f]{64}$'),
    raw_hash CHAR(64) NOT NULL CHECK (raw_hash ~ '^[0-9a-f]{64}$'),
    byte_size INTEGER NOT NULL CHECK (byte_size BETWEEN 1 AND 1232),
    aad_ver SMALLINT NOT NULL CHECK (aad_ver = 1),
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK (expires_at > created_at),
    UNIQUE (raw_hash)
);

CREATE FUNCTION execution_blob_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
    execution_row trade_executions%ROWTYPE;
    quote_row trade_quotes%ROWTYPE;
BEGIN
    IF TG_OP <> 'INSERT' THEN
        RAISE EXCEPTION 'encrypted execution blobs are immutable' USING ERRCODE = '55000';
    END IF;

    SELECT * INTO execution_row
      FROM trade_executions stored
     WHERE stored.id = NEW.execution_id
     FOR SHARE;
    SELECT * INTO quote_row
      FROM trade_quotes stored
     WHERE stored.id = NEW.quote_id
     FOR SHARE;

    IF execution_row.id IS NULL
        OR quote_row.id IS NULL
        OR execution_row.quote_id <> quote_row.id
        OR execution_row.user_id <> NEW.user_id
        OR execution_row.provider <> NEW.provider
        OR execution_row.wallet_address <> NEW.wallet_address
        OR execution_row.signed_tx_digest <> NEW.raw_hash
        OR execution_row.state <> 'signed'
        OR execution_row.broadcast_started_at IS NOT NULL
        OR execution_row.broadcast_count <> 0
        OR quote_row.user_id <> NEW.user_id
        OR quote_row.provider <> NEW.provider
        OR quote_row.provider_quote_id <> NEW.provider_quote_id
        OR quote_row.wallet_address <> NEW.wallet_address
        OR quote_row.fee_payer <> NEW.fee_payer
        OR quote_row.transaction_digest <> NEW.message_hash THEN
        RAISE EXCEPTION 'encrypted execution blob does not match its committed swap'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER execution_tx_blobs_guard
    BEFORE INSERT OR UPDATE OR DELETE ON execution_tx_blobs
    FOR EACH ROW EXECUTE FUNCTION execution_blob_guard();

CREATE FUNCTION execution_quote_guard() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
    IF (
        NEW.id IS DISTINCT FROM OLD.id
        OR NEW.user_id IS DISTINCT FROM OLD.user_id
        OR NEW.provider IS DISTINCT FROM OLD.provider
        OR NEW.provider_quote_id IS DISTINCT FROM OLD.provider_quote_id
        OR NEW.wallet_address IS DISTINCT FROM OLD.wallet_address
        OR NEW.fee_payer IS DISTINCT FROM OLD.fee_payer
        OR NEW.transaction_digest IS DISTINCT FROM OLD.transaction_digest
    ) AND EXISTS (
        SELECT 1
          FROM execution_tx_blobs blob
         WHERE blob.quote_id = OLD.id
    ) THEN
        RAISE EXCEPTION 'managed swap request identity is immutable after signing'
            USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trade_quotes_execution_guard
    BEFORE UPDATE ON trade_quotes
    FOR EACH ROW EXECUTE FUNCTION execution_quote_guard();

CREATE FUNCTION execution_broadcast_guard() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW.provider = 'jupiter_swap_v2'
            AND (NEW.broadcast_count <> 0 OR NEW.broadcast_started_at IS NOT NULL) THEN
            RAISE EXCEPTION 'managed swap must be persisted before its first broadcast'
                USING ERRCODE = '55000';
        END IF;
        RETURN NEW;
    END IF;

    IF (OLD.provider = 'jupiter_swap_v2' OR NEW.provider = 'jupiter_swap_v2')
        AND (
            NEW.id IS DISTINCT FROM OLD.id
            OR NEW.quote_id IS DISTINCT FROM OLD.quote_id
            OR NEW.user_id IS DISTINCT FROM OLD.user_id
            OR NEW.provider IS DISTINCT FROM OLD.provider
            OR NEW.wallet_address IS DISTINCT FROM OLD.wallet_address
            OR NEW.signed_tx_digest IS DISTINCT FROM OLD.signed_tx_digest
        ) THEN
        RAISE EXCEPTION 'managed swap transaction identity is immutable'
            USING ERRCODE = '55000';
    END IF;
    IF NEW.provider = 'jupiter_swap_v2'
        AND (
            NEW.broadcast_count < OLD.broadcast_count
            OR (OLD.broadcast_started_at IS NOT NULL
                AND NEW.broadcast_started_at IS DISTINCT FROM OLD.broadcast_started_at)
        ) THEN
        RAISE EXCEPTION 'managed swap broadcast markers are immutable'
            USING ERRCODE = '55000';
    END IF;
    IF NEW.provider = 'jupiter_swap_v2'
        AND (
            NEW.broadcast_count > OLD.broadcast_count
            OR (OLD.broadcast_started_at IS NULL AND NEW.broadcast_started_at IS NOT NULL)
        )
        AND (
            OLD.op_token IS NULL
            OR NEW.op_token IS DISTINCT FROM OLD.op_token
            OR NEW.op_lease_until IS NULL
            OR NEW.op_lease_until <= clock_timestamp()
            OR NOT EXISTS (
                SELECT 1
                  FROM execution_tx_blobs blob
                 WHERE blob.execution_id = NEW.id
                   AND blob.quote_id = NEW.quote_id
                   AND blob.user_id = NEW.user_id
                   AND blob.provider = NEW.provider
                   AND blob.wallet_address = NEW.wallet_address
                   AND blob.raw_hash = NEW.signed_tx_digest
                   AND blob.expires_at > NEW.op_lease_until
            )
        ) THEN
        RAISE EXCEPTION 'managed swap broadcast requires a live encrypted transaction blob'
            USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trade_executions_broadcast_guard
    BEFORE INSERT OR UPDATE ON trade_executions
    FOR EACH ROW EXECUTE FUNCTION execution_broadcast_guard();

CREATE FUNCTION claim_execution_blob(
    lease_ms INTEGER,
    shard_count INTEGER,
    shard_id INTEGER
) RETURNS TABLE (
    claim_state VARCHAR,
    execution_id UUID,
    quote_id UUID,
    user_id UUID,
    provider VARCHAR,
    wallet_address VARCHAR,
    fee_payer VARCHAR,
    provider_quote_id VARCHAR,
    op_token VARCHAR,
    signature VARCHAR,
    signed_tx_digest CHAR(64),
    alg VARCHAR,
    ciphertext BYTEA,
    nonce BYTEA,
    wrapped_key BYTEA,
    key_id VARCHAR,
    aad_hash CHAR(64),
    message_hash CHAR(64),
    raw_hash CHAR(64),
    byte_size INTEGER,
    aad_ver SMALLINT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp AS $$
DECLARE
    target UUID;
    claim_token VARCHAR;
    now_at TIMESTAMPTZ;
    lease_until TIMESTAMPTZ;
BEGIN
    IF lease_ms IS NULL OR lease_ms < 1000 OR lease_ms > 600000
        OR shard_count IS NULL OR shard_count < 1
        OR shard_id IS NULL OR shard_id < 0 OR shard_id >= shard_count THEN
        RAISE EXCEPTION 'execution recovery claim parameters are invalid'
            USING ERRCODE = '22023';
    END IF;

    SELECT execution.id INTO target
      FROM public.trade_executions execution
      JOIN public.execution_tx_blobs blob ON blob.execution_id = execution.id
     WHERE execution.provider = 'jupiter_swap_v2'
       AND execution.state = 'signed'
       AND execution.broadcast_started_at IS NOT NULL
       AND execution.broadcast_count > 0
       AND (execution.provider_status IS NULL
            OR execution.provider_status NOT LIKE 'manual:%')
       AND (execution.op_lease_until IS NULL
            OR execution.op_lease_until <= pg_catalog.clock_timestamp())
       AND ((pg_catalog.hashtextextended(execution.id::TEXT, 0)
             & 9223372036854775807) % shard_count) = shard_id
     ORDER BY execution.updated_at, execution.id
     FOR UPDATE OF execution SKIP LOCKED
     LIMIT 1;
    IF NOT FOUND THEN
        RETURN;
    END IF;

    now_at := pg_catalog.clock_timestamp();
    lease_until := now_at + lease_ms * INTERVAL '1 millisecond';
    claim_token := pg_catalog.gen_random_uuid()::TEXT;
    UPDATE public.trade_executions execution
       SET op_token = claim_token,
           op_lease_until = lease_until
     WHERE execution.id = target;

    RETURN QUERY
    SELECT CASE WHEN blob.expires_at > lease_until THEN 'ready' ELSE 'expired' END::VARCHAR,
           execution.id,
           execution.quote_id,
           execution.user_id,
           execution.provider,
           execution.wallet_address,
           blob.fee_payer,
           blob.provider_quote_id,
           claim_token,
           execution.signature,
           execution.signed_tx_digest,
           CASE WHEN blob.expires_at > lease_until THEN blob.alg ELSE NULL END,
           CASE WHEN blob.expires_at > lease_until THEN blob.ciphertext ELSE NULL END,
           CASE WHEN blob.expires_at > lease_until THEN blob.nonce ELSE NULL END,
           CASE WHEN blob.expires_at > lease_until THEN blob.wrapped_key ELSE NULL END,
           CASE WHEN blob.expires_at > lease_until THEN blob.key_id ELSE NULL END,
           CASE WHEN blob.expires_at > lease_until THEN blob.aad_hash ELSE NULL END,
           CASE WHEN blob.expires_at > lease_until THEN blob.message_hash ELSE NULL END,
           CASE WHEN blob.expires_at > lease_until THEN blob.raw_hash ELSE NULL END,
           CASE WHEN blob.expires_at > lease_until THEN blob.byte_size ELSE NULL END,
           CASE WHEN blob.expires_at > lease_until THEN blob.aad_ver ELSE NULL END
      FROM public.trade_executions execution
      JOIN public.execution_tx_blobs blob ON blob.execution_id = execution.id
     WHERE execution.id = target
       AND execution.op_token = claim_token;
END;
$$;

REVOKE ALL ON TABLE execution_tx_blobs FROM PUBLIC;
REVOKE ALL ON FUNCTION execution_blob_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION execution_quote_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION execution_broadcast_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION claim_execution_blob(INTEGER, INTEGER, INTEGER) FROM PUBLIC;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'core_runtime') THEN
        GRANT INSERT ON TABLE execution_tx_blobs TO core_runtime;
        GRANT EXECUTE ON FUNCTION claim_execution_blob(INTEGER, INTEGER, INTEGER)
            TO core_runtime;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'core_maintenance') THEN
        REVOKE ALL ON TABLE execution_tx_blobs FROM core_maintenance;
        REVOKE ALL ON FUNCTION claim_execution_blob(INTEGER, INTEGER, INTEGER)
            FROM core_maintenance;
    END IF;
END;
$$;

CREATE FUNCTION assert_execution_blob_acl() RETURNS VOID
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp AS $$
DECLARE
    runtime_oid OID;
    maintenance_oid OID;
    table_owner OID;
    quote_owner OID;
    guard_owner OID;
    quote_guard_owner OID;
    claim_owner OID;
    unsafe_acl TEXT;
BEGIN
    SELECT oid INTO runtime_oid FROM pg_roles WHERE rolname = 'core_runtime';
    SELECT oid INTO maintenance_oid FROM pg_roles WHERE rolname = 'core_maintenance';
    IF runtime_oid IS NULL OR maintenance_oid IS NULL THEN
        RAISE EXCEPTION 'required core transaction roles are missing' USING ERRCODE = '42501';
    END IF;

    SELECT relowner INTO table_owner
      FROM pg_class
     WHERE oid = 'public.execution_tx_blobs'::regclass;
    SELECT relowner INTO quote_owner
      FROM pg_class
     WHERE oid = 'public.trade_quotes'::regclass;
    SELECT proowner INTO guard_owner
      FROM pg_proc
     WHERE oid = 'public.execution_broadcast_guard()'::regprocedure;
    SELECT proowner INTO quote_guard_owner
      FROM pg_proc
     WHERE oid = 'public.execution_quote_guard()'::regprocedure;
    SELECT proowner INTO claim_owner
      FROM pg_proc
     WHERE oid = 'public.claim_execution_blob(integer,integer,integer)'::regprocedure;
    IF table_owner IS NULL OR quote_owner <> table_owner
        OR guard_owner <> table_owner OR quote_guard_owner <> table_owner
        OR claim_owner <> table_owner
        OR table_owner IN (runtime_oid, maintenance_oid) THEN
        RAISE EXCEPTION 'execution blob boundary has an unsafe owner' USING ERRCODE = '42501';
    END IF;
    IF NOT has_table_privilege('core_runtime', 'public.execution_tx_blobs', 'INSERT')
        OR has_table_privilege('core_runtime', 'public.execution_tx_blobs', 'SELECT')
        OR has_table_privilege('core_runtime', 'public.execution_tx_blobs', 'UPDATE')
        OR has_table_privilege('core_runtime', 'public.execution_tx_blobs', 'DELETE')
        OR has_table_privilege('core_maintenance', 'public.execution_tx_blobs', 'SELECT')
        OR has_table_privilege('core_maintenance', 'public.execution_tx_blobs', 'INSERT')
        OR has_table_privilege('public', 'public.execution_tx_blobs', 'SELECT')
        OR has_table_privilege('public', 'public.execution_tx_blobs', 'INSERT') THEN
        RAISE EXCEPTION 'execution blob table ACL is outside its exact allowlist'
            USING ERRCODE = '42501';
    END IF;
    IF NOT has_function_privilege(
            'core_runtime',
            'public.claim_execution_blob(integer,integer,integer)',
            'EXECUTE'
        )
        OR has_function_privilege(
            'core_maintenance',
            'public.claim_execution_blob(integer,integer,integer)',
            'EXECUTE'
        )
        OR has_function_privilege(
            'public',
            'public.claim_execution_blob(integer,integer,integer)',
            'EXECUTE'
        ) THEN
        RAISE EXCEPTION 'execution blob claim ACL is outside its exact allowlist'
            USING ERRCODE = '42501';
    END IF;
    IF EXISTS (
        SELECT 1
          FROM pg_proc fn
         WHERE fn.oid = 'public.execution_broadcast_guard()'::regprocedure
           AND (
               NOT fn.prosecdef
               OR fn.proconfig IS DISTINCT FROM
                  ARRAY['search_path=pg_catalog, public, pg_temp']::TEXT[]
           )
    ) THEN
        RAISE EXCEPTION 'execution broadcast guard has an unsafe execution context'
            USING ERRCODE = '42501';
    END IF;
    IF EXISTS (
        SELECT 1
          FROM pg_proc fn
         WHERE fn.oid = 'public.execution_quote_guard()'::regprocedure
           AND (
               NOT fn.prosecdef
               OR fn.proconfig IS DISTINCT FROM
                  ARRAY['search_path=pg_catalog, public, pg_temp']::TEXT[]
           )
    ) THEN
        RAISE EXCEPTION 'execution quote guard has an unsafe execution context'
            USING ERRCODE = '42501';
    END IF;
    IF EXISTS (
        SELECT 1
          FROM pg_proc fn
         WHERE fn.oid = 'public.claim_execution_blob(integer,integer,integer)'::regprocedure
           AND (
               NOT fn.prosecdef
               OR fn.proconfig IS DISTINCT FROM
                  ARRAY['search_path=pg_catalog, pg_temp']::TEXT[]
           )
    ) THEN
        RAISE EXCEPTION 'execution blob claim has an unsafe execution context'
            USING ERRCODE = '42501';
    END IF;
    SELECT CASE WHEN acl.grantee = 0 THEN 'PUBLIC'
                ELSE COALESCE(role.rolname, acl.grantee::TEXT) END
      INTO unsafe_acl
      FROM pg_proc fn
      CROSS JOIN LATERAL aclexplode(
          COALESCE(fn.proacl, acldefault('f', fn.proowner))
      ) acl
      LEFT JOIN pg_roles role ON role.oid = acl.grantee
     WHERE fn.oid = 'public.claim_execution_blob(integer,integer,integer)'::regprocedure
       AND acl.privilege_type = 'EXECUTE'
       AND (
           acl.grantee NOT IN (fn.proowner, runtime_oid)
           OR (acl.grantee = runtime_oid AND acl.is_grantable)
       )
     LIMIT 1;
    IF unsafe_acl IS NOT NULL THEN
        RAISE EXCEPTION 'execution blob claim has an unauthorized executor %', unsafe_acl
            USING ERRCODE = '42501';
    END IF;
    SELECT CASE WHEN acl.grantee = 0 THEN 'PUBLIC'
                ELSE COALESCE(role.rolname, acl.grantee::TEXT) END
      INTO unsafe_acl
      FROM pg_proc fn
      CROSS JOIN LATERAL aclexplode(
          COALESCE(fn.proacl, acldefault('f', fn.proowner))
      ) acl
      LEFT JOIN pg_roles role ON role.oid = acl.grantee
     WHERE fn.oid = 'public.execution_quote_guard()'::regprocedure
       AND acl.privilege_type = 'EXECUTE'
       AND acl.grantee <> fn.proowner
     LIMIT 1;
    IF unsafe_acl IS NOT NULL THEN
        RAISE EXCEPTION 'execution quote guard has an unauthorized executor %', unsafe_acl
            USING ERRCODE = '42501';
    END IF;
END;
$$;

CREATE OR REPLACE FUNCTION assert_tx_roles() RETURNS VOID
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp AS $$
BEGIN
    PERFORM public.assert_tx_role_base();
    PERFORM public.assert_tx_acl();
    PERFORM public.assert_execution_blob_acl();
END;
$$;

REVOKE ALL ON FUNCTION assert_execution_blob_acl() FROM PUBLIC;
REVOKE ALL ON FUNCTION assert_tx_roles() FROM PUBLIC;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'core_runtime')
        AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'core_maintenance') THEN
        PERFORM assert_tx_roles();
    END IF;
END;
$$;

COMMENT ON TABLE execution_tx_blobs IS
    'Immutable envelope-encrypted wallet-signed swap bytes required before managed landing';
COMMENT ON COLUMN execution_tx_blobs.raw_hash IS
    'SHA-256 of the exact signed wire bytes; provider-added acknowledgement signatures are separate evidence';
COMMENT ON COLUMN execution_tx_blobs.provider_quote_id IS
    'Immutable Jupiter request identity authenticated with the exact signed wire transaction';
COMMENT ON FUNCTION claim_execution_blob(INTEGER, INTEGER, INTEGER) IS
    'Claims one due managed swap and returns its exact encrypted bytes only through the live execution lease';
