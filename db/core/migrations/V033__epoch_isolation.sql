-- Epoch advancement depends on seeing reservations committed while waiting on
-- the scope lock, which requires a fresh READ COMMITTED statement snapshot.
-- stride: destructive-review=epoch-isolation-v33

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';
SET LOCAL idle_in_transaction_session_timeout = '60s';
SET LOCAL search_path = public;

CREATE FUNCTION order_epoch_isolation_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
    IF current_setting('transaction_isolation') <> 'read committed' THEN
        RAISE EXCEPTION 'write epoch advancement requires read committed isolation'
            USING ERRCODE = '25001';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER order_epochs_00_isolation
    BEFORE INSERT ON order_epochs
    FOR EACH ROW EXECUTE FUNCTION order_epoch_isolation_guard();

COMMENT ON FUNCTION order_epoch_isolation_guard() IS
    'Reject snapshot-preserving epoch writes that could miss egress committed during a lock wait';
