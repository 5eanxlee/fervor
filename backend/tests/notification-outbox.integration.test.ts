import crypto from 'crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const enabled = process.env.RUN_INFRA_TESTS === 'true';
const suite = enabled ? describe : describe.skip;

suite('notification outbox infrastructure', () => {
    let query: any;
    let redisStreams: any;
    let STREAMS: any;
    let eventOutbox: any;
    let AlertEventWriter: any;
    let deliveryService: any;
    let retryService: any;
    let rateService: any;
    let userId = '';
    let alertId = '';
    let eventId = '';
    let deliveryId = '';
    const marker = crypto.randomBytes(8).toString('hex');
    const eventKey = crypto.createHash('sha256').update(`outbox:${marker}`).digest('hex');

    beforeAll(async () => {
        process.env.DATABASE_URL = 'postgresql://fervor@localhost:55432/fervor';
        process.env.REDIS_URL = 'redis://localhost:6379';
        ({ query } = await import('../src/config/database'));
        ({ redisStreams, STREAMS } = await import('../src/services/redisStreamService'));
        ({ eventOutbox } = await import('../src/services/eventOutbox'));
        ({ AlertEventWriter } = await import('../src/services/alertEventWriter'));
        ({ notificationDeliveryService: deliveryService } = await import('../src/services/notifications/NotificationDeliveryService'));
        ({ notificationRetryService: retryService } = await import('../src/services/notifications/NotificationRetryService'));
        ({ notificationRateService: rateService } = await import('../src/services/notifications/NotificationRateService'));
        await redisStreams.connect();
        const user = await query(
            `INSERT INTO users (wallet_address) VALUES ($1) RETURNING id`,
            [`OutboxWallet${marker}`]
        );
        userId = user.rows[0].id;
        const alert = await query(
            `INSERT INTO token_alerts
                 (user_id, token_address, token_name, token_symbol, threshold_type, threshold_value, condition, notification_type)
             VALUES ($1, $2, 'Wrapped SOL', 'SOL', 'price', 100, 'above', 'telegram')
             RETURNING id`,
            [userId, 'So11111111111111111111111111111111111111112']
        );
        alertId = alert.rows[0].id;
    });

    afterAll(async () => {
        if (eventId) {
            await query('DELETE FROM event_outbox WHERE event_key LIKE $1', [`%${eventId}%`]);
            await redisStreams.command.del(
                `stream:seen:${STREAMS.notificationsPending}:alert-notification:${eventId}:telegram`,
                `stream:seen:${STREAMS.alertsTriggered}:alert-triggered:${eventId}`
            );
        }
        if (deliveryId) {
            await redisStreams.command.del(
                `stream:seen:${STREAMS.notificationsPending}:delivery-retry:${deliveryId}:1:0`
            );
        }
        await redisStreams.command.del(
            'notification:rate:telegram:global',
            'notification:rate:telegram:recipient:infra-recipient:hash'
        );
        if (userId) await query('DELETE FROM users WHERE id = $1', [userId]);
        await redisStreams.close();
    });

    it('commits alert state, event, and stream jobs atomically and publishes once', async () => {
        const result = await new AlertEventWriter().writeCandidate({
            alertId,
            userId,
            tokenAddress: 'So11111111111111111111111111111111111111112',
            thresholdType: 'price',
            thresholdValue: 100,
            condition: 'above',
            currentValue: 101,
            notificationType: 'telegram',
            signature: `signature-${marker}`,
            slot: 42,
            sourceEventId: `source-${marker}`,
            observedAt: new Date().toISOString(),
            receivedAt: new Date().toISOString(),
            matchedAt: new Date().toISOString(),
            idempotencyKey: eventKey,
            engineVersion: 'integration-test',
            alertGeneration: 1,
            basisCommitment: 'confirmed',
            metricConfidence: 0.9,
            metricEstimated: false,
            metricVersion: 'rolling-v2',
            metricRevision: 1,
        });
        expect(result.created).toBe(true);
        eventId = result.alertEventId;

        const durable = await query(
            `SELECT a.is_active, a.is_triggered,
                    (SELECT COUNT(*)::int FROM alert_events WHERE id = $2) AS event_count,
                    (SELECT COUNT(*)::int FROM event_outbox WHERE event_key LIKE $3) AS outbox_count
             FROM token_alerts a WHERE a.id = $1`,
            [alertId, eventId, `%${eventId}%`]
        );
        expect(durable.rows[0]).toMatchObject({
            is_active: false,
            is_triggered: true,
            event_count: 1,
            outbox_count: 3,
        });
        const basis = await query(
            `SELECT alert_generation, source_event_id, slot, engine_version, basis_commitment,
                    metric_confidence::float8, metric_estimated, metric_version, metric_revision
             FROM alert_events WHERE id = $1`,
            [eventId]
        );
        expect(basis.rows[0]).toMatchObject({
            alert_generation: '1',
            source_event_id: `source-${marker}`,
            slot: '42',
            engine_version: 'integration-test',
            basis_commitment: 'confirmed',
            metric_confidence: 0.9,
            metric_estimated: false,
            metric_version: 'rolling-v2',
            metric_revision: '1',
        });

        const beforeNotifications = await redisStreams.command.xlen(STREAMS.notificationsPending);
        const beforeAlerts = await redisStreams.command.xlen(STREAMS.alertsTriggered);
        expect(await eventOutbox.flushDue()).toBeGreaterThanOrEqual(2);
        expect(await redisStreams.command.xlen(STREAMS.notificationsPending)).toBe(beforeNotifications + 1);
        expect(await redisStreams.command.xlen(STREAMS.alertsTriggered)).toBe(beforeAlerts + 1);

        await query(
            `UPDATE event_outbox
             SET status = 'pending', next_attempt_at = CURRENT_TIMESTAMP, published_at = NULL
             WHERE stream = $1 AND event_key = $2`,
            [STREAMS.notificationsPending, `alert-notification:${eventId}:telegram`]
        );
        const beforeReplay = await redisStreams.command.xlen(STREAMS.notificationsPending);
        await eventOutbox.flushDue();
        expect(await redisStreams.command.xlen(STREAMS.notificationsPending)).toBe(beforeReplay);
    });

    it('rejects a candidate from an older alert generation without disabling the re-armed alert', async () => {
        await query(
            `UPDATE token_alerts
             SET generation = generation + 1, is_active = true, is_triggered = false, triggered_at = NULL
             WHERE id = $1`,
            [alertId]
        );
        const result = await new AlertEventWriter().writeCandidate({
            alertId,
            userId,
            tokenAddress: 'So11111111111111111111111111111111111111112',
            thresholdType: 'price',
            thresholdValue: 100,
            condition: 'above',
            currentValue: 102,
            notificationType: 'telegram',
            signature: `stale-signature-${marker}`,
            slot: 43,
            sourceEventId: `stale-source-${marker}`,
            observedAt: new Date().toISOString(),
            receivedAt: new Date().toISOString(),
            matchedAt: new Date().toISOString(),
            idempotencyKey: crypto.createHash('sha256').update(`stale:${marker}`).digest('hex'),
            engineVersion: 'integration-test',
            alertGeneration: 1,
            basisCommitment: 'confirmed',
            metricConfidence: 0.9,
            metricEstimated: false,
            metricVersion: 'rolling-v2',
            metricRevision: 2,
        });
        expect(result.created).toBe(false);
        const state = await query(
            `SELECT generation, is_active, is_triggered FROM token_alerts WHERE id = $1`,
            [alertId]
        );
        expect(state.rows[0]).toMatchObject({ generation: '2', is_active: true, is_triggered: false });
    });

    it('rolls back when candidate fields do not match the fenced alert definition', async () => {
        await expect(new AlertEventWriter().writeCandidate({
            alertId,
            userId: crypto.randomUUID(),
            tokenAddress: 'So11111111111111111111111111111111111111112',
            thresholdType: 'price',
            thresholdValue: 100,
            condition: 'above',
            currentValue: 103,
            notificationType: 'telegram',
            signature: `tampered-signature-${marker}`,
            slot: 44,
            sourceEventId: `tampered-source-${marker}`,
            observedAt: new Date().toISOString(),
            receivedAt: new Date().toISOString(),
            matchedAt: new Date().toISOString(),
            idempotencyKey: crypto.createHash('sha256').update(`tampered:${marker}`).digest('hex'),
            engineVersion: 'integration-test',
            alertGeneration: 2,
            basisCommitment: 'confirmed',
            metricConfidence: 0.9,
            metricEstimated: false,
            metricVersion: 'rolling-v2',
            metricRevision: 3,
        })).rejects.toThrow('fenced definition');
        const state = await query(
            `SELECT generation, is_active, is_triggered FROM token_alerts WHERE id = $1`,
            [alertId]
        );
        expect(state.rows[0]).toMatchObject({ generation: '2', is_active: true, is_triggered: false });
    });

    it('defers without burning attempts and durably schedules provider retries', async () => {
        const job = {
            alertEventId: eventId,
            alertId,
            userId,
            tokenAddress: 'So11111111111111111111111111111111111111112',
            currentValue: 101,
            notificationType: 'telegram' as const,
            idempotencyKey: eventKey,
            triggeredAt: new Date().toISOString(),
        };
        const context = await deliveryService.loadContext(job);
        expect(context.payload.alert).toMatchObject({
            id: alertId,
            threshold_value: 100,
            generation: 1,
        });
        const resolution = {
            channel: 'telegram' as const,
            enabled: true,
            verified: true,
            suppressed: false,
            recipient: 'infra-recipient',
            recipientHash: 'infra-recipient:hash',
            locale: 'en',
            timezone: 'UTC',
        };
        const delivery = await deliveryService.begin(
            job,
            context,
            resolution,
            'telegram'
        );
        deliveryId = delivery.id;
        expect(deliveryService.resolutionMatches(delivery, resolution)).toBe(true);
        expect(deliveryService.resolutionMatches(delivery, {
            ...resolution,
            recipientHash: 'changed-recipient:hash',
        })).toBe(false);
        const frozen = await query(
            `SELECT payload_version, payload_hash, recipient_hash, provider
             FROM notification_deliveries WHERE id = $1`,
            [delivery.id]
        );
        expect(frozen.rows[0]).toMatchObject({
            payload_version: 1,
            recipient_hash: 'infra-recipient:hash',
            provider: 'telegram',
        });
        expect(frozen.rows[0].payload_hash).toMatch(/^[0-9a-f]{64}$/);
        await query(
            `UPDATE token_alerts SET token_name = 'Renamed after trigger', token_symbol = 'EDITED' WHERE id = $1`,
            [alertId]
        );
        const repeatedContext = await deliveryService.loadContext(job);
        const repeated = await deliveryService.begin(job, repeatedContext, resolution, 'telegram');
        expect(repeated.payloadHash).toBe(frozen.rows[0].payload_hash);
        expect(repeated.payload.alert.token_name).toBeUndefined();

        const rateClaim = await deliveryService.claim(delivery.id, 'infra-rate-gate');
        expect(await deliveryService.deferClaim(rateClaim, 100, 'rate gate')).toBe(true);
        const deferred = await query(
            `SELECT status, attempts, retry_seq FROM notification_deliveries WHERE id = $1`,
            [delivery.id]
        );
        expect(deferred.rows[0]).toMatchObject({ status: 'retry_scheduled', attempts: 0, retry_seq: 1 });

        await query('UPDATE notification_deliveries SET next_attempt_at = NOW() WHERE id = $1', [delivery.id]);
        expect(await retryService.republishDue()).toBeGreaterThanOrEqual(1);
        const retryOutbox = await query(
            `SELECT status FROM event_outbox WHERE event_key = $1`,
            [`delivery-retry:${delivery.id}:1:0`]
        );
        expect(retryOutbox.rows[0].status).toBe('pending');
        await eventOutbox.flushDue();

        const claimed = await deliveryService.claim(delivery.id, 'infra-worker-1');
        expect(claimed.attempts).toBe(1);
        expect(claimed.claimSeq).toBe(2);
        const before = Date.now();
        expect(await deliveryService.applyProviderResult({
            claim: claimed,
            result: {
                kind: 'retryable_failure',
                errorCode: '429',
                errorMessage: 'rate limited',
                retryAfterMs: 60_000,
                rateScope: 'recipient',
                effect: 'none',
            },
        })).toBe('scheduled');
        const scheduled = await query(
            `SELECT status, attempts, retry_seq, next_attempt_at FROM notification_deliveries WHERE id = $1`,
            [delivery.id]
        );
        expect(scheduled.rows[0]).toMatchObject({ status: 'retry_scheduled', attempts: 1, retry_seq: 2 });
        expect(new Date(scheduled.rows[0].next_attempt_at).getTime()).toBeGreaterThanOrEqual(before + 60_000);

        await query('UPDATE notification_deliveries SET next_attempt_at = NOW() WHERE id = $1', [delivery.id]);
        const second = await deliveryService.claim(delivery.id, 'infra-worker-2');
        expect(second.claimSeq).toBe(3);
        expect(second.requestKey).toBe(claimed.requestKey);
        expect(await deliveryService.applyProviderResult({
            claim: claimed,
            result: { kind: 'accepted', providerMessageId: 'late-result' },
        })).toBe('stale');
        expect(await deliveryService.applyProviderResult({
            claim: second,
            result: { kind: 'accepted', providerMessageId: 'winning-result' },
        })).toBe('delivered');
        const fenced = await query(
            `SELECT delivery.status, delivery.provider_message_id, delivery.claim_seq,
                    COUNT(attempt.id)::int AS attempt_count,
                    COUNT(attempt.id) FILTER (WHERE attempt.status = 'accepted')::int AS accepted_count
             FROM notification_deliveries delivery
             JOIN notification_attempts attempt ON attempt.delivery_id = delivery.id
             WHERE delivery.id = $1
             GROUP BY delivery.id`,
            [delivery.id]
        );
        expect(fenced.rows[0]).toMatchObject({
            status: 'sent',
            provider_message_id: 'winning-result',
            claim_seq: '3',
            attempt_count: 3,
            accepted_count: 1,
        });
        const deferredAttempts = await query(
            `SELECT COUNT(*)::int AS count FROM notification_attempts
             WHERE delivery_id = $1 AND status = 'deferred'`,
            [delivery.id]
        );
        expect(deferredAttempts.rows[0].count).toBe(1);
    });

    it('enforces shared provider and recipient quotas through Redis', async () => {
        await redisStreams.command.del(
            'notification:rate:telegram:global',
            'notification:rate:telegram:recipient:infra-recipient:hash'
        );
        expect(await rateService.reserve('telegram', 'infra-recipient:hash')).toBe(0);
        expect(await rateService.reserve('telegram', 'infra-recipient:hash')).toBeGreaterThan(0);
    });

    it('parks an unknown Telegram effect instead of sending a duplicate retry', async () => {
        const candidateKey = crypto.createHash('sha256').update(`ambiguous:${marker}`).digest('hex');
        const written = await new AlertEventWriter().writeCandidate({
            alertId,
            userId,
            tokenAddress: 'So11111111111111111111111111111111111111112',
            thresholdType: 'price',
            thresholdValue: 100,
            condition: 'above',
            currentValue: 104,
            notificationType: 'telegram',
            signature: `ambiguous-signature-${marker}`,
            slot: 45,
            sourceEventId: `ambiguous-source-${marker}`,
            observedAt: new Date().toISOString(),
            receivedAt: new Date().toISOString(),
            matchedAt: new Date().toISOString(),
            idempotencyKey: candidateKey,
            engineVersion: 'integration-test',
            alertGeneration: 2,
            basisCommitment: 'confirmed',
            metricConfidence: 0.9,
            metricEstimated: false,
            metricVersion: 'rolling-v2',
            metricRevision: 4,
        });
        const job = {
            alertEventId: written.alertEventId,
            alertId,
            userId,
            tokenAddress: 'So11111111111111111111111111111111111111112',
            currentValue: 104,
            notificationType: 'telegram' as const,
            idempotencyKey: candidateKey,
            triggeredAt: new Date().toISOString(),
        };
        const context = await deliveryService.loadContext(job);
        const resolution = {
            channel: 'telegram' as const,
            enabled: true,
            verified: true,
            suppressed: false,
            recipient: 'infra-recipient',
            recipientHash: 'infra-recipient:hash',
            locale: 'en',
            timezone: 'UTC',
        };
        const delivery = await deliveryService.begin(job, context, resolution, 'telegram');
        const claim = await deliveryService.claim(delivery.id, 'infra-ambiguous');
        expect(await deliveryService.applyProviderResult({
            claim,
            result: {
                kind: 'retryable_failure',
                errorCode: 'network_timeout',
                errorMessage: 'response was not observed',
                effect: 'unknown',
            },
        })).toBe('terminal');
        const state = await query(
            `SELECT status, next_attempt_at FROM notification_deliveries WHERE id = $1`,
            [delivery.id]
        );
        expect(state.rows[0]).toMatchObject({ status: 'ambiguous', next_attempt_at: null });
        expect(await deliveryService.claim(delivery.id, 'infra-duplicate')).toBeNull();
    });
});
