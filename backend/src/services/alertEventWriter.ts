import crypto from 'crypto';
import { transaction } from '../config/database';
import { AlertCandidate, AlertNotificationJob, TokenAlert } from '../types';
import { eventOutbox } from './eventOutbox';
import { metrics } from './metrics';
import { STREAMS } from './redisStreamService';
import { qualityForThreshold, valueForThreshold } from './alertValue';
import { shardForToken } from './subscriptionRegistry';

export interface AlertWriteResult {
    created: boolean;
    alertEventId?: string;
}

export const alertEventKey = (alertId: string, signature: string, thresholdType: string): string => {
    return crypto.createHash('sha256').update(`${alertId}:${signature}:${thresholdType}`).digest('hex');
};

export const candidateFromAlertTick = (alert: TokenAlert, tick: import('../types').FeedTick): AlertCandidate => {
    const currentValue = valueForThreshold(alert.threshold_type, tick);
    if (currentValue === undefined || !Number.isFinite(currentValue)) {
        throw new Error(`Tick does not contain ${alert.threshold_type}`);
    }
    const quality = qualityForThreshold(alert.threshold_type, tick);
    if (!quality || quality.stale || !Number.isFinite(quality.confidence)
        || quality.confidence < 0 || quality.confidence > 1) {
        throw new Error(`Tick does not contain eligible ${alert.threshold_type} provenance`);
    }
    const sourceEventId = tick.sourceEventId || tick.signature;
    const now = new Date().toISOString();
    return {
        alertId: alert.id,
        userId: alert.user_id,
        tokenAddress: alert.token_address,
        thresholdType: alert.threshold_type,
        thresholdValue: Number(alert.threshold_value),
        condition: alert.condition,
        currentValue,
        notificationType: alert.notification_type,
        signature: tick.signature,
        slot: tick.slot,
        sourceEventId,
        observedAt: tick.observedAt || tick.receivedAt,
        receivedAt: tick.receivedAt,
        matchedAt: now,
        idempotencyKey: alertEventKey(alert.id, `${alert.generation}:${sourceEventId}`, alert.threshold_type),
        engineVersion: 'node-alert-matcher',
        alertGeneration: alert.generation,
        basisCommitment: quality.commitment,
        metricConfidence: quality.confidence,
        metricEstimated: quality.estimated,
        metricVersion: tick.metricVersion || 'unknown',
        metricRevision: tick.metricRevision,
    };
};

export class AlertEventWriter {
    async writeCandidate(candidate: AlertCandidate): Promise<AlertWriteResult> {
        const result = await transaction(async (db) => {
            const updatedAlert = await db(
                `UPDATE token_alerts
                 SET is_triggered = true,
                     is_active = false,
                     triggered_at = CURRENT_TIMESTAMP
                 WHERE id = $1
                   AND generation = $2
                   AND is_active = true
                   AND is_triggered = false
                 RETURNING id, user_id::text, token_address, threshold_type,
                           threshold_value::float8, condition, notification_type, generation`,
                [candidate.alertId, candidate.alertGeneration]
            );

            if (updatedAlert.rows.length === 0) return null;
            const definition = updatedAlert.rows[0];
            if (definition.user_id !== candidate.userId
                || definition.token_address !== candidate.tokenAddress
                || definition.threshold_type !== candidate.thresholdType
                || Number(definition.threshold_value) !== candidate.thresholdValue
                || definition.condition !== candidate.condition
                || definition.notification_type !== candidate.notificationType
                || Number(definition.generation) !== candidate.alertGeneration) {
                throw new Error('Alert candidate does not match its fenced definition');
            }

            const event = await db(
                `INSERT INTO alert_events
                 (alert_id, user_id, token_address, threshold_type, threshold_value, condition,
                  current_value, notification_type, idempotency_key, alert_generation,
                  source_event_id, signature, slot, observed_at, received_at, matched_at,
                  engine_version, basis_commitment, metric_confidence, metric_estimated,
                  metric_version, metric_revision)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
                         $14, $15, $16, $17, $18, $19, $20, $21, $22)
                 RETURNING id, created_at`,
                [
                    candidate.alertId,
                    candidate.userId,
                    candidate.tokenAddress,
                    candidate.thresholdType,
                    candidate.thresholdValue,
                    candidate.condition,
                    candidate.currentValue,
                    candidate.notificationType,
                    candidate.idempotencyKey,
                    candidate.alertGeneration,
                    candidate.sourceEventId,
                    candidate.signature,
                    candidate.slot ?? null,
                    candidate.observedAt,
                    candidate.receivedAt,
                    candidate.matchedAt,
                    candidate.engineVersion,
                    candidate.basisCommitment ?? null,
                    candidate.metricConfidence,
                    candidate.metricEstimated,
                    candidate.metricVersion,
                    candidate.metricRevision ?? null,
                ]
            );

            const job: AlertNotificationJob = {
                alertEventId: event.rows[0].id,
                alertId: candidate.alertId,
                userId: candidate.userId,
                tokenAddress: candidate.tokenAddress,
                currentValue: candidate.currentValue,
                notificationType: candidate.notificationType,
                idempotencyKey: candidate.idempotencyKey,
                triggeredAt: event.rows[0].created_at?.toISOString?.() || new Date().toISOString(),
            };
            await eventOutbox.enqueue(
                db,
                STREAMS.notificationsPending,
                `alert-notification:${job.alertEventId}:${job.notificationType}`,
                job
            );
            await eventOutbox.enqueue(
                db,
                STREAMS.alertsTriggered,
                `alert-triggered:${job.alertEventId}`,
                {
                    ...job,
                    engineVersion: candidate.engineVersion,
                    matchedAt: candidate.matchedAt,
                    sourceEventId: candidate.sourceEventId,
                    signature: candidate.signature,
                    slot: candidate.slot,
                }
            );
            await eventOutbox.enqueue(
                db,
                STREAMS.alertIndexUpdates,
                `alert-triggered-index:${job.alertEventId}`,
                {
                    type: 'alert_updated',
                    alertId: candidate.alertId,
                    tokenAddress: candidate.tokenAddress,
                    shardId: shardForToken(candidate.tokenAddress),
                    createdAt: new Date().toISOString(),
                }
            );
            return job;
        });

        if (!result) {
            metrics.increment('fervor_alert_stale_candidates');
            return { created: false };
        }
        return { created: true, alertEventId: result.alertEventId };
    }
}
