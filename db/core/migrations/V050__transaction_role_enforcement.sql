-- Re-apply the signed-blob ACL after production role preflight. V048 was
-- intentionally development-tolerant; production runners now require both
-- externally provisioned roles before this forward correction can advance.
-- stride: destructive-review=transaction-role-enforcement-v1

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';
SET LOCAL idle_in_transaction_session_timeout = '60s';
SET LOCAL search_path = public;

DO $$
DECLARE
    runtime_ok BOOLEAN;
    maintenance_ok BOOLEAN;
BEGIN
    SELECT NOT role.rolsuper AND NOT role.rolcreaterole AND NOT role.rolbypassrls
      INTO runtime_ok
      FROM pg_roles role
     WHERE role.rolname = 'core_runtime';
    SELECT NOT role.rolsuper AND NOT role.rolcreaterole AND NOT role.rolbypassrls
      INTO maintenance_ok
      FROM pg_roles role
     WHERE role.rolname = 'core_maintenance';

    IF runtime_ok IS NULL OR maintenance_ok IS NULL THEN
        RETURN;
    END IF;
    IF NOT runtime_ok OR NOT maintenance_ok
        OR pg_has_role('core_runtime', 'core_maintenance', 'MEMBER')
        OR pg_has_role('core_maintenance', 'core_runtime', 'MEMBER') THEN
        RAISE EXCEPTION 'core transaction roles are privileged or cross-members'
            USING ERRCODE = '42501';
    END IF;

    IF EXISTS (
        SELECT 1
          FROM pg_proc fn
          JOIN pg_roles owner_role ON owner_role.oid = fn.proowner
         WHERE fn.oid IN (
             'assert_blob_access(uuid,uuid,character varying,bigint,character varying,bigint)'::regprocedure,
             'purge_order_tx_blob(uuid,character varying,timestamp with time zone)'::regprocedure
         )
           AND owner_role.rolname IN ('core_runtime', 'core_maintenance')
    ) THEN
        RAISE EXCEPTION 'transaction security-definer owner cannot be a caller role'
            USING ERRCODE = '42501';
    END IF;

    ALTER FUNCTION assert_blob_access(UUID, UUID, VARCHAR, BIGINT, VARCHAR, BIGINT)
        SECURITY DEFINER;
    ALTER FUNCTION purge_order_tx_blob(UUID, VARCHAR, TIMESTAMPTZ)
        SECURITY DEFINER;
    GRANT USAGE ON SCHEMA public TO core_runtime, core_maintenance;
    REVOKE CREATE ON SCHEMA public FROM core_runtime, core_maintenance;

    GRANT EXECUTE ON FUNCTION assert_blob_access(UUID, UUID, VARCHAR, BIGINT, VARCHAR, BIGINT)
        TO core_runtime;
    REVOKE ALL ON FUNCTION order_blob_read_guard() FROM core_runtime;
    REVOKE ALL ON FUNCTION purge_order_tx_blob(UUID, VARCHAR, TIMESTAMPTZ)
        FROM core_runtime;

    GRANT EXECUTE ON FUNCTION purge_order_tx_blob(UUID, VARCHAR, TIMESTAMPTZ)
        TO core_maintenance;
    REVOKE ALL ON FUNCTION assert_blob_access(UUID, UUID, VARCHAR, BIGINT, VARCHAR, BIGINT)
        FROM core_maintenance;
    REVOKE ALL ON FUNCTION order_blob_read_guard() FROM core_maintenance;
END;
$$;

COMMENT ON FUNCTION assert_blob_access(UUID, UUID, VARCHAR, BIGINT, VARCHAR, BIGINT) IS
    'Fail-closed security-definer blob authorization; only core_runtime may invoke it in production';
COMMENT ON FUNCTION purge_order_tx_blob(UUID, VARCHAR, TIMESTAMPTZ) IS
    'Security-definer terminal blob purge; only isolated core_maintenance may invoke it in production';
