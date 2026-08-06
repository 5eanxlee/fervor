-- stride: destructive-review=observability.notification-index-restart

SET lock_timeout = '5s';
SET statement_timeout = '7min';
SET idle_in_transaction_session_timeout = '60s';
SET search_path = public;

DROP INDEX CONCURRENTLY IF EXISTS notification_backlog_idx;
CREATE INDEX CONCURRENTLY notification_backlog_idx
    ON notification_deliveries (id)
    WHERE status IN ('pending', 'sending', 'retry_scheduled');
