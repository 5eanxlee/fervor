-- Establish an independent market-plane migration lineage before the physical
-- database split. No application object is created by this anchor.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '1min';
SET LOCAL idle_in_transaction_session_timeout = '30s';
SET LOCAL search_path = public;

DO $migration$
BEGIN
    NULL;
END
$migration$;
