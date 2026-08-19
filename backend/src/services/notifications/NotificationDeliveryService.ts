import crypto from 'crypto';
import { query, transaction } from '../../config/database';
import { env } from '../../config/env';
import { AlertNotificationJob, TokenAlert } from '../../types';
import {
    AlertNotificationPayload,
    ChannelPreferenceResolution,
    DeliveryStatus,
    ProviderSendResult,
} from './types';
import { calculateRetryAt } from './utils';

const COMPLETE: DeliveryStatus[] = [
    'delivered', 'sent', 'accepted', 'processed', 'deferred', 'suppressed', 'failed', 'dead_lettered', 'ambiguous',
];
const payloadVersion = 1;

export interface DeliveryContext {
    userId: string;
    payload: AlertNotificationPayload;
}

export interface DeliveryRecord {
    id: string;
    attempts: number;
    maxAttempts: number;
    status: DeliveryStatus;
    provider: string;
    recipientHash?: string;
    locale: string;
    timezone: string;
    payload: AlertNotificationPayload;
    payloadHash: string;
    claimSeq: number;
    idempotencyKey: string;
}

export interface DeliveryClaim extends DeliveryRecord {
    leaseToken: string;
    leaseOwner: string;
    requestKey: string;
}

export type DeliveryOutcome = 'delivered' | 'scheduled' | 'terminal' | 'stale';

const iso = (value: unknown): string => {
    if (value instanceof Date) return value.toISOString();
    return new Date(String(value)).toISOString();
};

const hashPayload = (payload: AlertNotificationPayload): string =>
    crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');

const rowRecord = (row: any): DeliveryRecord => ({
    id: row.id,
    attempts: Number(row.attempts),
    maxAttempts: Number(row.max_attempts),
    status: row.status,
    provider: row.provider,
    recipientHash: row.recipient_hash || undefined,
    locale: row.locale,
    timezone: row.timezone,
    payload: row.payload as AlertNotificationPayload,
    payloadHash: row.payload_hash,
    claimSeq: Number(row.claim_seq),
    idempotencyKey: row.idempotency_key,
});

export class NotificationDeliveryService {
    idempotencyKey(job: AlertNotificationJob): string {
        return `${job.idempotencyKey}:${job.notificationType}`;
    }

    async loadContext(job: AlertNotificationJob): Promise<DeliveryContext | null> {
        const result = await query(
            `SELECT ae.id, ae.alert_id, ae.user_id::text, ae.token_address,
                    ae.threshold_type, ae.threshold_value::float8, ae.condition,
                    ae.current_value::float8, ae.notification_type, ae.idempotency_key,
                    ae.alert_generation, ae.created_at AT TIME ZONE 'UTC' AS created_at
             FROM alert_events ae
             WHERE ae.id = $1`,
            [job.alertEventId]
        );
        const row = result.rows[0];
        if (!row) return null;
        if (row.alert_id !== job.alertId
            || row.user_id !== job.userId
            || row.token_address !== job.tokenAddress
            || row.notification_type !== job.notificationType
            || row.idempotency_key !== job.idempotencyKey
            || Number(row.current_value) !== job.currentValue) {
            throw new Error('Notification job does not match its durable alert event');
        }

        const alert = {
            id: row.alert_id,
            user_id: row.user_id,
            token_address: row.token_address,
            threshold_type: row.threshold_type,
            threshold_value: Number(row.threshold_value),
            condition: row.condition,
            notification_type: row.notification_type,
            is_active: false,
            is_triggered: true,
            generation: Number(row.alert_generation),
            created_at: iso(row.created_at),
            updated_at: iso(row.created_at),
        } as unknown as TokenAlert;
        return {
            userId: row.user_id,
            payload: {
                alert,
                currentValue: Number(row.current_value),
                triggeredAt: iso(row.created_at),
            },
        };
    }

    async begin(
        job: AlertNotificationJob,
        context: DeliveryContext,
        resolution: ChannelPreferenceResolution,
        provider: string
    ): Promise<DeliveryRecord | null> {
        if (provider !== job.notificationType) throw new Error('Notification provider does not match its channel');
        const maxAttempts = env.NOTIFICATION_MAX_ATTEMPTS;
        const payloadHash = hashPayload(context.payload);
        await query(
            `INSERT INTO notification_deliveries
                 (alert_event_id, alert_id, user_id, channel, idempotency_key, status,
                  attempts, max_attempts, provider, recipient_hash, locale,
                  timezone, payload, payload_hash, payload_version)
             VALUES ($1, $2, $3, $4, $5, 'pending', 0, $6, $7, $8, $9, $10,
                     $11::jsonb, $12, $13)
             ON CONFLICT (idempotency_key) DO NOTHING`,
            [
                job.alertEventId,
                job.alertId,
                context.userId,
                job.notificationType,
                this.idempotencyKey(job),
                maxAttempts,
                provider,
                resolution.recipientHash || null,
                resolution.locale,
                resolution.timezone,
                JSON.stringify(context.payload),
                payloadHash,
                payloadVersion,
            ]
        );
        const result = await query(
            `SELECT id, alert_event_id, alert_id, user_id::text, channel,
                    attempts, max_attempts, status, provider, recipient_hash,
                    locale, timezone, payload, payload_hash, payload_version,
                    claim_seq, idempotency_key,
                    next_attempt_at <= CURRENT_TIMESTAMP AS retry_due,
                    lease_until <= CURRENT_TIMESTAMP AS lease_expired
             FROM notification_deliveries
             WHERE idempotency_key = $1`,
            [this.idempotencyKey(job)]
        );
        const row = result.rows[0];
        if (!row) throw new Error('Notification delivery could not be created');
        if (row.alert_event_id !== job.alertEventId
            || row.alert_id !== job.alertId
            || row.user_id !== context.userId
            || row.channel !== job.notificationType
            || Number(row.payload_version) !== payloadVersion
            || row.provider !== provider) {
            throw new Error('Notification delivery identity changed for its idempotency key');
        }
        if (COMPLETE.includes(row.status)) return null;
        if (row.status === 'retry_scheduled' && row.retry_due !== true) return null;
        if (row.status === 'sending' && row.lease_expired !== true) return null;
        return rowRecord(row);
    }

    resolutionMatches(delivery: DeliveryRecord, resolution: ChannelPreferenceResolution): boolean {
        return Boolean(
            resolution.enabled
            && resolution.verified
            && !resolution.suppressed
            && resolution.recipient
            && resolution.recipientHash
            && delivery.recipientHash
            && resolution.recipientHash === delivery.recipientHash
        );
    }

    async claim(deliveryId: string, leaseOwner: string): Promise<DeliveryClaim | null> {
        return transaction(async (db) => {
            const selected = await db(
                `SELECT id, attempts, max_attempts, status, provider, recipient_hash,
                        locale, timezone, payload, payload_hash, claim_seq,
                        idempotency_key, lease_token,
                        next_attempt_at <= CURRENT_TIMESTAMP AS retry_due,
                        lease_until <= CURRENT_TIMESTAMP AS lease_expired
                 FROM notification_deliveries
                 WHERE id = $1
                 FOR UPDATE`,
                [deliveryId]
            );
            const row = selected.rows[0];
            if (!row || COMPLETE.includes(row.status)) return null;
            if (row.status === 'retry_scheduled' && row.retry_due !== true) return null;
            if (row.status === 'sending' && row.lease_expired !== true) return null;

            if (row.status === 'sending' && row.lease_token) {
                const ambiguous = await db(
                    `UPDATE notification_attempts
                     SET status = 'ambiguous', effect = 'unknown',
                         error_message = 'Provider attempt lease expired without a durable result',
                         finished_at = CURRENT_TIMESTAMP
                     WHERE lease_token = $1 AND status = 'claimed'`,
                    [row.lease_token]
                );
                if (ambiguous.rowCount !== 1) {
                    throw new Error('Expired notification lease has no live attempt');
                }
                await db(
                    `UPDATE notification_deliveries
                     SET status = 'ambiguous', lease_token = NULL, lease_owner = NULL,
                         lease_until = NULL,
                         error_message = 'Provider attempt lease expired with an unknown effect',
                         updated_at = CURRENT_TIMESTAMP
                     WHERE id = $1`,
                    [deliveryId]
                );
                return null;
            }
            if (Number(row.attempts) >= Number(row.max_attempts)) {
                await db(
                    `UPDATE notification_deliveries
                     SET status = 'dead_lettered', lease_token = NULL, lease_owner = NULL,
                         lease_until = NULL,
                         error_message = COALESCE(error_message, 'Delivery exhausted provider attempts'),
                         updated_at = CURRENT_TIMESTAMP
                     WHERE id = $1`,
                    [deliveryId]
                );
                return null;
            }

            const leaseToken = crypto.randomUUID();
            const claimSeq = Number(row.claim_seq) + 1;
            const requestKey = crypto.createHash('sha256').update(row.idempotency_key).digest('hex');
            const claimed = await db(
                `UPDATE notification_deliveries
                 SET status = 'sending', attempts = attempts + 1, claim_seq = $2,
                     lease_token = $3, lease_owner = $4,
                     lease_until = CURRENT_TIMESTAMP + ($5::text || ' milliseconds')::interval,
                     last_attempt_at = CURRENT_TIMESTAMP, next_attempt_at = NULL,
                     updated_at = CURRENT_TIMESTAMP
                 WHERE id = $1
                 RETURNING id, attempts, max_attempts, status, provider, recipient_hash,
                           locale, timezone, payload, payload_hash, claim_seq,
                           idempotency_key`,
                [deliveryId, claimSeq, leaseToken, leaseOwner, env.NOTIFICATION_SEND_LEASE_MS]
            );
            await db(
                `INSERT INTO notification_attempts
                     (delivery_id, claim_seq, lease_token, lease_owner, provider, request_key)
                 VALUES ($1, $2, $3, $4, $5, $6)`,
                [deliveryId, claimSeq, leaseToken, leaseOwner, row.provider, requestKey]
            );
            return {
                ...rowRecord(claimed.rows[0]),
                leaseToken,
                leaseOwner,
                requestKey,
            };
        });
    }

    async defer(deliveryId: string, provider: string, delayMs: number, reason: string): Promise<boolean> {
        const result = await query(
            `UPDATE notification_deliveries
             SET status = 'retry_scheduled', next_attempt_at = $1, error_message = $2,
                 retry_seq = retry_seq + 1, updated_at = CURRENT_TIMESTAMP
             WHERE id = $3 AND provider = $4 AND status IN ('pending', 'retry_scheduled')`,
            [new Date(Date.now() + Math.max(1, delayMs)).toISOString(), reason, deliveryId, provider]
        );
        return (result.rowCount || 0) > 0;
    }

    async deferClaim(claim: DeliveryClaim, delayMs: number, reason: string): Promise<boolean> {
        return transaction(async (db) => {
            const retryAt = new Date(Date.now() + Math.max(1, delayMs)).toISOString();
            const attempt = await db(
                `UPDATE notification_attempts
                 SET status = 'deferred', effect = 'none', error_message = $1,
                     retry_at = $2, finished_at = CURRENT_TIMESTAMP
                 WHERE lease_token = $3 AND status = 'claimed'`,
                [reason, retryAt, claim.leaseToken]
            );
            if (attempt.rowCount !== 1) return false;
            const delivery = await db(
                `UPDATE notification_deliveries
                 SET status = 'retry_scheduled', attempts = GREATEST(attempts - 1, 0),
                     next_attempt_at = $1, error_message = $2, retry_seq = retry_seq + 1,
                     lease_token = NULL, lease_owner = NULL, lease_until = NULL,
                     updated_at = CURRENT_TIMESTAMP
                 WHERE id = $3 AND status = 'sending' AND claim_seq = $4 AND lease_token = $5`,
                [retryAt, reason, claim.id, claim.claimSeq, claim.leaseToken]
            );
            if (delivery.rowCount !== 1) {
                throw new Error('Notification defer fence is inconsistent');
            }
            return true;
        });
    }

    async markPreferenceFailure(
        deliveryId: string,
        reason: string,
        status: DeliveryStatus = 'failed'
    ): Promise<void> {
        await query(
            `UPDATE notification_deliveries
             SET status = $1, error_message = $2, updated_at = CURRENT_TIMESTAMP
             WHERE id = $3 AND status IN ('pending', 'retry_scheduled')`,
            [status, reason, deliveryId]
        );
    }

    async applyProviderResult(input: {
        claim: DeliveryClaim;
        result: ProviderSendResult;
    }): Promise<DeliveryOutcome> {
        const { claim, result } = input;
        const outcome = await transaction(async (db) => {
            const selected = await db(
                `SELECT id, attempts, max_attempts, channel, provider, recipient_hash
                 FROM notification_deliveries
                 WHERE id = $1 AND status = 'sending' AND claim_seq = $2 AND lease_token = $3
                 FOR UPDATE`,
                [claim.id, claim.claimSeq, claim.leaseToken]
            );
            const row = selected.rows[0];
            if (!row) return 'stale' as const;

            const metadata = JSON.stringify(result.metadata || {});
            if (result.kind === 'accepted') {
                const attempt = await db(
                    `UPDATE notification_attempts
                     SET status = 'accepted', effect = 'accepted', provider_message_id = $1,
                         provider_status = $2, metadata = $3::jsonb, finished_at = CURRENT_TIMESTAMP
                     WHERE lease_token = $4 AND status = 'claimed'`,
                    [result.providerMessageId || null, result.providerStatus || null, metadata, claim.leaseToken]
                );
                if (attempt.rowCount !== 1) throw new Error('Notification attempt fence is inconsistent');
                await db(
                    `UPDATE notification_deliveries
                     SET status = $1, provider_message_id = $2, provider_status = $3,
                         error_message = NULL, sent_at = CURRENT_TIMESTAMP,
                         metadata = COALESCE(metadata, '{}'::jsonb) || $4::jsonb,
                         lease_token = NULL, lease_owner = NULL, lease_until = NULL,
                         updated_at = CURRENT_TIMESTAMP
                     WHERE id = $5`,
                    ['sent', result.providerMessageId || null,
                        result.providerStatus || null, metadata, claim.id]
                );
                return 'delivered' as const;
            }

            if (result.kind === 'retryable_failure') {
                if (result.effect === 'unknown') {
                    const attempt = await db(
                        `UPDATE notification_attempts
                         SET status = 'ambiguous', effect = 'unknown', provider_status = $1,
                             error_code = $1, error_message = $2, metadata = $3::jsonb,
                             finished_at = CURRENT_TIMESTAMP
                         WHERE lease_token = $4 AND status = 'claimed'`,
                        [result.errorCode || null, result.errorMessage, metadata, claim.leaseToken]
                    );
                    if (attempt.rowCount !== 1) throw new Error('Notification attempt fence is inconsistent');
                    await db(
                        `UPDATE notification_deliveries
                         SET status = 'ambiguous', provider_status = $1, error_message = $2,
                             metadata = COALESCE(metadata, '{}'::jsonb) || $3::jsonb,
                             lease_token = NULL, lease_owner = NULL, lease_until = NULL,
                             updated_at = CURRENT_TIMESTAMP
                         WHERE id = $4`,
                        [result.errorCode || null, result.errorMessage, metadata, claim.id]
                    );
                    return 'terminal' as const;
                }
                const exhausted = Number(row.attempts) >= Number(row.max_attempts);
                const retryAt = exhausted ? null : calculateRetryAt(
                    Number(row.attempts),
                    result.retryAfterMs,
                    env.NOTIFICATION_RETRY_BASE_MS,
                    env.NOTIFICATION_RETRY_MAX_MS
                );
                const attempt = await db(
                    `UPDATE notification_attempts
                     SET status = 'retryable', effect = $1, provider_status = $2,
                         error_code = $2, error_message = $3, metadata = $4::jsonb,
                         retry_at = $5, finished_at = CURRENT_TIMESTAMP
                     WHERE lease_token = $6 AND status = 'claimed'`,
                    [result.effect, result.errorCode || null, result.errorMessage, metadata,
                        retryAt?.toISOString() || null, claim.leaseToken]
                );
                if (attempt.rowCount !== 1) throw new Error('Notification attempt fence is inconsistent');
                await db(
                    `UPDATE notification_deliveries
                     SET status = $1, provider_status = $2, next_attempt_at = $3,
                         error_message = $4, retry_seq = retry_seq + 1,
                         metadata = COALESCE(metadata, '{}'::jsonb) || $5::jsonb,
                         lease_token = NULL, lease_owner = NULL, lease_until = NULL,
                         updated_at = CURRENT_TIMESTAMP
                     WHERE id = $6`,
                    [exhausted ? 'dead_lettered' : 'retry_scheduled', result.errorCode || null,
                        retryAt?.toISOString() || null, result.errorMessage, metadata, claim.id]
                );
                return exhausted ? 'terminal' as const : 'scheduled' as const;
            }

            const status = result.suppressRecipient ? 'suppressed' : 'failed';
            const attempt = await db(
                `UPDATE notification_attempts
                 SET status = 'permanent', effect = 'none', provider_status = $1,
                     error_code = $1, error_message = $2, metadata = $3::jsonb,
                     finished_at = CURRENT_TIMESTAMP
                 WHERE lease_token = $4 AND status = 'claimed'`,
                [result.errorCode || null, result.errorMessage, metadata, claim.leaseToken]
            );
            if (attempt.rowCount !== 1) throw new Error('Notification attempt fence is inconsistent');
            await db(
                `UPDATE notification_deliveries
                 SET status = $1, provider_status = $2, error_message = $3,
                     metadata = COALESCE(metadata, '{}'::jsonb) || $4::jsonb,
                     lease_token = NULL, lease_owner = NULL, lease_until = NULL,
                     updated_at = CURRENT_TIMESTAMP
                 WHERE id = $5`,
                [status, result.errorCode || null, result.errorMessage, metadata, claim.id]
            );
            return 'terminal' as const;
        });
        return outcome;
    }
}

export const notificationDeliveryService = new NotificationDeliveryService();
