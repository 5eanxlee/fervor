import { transaction } from '../../config/database';
import { env } from '../../config/env';
import { AlertNotificationJob } from '../../types';
import { eventOutbox } from '../eventOutbox';
import { metrics } from '../metrics';
import { STREAMS } from '../redisStreamService';

export class NotificationRetryService {
    async republishDue(limit = env.REDIS_STREAM_BATCH_SIZE): Promise<number> {
        if (!env.ENABLE_NOTIFICATION_RETRY_WORKER) return 0;
        return transaction(async (db) => {
            await db(
                `UPDATE notification_attempts attempt
                 SET status = 'ambiguous', effect = 'unknown',
                     error_message = 'Provider attempt lease expired without a durable result',
                     finished_at = CURRENT_TIMESTAMP
                 FROM notification_deliveries delivery
                 WHERE attempt.delivery_id = delivery.id
                   AND attempt.lease_token = delivery.lease_token
                   AND attempt.status = 'claimed'
                   AND delivery.status = 'sending'
                   AND delivery.lease_until <= NOW()`
            );
            await db(
                `UPDATE notification_deliveries
                 SET status = 'ambiguous',
                     lease_token = NULL,
                     lease_owner = NULL,
                     lease_until = NULL,
                     error_message = 'Provider attempt lease expired with an unknown effect',
                     updated_at = CURRENT_TIMESTAMP
                 WHERE status = 'sending'
                   AND lease_until <= NOW()`
            );
            await db(
                `UPDATE notification_deliveries
                 SET status = 'dead_lettered',
                     error_message = COALESCE(error_message, 'Delivery exhausted provider attempts'),
                     updated_at = CURRENT_TIMESTAMP
                 WHERE status = 'retry_scheduled'
                   AND attempts >= max_attempts
                   AND next_attempt_at <= NOW()`
            );
            const result = await db(
                `SELECT
                    nd.id as delivery_id,
                    nd.attempts,
                    nd.retry_seq,
                    ae.id as alert_event_id,
                    ae.alert_id,
                    ae.user_id,
                    ae.token_address,
                    ae.current_value,
                    ae.notification_type,
                    ae.idempotency_key,
                    ae.created_at
                 FROM notification_deliveries nd
                 JOIN alert_events ae ON ae.id = nd.alert_event_id
                 WHERE nd.attempts < nd.max_attempts
                   AND nd.status = 'retry_scheduled'
                   AND nd.next_attempt_at <= NOW()
                 ORDER BY nd.next_attempt_at ASC
                 FOR UPDATE OF nd SKIP LOCKED
                 LIMIT $1`,
                [limit]
            );

            const jobs: AlertNotificationJob[] = result.rows.map((row) => ({
                alertEventId: row.alert_event_id,
                alertId: row.alert_id,
                userId: row.user_id,
                tokenAddress: row.token_address,
                currentValue: Number(row.current_value),
                notificationType: row.notification_type,
                idempotencyKey: row.idempotency_key,
                triggeredAt: row.created_at?.toISOString?.() || new Date(row.created_at).toISOString(),
            }));

            const ids = result.rows.map((row) => row.delivery_id);
            if (ids.length > 0) {
                await db(
                    `UPDATE notification_deliveries
                     SET status = 'pending',
                         next_attempt_at = NULL,
                         lease_token = NULL,
                         lease_owner = NULL,
                         lease_until = NULL,
                         updated_at = CURRENT_TIMESTAMP
                     WHERE id = ANY($1::uuid[])`,
                    [ids]
                );
            }

            for (let index = 0; index < jobs.length; index += 1) {
                await eventOutbox.enqueue(
                    db,
                    STREAMS.notificationsPending,
                    `delivery-retry:${result.rows[index].delivery_id}:${result.rows[index].retry_seq}:${result.rows[index].attempts}`,
                    jobs[index]
                );
            }
            metrics.increment('fervor_notification_retries_republished', undefined, jobs.length);
            return jobs.length;
        });
    }
}

export const notificationRetryService = new NotificationRetryService();
