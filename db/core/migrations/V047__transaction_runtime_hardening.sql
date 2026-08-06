-- Restrict signed-transaction helpers to the migration/runtime principal. Runtime
-- parsing and lock-order changes deploy independently of this forward-only ACL fix.
-- stride: destructive-review=transaction-runtime-acl-v1

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';
SET LOCAL idle_in_transaction_session_timeout = '60s';
SET LOCAL search_path = public;

REVOKE ALL ON FUNCTION assert_blob_access(UUID, UUID, VARCHAR, BIGINT, VARCHAR, BIGINT)
    FROM PUBLIC;
REVOKE ALL ON FUNCTION order_blob_read_guard()
    FROM PUBLIC;
REVOKE ALL ON FUNCTION purge_order_tx_blob(UUID, VARCHAR, TIMESTAMPTZ)
    FROM PUBLIC;

GRANT EXECUTE ON FUNCTION assert_blob_access(UUID, UUID, VARCHAR, BIGINT, VARCHAR, BIGINT)
    TO CURRENT_USER;
GRANT EXECUTE ON FUNCTION order_blob_read_guard()
    TO CURRENT_USER;
GRANT EXECUTE ON FUNCTION purge_order_tx_blob(UUID, VARCHAR, TIMESTAMPTZ)
    TO CURRENT_USER;
