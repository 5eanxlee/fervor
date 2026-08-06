-- CREATE OR REPLACE preserves function ACLs. Reset every explicit grantee,
-- rebuild the exact caller allowlist, and keep catalog drift checks composable
-- without copying the existing role and owner assertions.
-- stride: destructive-review=transaction-acl-allowlist-v57

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';
SET LOCAL idle_in_transaction_session_timeout = '60s';
SET LOCAL search_path = public;

-- V056 commits the NOT VALID constraint first so this scan does not retain
-- its stronger ALTER TABLE lock and can run while ordinary writes continue.
ALTER TABLE asset_obligations
    VALIDATE CONSTRAINT asset_obligations_action_fk;

ALTER FUNCTION public.assert_tx_roles() RENAME TO assert_tx_role_base;

-- Keep table access behind the owner boundary. The maintenance caller can run
-- one bounded retention batch but cannot enumerate or rewrite transaction rows
-- directly. Locking order aggregates with SKIP LOCKED lets replicas divide the
-- queue without reversing the aggregate-to-action lock order used by mutations.
CREATE FUNCTION public.purge_expired_blobs(batch_size INTEGER, run_ref VARCHAR)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp AS $$
DECLARE
    cutoff TIMESTAMPTZ := pg_catalog.clock_timestamp();
    target UUID;
    purged INTEGER := 0;
BEGIN
    IF batch_size IS NULL OR batch_size < 1 OR batch_size > 1000 THEN
        RAISE EXCEPTION 'blob retention batch must be between 1 and 1000'
            USING ERRCODE = '22023';
    END IF;
    IF run_ref IS NULL OR pg_catalog.btrim(run_ref) = ''
        OR pg_catalog.length(pg_catalog.btrim(run_ref)) > 128 THEN
        RAISE EXCEPTION 'blob retention run reference must contain 1 to 128 characters'
            USING ERRCODE = '22023';
    END IF;

    FOR target IN
        SELECT blob.action_id
          FROM public.order_tx_blobs blob
          JOIN public.order_actions action ON action.id = blob.action_id
          JOIN public.order_intents order_row ON order_row.id = action.order_id
         WHERE blob.purged_at IS NULL
           AND blob.expires_at <= cutoff
           AND action.work_state = 'done'
           AND action.outcome IN ('succeeded', 'failed')
           AND NOT EXISTS (
               SELECT 1
                 FROM public.action_attempts attempt
                WHERE attempt.action_id = action.id
                  AND attempt.send_state <> 'response_recorded'
           )
         ORDER BY blob.expires_at, blob.action_id
         LIMIT batch_size
         FOR UPDATE OF order_row SKIP LOCKED
    LOOP
        IF public.purge_order_tx_blob(
            target,
            pg_catalog.btrim(run_ref) || ':' || target::TEXT,
            cutoff
        ) THEN
            purged := purged + 1;
        END IF;
    END LOOP;

    RETURN purged;
END;
$$;

REVOKE ALL ON FUNCTION public.purge_expired_blobs(INTEGER, VARCHAR) FROM PUBLIC;

CREATE FUNCTION public.assert_tx_acl() RETURNS VOID
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp AS $$
DECLARE
    runtime_oid OID;
    maintenance_oid OID;
    owner_oid OID;
    unsafe_acl TEXT;
BEGIN
    SELECT role.oid INTO runtime_oid
      FROM pg_catalog.pg_roles role
     WHERE role.rolname = 'core_runtime';
    SELECT role.oid INTO maintenance_oid
      FROM pg_catalog.pg_roles role
     WHERE role.rolname = 'core_maintenance';
    IF runtime_oid IS NULL OR maintenance_oid IS NULL THEN
        RAISE EXCEPTION 'required core transaction roles are missing'
            USING ERRCODE = '42501';
    END IF;

    SELECT fn.proowner INTO owner_oid
      FROM pg_catalog.pg_proc fn
     WHERE fn.oid = 'public.assert_blob_access(uuid,uuid,character varying,bigint,character varying,bigint)'::pg_catalog.regprocedure;
    IF owner_oid IS NULL OR EXISTS (
        SELECT 1
          FROM pg_catalog.pg_proc fn
         WHERE fn.oid IN (
             'public.assert_blob_access(uuid,uuid,character varying,bigint,character varying,bigint)'::pg_catalog.regprocedure,
             'public.order_blob_read_guard()'::pg_catalog.regprocedure,
             'public.purge_order_tx_blob(uuid,character varying,timestamp with time zone)'::pg_catalog.regprocedure,
             'public.purge_expired_blobs(integer,character varying)'::pg_catalog.regprocedure,
             'public.assert_tx_role_base()'::pg_catalog.regprocedure,
             'public.assert_tx_acl()'::pg_catalog.regprocedure,
             'public.assert_tx_roles()'::pg_catalog.regprocedure
         )
           AND fn.proowner <> owner_oid
    ) THEN
        RAISE EXCEPTION 'transaction function allowlist has split owners'
            USING ERRCODE = '42501';
    END IF;

    IF EXISTS (
        SELECT 1
          FROM pg_catalog.pg_proc fn
         WHERE fn.oid = 'public.purge_expired_blobs(integer,character varying)'::pg_catalog.regprocedure
           AND (
               NOT fn.prosecdef
               OR fn.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, pg_temp']::TEXT[]
           )
    ) THEN
        RAISE EXCEPTION 'blob retention function has an unsafe execution context'
            USING ERRCODE = '42501';
    END IF;

    WITH expected(fn_oid, caller_oid) AS (
        VALUES
            ('public.assert_blob_access(uuid,uuid,character varying,bigint,character varying,bigint)'::pg_catalog.regprocedure::OID, runtime_oid),
            ('public.purge_order_tx_blob(uuid,character varying,timestamp with time zone)'::pg_catalog.regprocedure::OID, maintenance_oid),
            ('public.purge_expired_blobs(integer,character varying)'::pg_catalog.regprocedure::OID, maintenance_oid)
    ), functions AS (
        SELECT fn.oid, fn.proowner, fn.proacl,
               fn.oid::pg_catalog.regprocedure::TEXT AS signature
          FROM pg_catalog.pg_proc fn
         WHERE fn.oid IN (
             'public.assert_blob_access(uuid,uuid,character varying,bigint,character varying,bigint)'::pg_catalog.regprocedure,
             'public.order_blob_read_guard()'::pg_catalog.regprocedure,
             'public.purge_order_tx_blob(uuid,character varying,timestamp with time zone)'::pg_catalog.regprocedure,
             'public.purge_expired_blobs(integer,character varying)'::pg_catalog.regprocedure,
             'public.assert_tx_role_base()'::pg_catalog.regprocedure,
             'public.assert_tx_acl()'::pg_catalog.regprocedure,
             'public.assert_tx_roles()'::pg_catalog.regprocedure
         )
    )
    SELECT functions.signature || ':' ||
           CASE WHEN acl.grantee = 0 THEN 'PUBLIC'
                ELSE COALESCE(role.rolname, acl.grantee::TEXT) END
      INTO unsafe_acl
      FROM functions
      CROSS JOIN LATERAL pg_catalog.aclexplode(
          COALESCE(functions.proacl, pg_catalog.acldefault('f', functions.proowner))
      ) acl
      LEFT JOIN expected ON expected.fn_oid = functions.oid
      LEFT JOIN pg_catalog.pg_roles role ON role.oid = acl.grantee
     WHERE acl.privilege_type = 'EXECUTE'
       AND (
           acl.grantee NOT IN (functions.proowner, COALESCE(expected.caller_oid, functions.proowner))
           OR (acl.grantee <> functions.proowner AND acl.is_grantable)
       )
     ORDER BY functions.signature, acl.grantee
     LIMIT 1;
    IF unsafe_acl IS NOT NULL THEN
        RAISE EXCEPTION 'transaction function ACL has unauthorized grantee or grant option %', unsafe_acl
            USING ERRCODE = '42501';
    END IF;
END;
$$;

CREATE FUNCTION public.assert_tx_roles() RETURNS VOID
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp AS $$
BEGIN
    PERFORM public.assert_tx_role_base();
    PERFORM public.assert_tx_acl();
END;
$$;

REVOKE ALL ON FUNCTION public.assert_blob_access(
    UUID, UUID, VARCHAR, BIGINT, VARCHAR, BIGINT
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.order_blob_read_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.purge_order_tx_blob(UUID, VARCHAR, TIMESTAMPTZ) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.purge_expired_blobs(INTEGER, VARCHAR) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.assert_tx_role_base() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.assert_tx_acl() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.assert_tx_roles() FROM PUBLIC;

DO $$
DECLARE
    grant_row RECORD;
    runtime_ok BOOLEAN;
    maintenance_ok BOOLEAN;
BEGIN
    FOR grant_row IN
        SELECT DISTINCT
               pg_catalog.format(
                   '%I.%I(%s)',
                   namespace.nspname,
                   fn.proname,
                   pg_catalog.pg_get_function_identity_arguments(fn.oid)
               ) AS fn_sql,
               role.rolname
          FROM pg_catalog.pg_proc fn
          JOIN pg_catalog.pg_namespace namespace ON namespace.oid = fn.pronamespace
          CROSS JOIN LATERAL pg_catalog.aclexplode(
              COALESCE(fn.proacl, pg_catalog.acldefault('f', fn.proowner))
          ) acl
          JOIN pg_catalog.pg_roles role ON role.oid = acl.grantee
         WHERE fn.oid IN (
             'public.assert_blob_access(uuid,uuid,character varying,bigint,character varying,bigint)'::pg_catalog.regprocedure,
             'public.order_blob_read_guard()'::pg_catalog.regprocedure,
             'public.purge_order_tx_blob(uuid,character varying,timestamp with time zone)'::pg_catalog.regprocedure,
             'public.purge_expired_blobs(integer,character varying)'::pg_catalog.regprocedure,
             'public.assert_tx_role_base()'::pg_catalog.regprocedure,
             'public.assert_tx_acl()'::pg_catalog.regprocedure,
             'public.assert_tx_roles()'::pg_catalog.regprocedure
         )
           AND acl.grantee <> fn.proowner
    LOOP
        EXECUTE pg_catalog.format(
            'REVOKE ALL PRIVILEGES ON FUNCTION %s FROM %I CASCADE',
            grant_row.fn_sql,
            grant_row.rolname
        );
    END LOOP;

    SELECT EXISTS (
        SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'core_runtime'
    ) INTO runtime_ok;
    SELECT EXISTS (
        SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'core_maintenance'
    ) INTO maintenance_ok;
    IF NOT runtime_ok OR NOT maintenance_ok THEN
        RETURN;
    END IF;

    GRANT EXECUTE ON FUNCTION public.assert_blob_access(
        UUID, UUID, VARCHAR, BIGINT, VARCHAR, BIGINT
    ) TO core_runtime;
    GRANT EXECUTE ON FUNCTION public.purge_order_tx_blob(UUID, VARCHAR, TIMESTAMPTZ)
        TO core_maintenance;
    GRANT EXECUTE ON FUNCTION public.purge_expired_blobs(INTEGER, VARCHAR)
        TO core_maintenance;

    PERFORM public.assert_tx_roles();
END;
$$;

COMMENT ON FUNCTION public.assert_tx_role_base() IS
    'Base catalog assertion for signed-blob role, owner, path, and schema isolation';
COMMENT ON FUNCTION public.assert_tx_acl() IS
    'Exact owner/runtime/maintenance execution allowlist assertion for transaction functions';
COMMENT ON FUNCTION public.assert_tx_roles() IS
    'Complete fail-closed transaction role and function ACL catalog assertion';
COMMENT ON FUNCTION public.purge_expired_blobs(INTEGER, VARCHAR) IS
    'Bounded restart-safe retention claimant for expired terminal signed transaction blobs';
