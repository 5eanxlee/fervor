-- Grant transaction decryption only to the production runtime role and keep
-- destructive blob retention behind the maintenance role. Development owners
-- retain their inherent owner privileges.
-- stride: destructive-review=transaction-role-acl-v1

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';
SET LOCAL idle_in_transaction_session_timeout = '60s';
SET LOCAL search_path = public;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'core_runtime') THEN
        GRANT EXECUTE ON FUNCTION assert_blob_access(UUID, UUID, VARCHAR, BIGINT, VARCHAR, BIGINT)
            TO core_runtime;
    END IF;

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'core_maintenance') THEN
        GRANT EXECUTE ON FUNCTION purge_order_tx_blob(UUID, VARCHAR, TIMESTAMPTZ)
            TO core_maintenance;
    END IF;
END;
$$;

COMMENT ON FUNCTION assert_blob_access(UUID, UUID, VARCHAR, BIGINT, VARCHAR, BIGINT) IS
    'Fail-closed signed-blob authorization; PUBLIC is denied and core_runtime is the production caller';
COMMENT ON FUNCTION purge_order_tx_blob(UUID, VARCHAR, TIMESTAMPTZ) IS
    'Terminal signed-blob retention purge; PUBLIC is denied and core_maintenance is the production caller';
