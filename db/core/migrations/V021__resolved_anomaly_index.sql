-- Bound the journal-reversal integrity lookup to anomalies that actually
-- consumed a resolution journal.
-- stride: destructive-review=resolved-anomaly-index-v21

SET lock_timeout = '5s';
SET statement_timeout = '7min';
SET idle_in_transaction_session_timeout = '60s';
SET search_path = public;

DROP INDEX CONCURRENTLY IF EXISTS order_anomalies_resolved_journal_idx;

CREATE INDEX CONCURRENTLY order_anomalies_resolved_journal_idx
    ON order_anomalies (resolution_journal)
    WHERE state = 'resolved' AND resolution_journal IS NOT NULL;
