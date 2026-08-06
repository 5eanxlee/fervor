import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/config/database', () => ({
    query: vi.fn(),
    transaction: vi.fn(async (work: (db: any) => Promise<any>) => {
        const database = await import('../src/config/database');
        return work(database.query);
    }),
}));

vi.mock('../src/services/redisStreamService', () => ({
    STREAMS: {
        providerRawEvents: 'provider.raw_events',
        marketTrades: 'market.trades',
        marketPoolEvents: 'market.pool_events',
        marketStates: 'market.states',
        marketCandles: 'market.candles',
        ticksRaw: 'ticks.raw',
        ticksNormalized: 'ticks.normalized',
        alertCandidates: 'alerts.candidates',
        alertsTriggered: 'alerts.triggered',
        notificationsPending: 'notifications.pending',
        alertIndexUpdates: 'alerts.index_updates',
        deadLetters: 'pipeline.dead_letters',
    },
    tickStream: (shardId: number, shardCount: number) =>
        shardCount === 1 ? 'ticks.normalized' : `ticks.normalized.${shardId}`,
    redisStreams: {
        publish: vi.fn().mockResolvedValue('1-0'),
        connect: vi.fn().mockResolvedValue(undefined),
        ensureGroup: vi.fn().mockResolvedValue(undefined),
    },
}));

import { query } from '../src/config/database';
import { AlertMatcherService, alertEventKey } from '../src/services/alertMatcher';
import { AlertCandidateConsumerService } from '../src/services/alertCandidateConsumer';
import { normalizeSwapNotification } from '../src/services/tickNormalizer';
import { shardForToken, SubscriptionRegistry } from '../src/services/subscriptionRegistry';
import { redisStreams, STREAMS } from '../src/services/redisStreamService';
import { streamMessagesToSseEvents } from '../src/routes/streams';
import { FeedTick, TokenAlert } from '../src/types';

const mockedQuery = vi.mocked(query);
const mockedRedis = vi.mocked(redisStreams);

const alert: TokenAlert = {
    id: 'alert-1',
    user_id: 'user-1',
    token_address: 'So11111111111111111111111111111111111111112',
    token_name: 'Wrapped SOL',
    token_symbol: 'SOL',
    threshold_type: 'market_cap',
    threshold_value: 100,
    condition: 'above',
    notification_type: 'discord',
    is_active: true,
    is_triggered: false,
    generation: 1,
    created_at: new Date(),
    updated_at: new Date(),
};
const alertDefinition = {
    id: alert.id,
    user_id: alert.user_id,
    token_address: alert.token_address,
    threshold_type: alert.threshold_type,
    threshold_value: alert.threshold_value,
    condition: alert.condition,
    notification_type: alert.notification_type,
    generation: alert.generation,
};

const tick: FeedTick = {
    tokenAddress: alert.token_address,
    signature: 'signature-1',
    slot: 100,
    blockTime: 1710000000,
    price: 1,
    marketCap: 150,
    usdValue: 150,
    receivedAt: new Date().toISOString(),
    sourceEventId: 'metric:event-1',
    observedAt: new Date().toISOString(),
    metricVersion: 'rolling-v2',
    metricRevision: 1,
    metricQuality: {
        market_cap: {
            sourceEventId: 'supply-1',
            observedAt: new Date().toISOString(),
            confidence: 0.9,
            stale: false,
            estimated: true,
            commitment: 'confirmed',
        },
    },
};

describe('scalable backend architecture primitives', () => {
    beforeEach(() => {
        mockedQuery.mockReset();
        mockedRedis.publish.mockClear();
    });

    it('assigns tokens to deterministic feed shards', () => {
        const token = 'So11111111111111111111111111111111111111112';
        expect(shardForToken(token, 16)).toBe(shardForToken(token, 16));
        expect(shardForToken(token, 16)).toBeGreaterThanOrEqual(0);
        expect(shardForToken(token, 16)).toBeLessThan(16);
    });

    it('normalizes provider swap notifications into stable feed ticks', () => {
        const normalized = normalizeSwapNotification({
            slot: 42,
            signature: 'abc',
            blockTime: 1710000000,
            swap: {
                baseTokenMint: alert.token_address,
                quotePrice: '1.25',
                usdValue: 1234,
                swapType: 'buy',
            },
        });

        expect(normalized).toMatchObject({
            tokenAddress: alert.token_address,
            signature: 'abc',
            slot: 42,
            price: 1.25,
            swapType: 'buy',
        });
        expect(normalized?.marketCap).toBeUndefined();
    });

    it('syncs monitored token state and emits alert index updates', async () => {
        mockedQuery
            .mockResolvedValueOnce({ rows: [{ count: 3 }] } as any)
            .mockResolvedValueOnce({ rows: [] } as any);

        const registry = new SubscriptionRegistry();
        await registry.syncAndEmit('alert_created', alert.token_address, alert.id, alert.token_name, alert.token_symbol);

        expect(mockedRedis.publish).toHaveBeenCalledWith(
            STREAMS.alertIndexUpdates,
            expect.objectContaining({
                type: 'alert_created',
                alertId: alert.id,
                tokenAddress: alert.token_address,
            })
        );
    });

    it('creates idempotent alert events and notification jobs from matched ticks', async () => {
        mockedQuery
            .mockResolvedValueOnce({ rows: [alertDefinition] } as any)
            .mockResolvedValueOnce({ rows: [{ id: 'event-1', created_at: new Date('2026-04-27T00:00:00Z') }] } as any)
            .mockResolvedValueOnce({ rows: [{ id: 'outbox-1' }] } as any)
            .mockResolvedValueOnce({ rows: [{ id: 'outbox-2' }] } as any)
            .mockResolvedValueOnce({ rows: [{ id: 'outbox-3' }] } as any);

        const matcher = new AlertMatcherService({
            match: () => [alert],
        } as any);

        await expect(matcher.handleTick(tick)).resolves.toBe(1);

    });

    it('propagates a durable event write failure so the stream entry can retry', async () => {
        mockedQuery
            .mockResolvedValueOnce({ rows: [alertDefinition] } as any)
            .mockRejectedValueOnce(new Error('duplicate event identity'));
        const matcher = new AlertMatcherService({
            match: () => [alert],
        } as any);

        await expect(matcher.handleTick(tick)).rejects.toThrow('duplicate event identity');

        expect(mockedQuery).toHaveBeenCalledTimes(2);
    });

    it('drops stale candidates for inactive or already-triggered alerts before writing events', async () => {
        mockedQuery.mockResolvedValueOnce({ rows: [] } as any);
        const matcher = new AlertMatcherService({
            match: () => [alert],
        } as any);

        await expect(matcher.handleTick(tick)).resolves.toBe(0);

        expect(mockedQuery).toHaveBeenCalledTimes(1);
    });

    it('persists low-latency alert candidates through the durable Node writer', async () => {
        mockedQuery
            .mockResolvedValueOnce({ rows: [alertDefinition] } as any)
            .mockResolvedValueOnce({ rows: [{ id: 'event-2', created_at: new Date('2026-04-27T00:00:00Z') }] } as any)
            .mockResolvedValueOnce({ rows: [{ id: 'outbox-2' }] } as any)
            .mockResolvedValueOnce({ rows: [{ id: 'outbox-3' }] } as any)
            .mockResolvedValueOnce({ rows: [{ id: 'outbox-4' }] } as any);

        const consumer = new AlertCandidateConsumerService();
        await expect(consumer.handleCandidate({
            alertId: alert.id,
            userId: alert.user_id,
            tokenAddress: alert.token_address,
            thresholdType: alert.threshold_type,
            thresholdValue: alert.threshold_value,
            condition: alert.condition,
            currentValue: 150,
            notificationType: alert.notification_type,
            signature: tick.signature,
            slot: tick.slot,
            sourceEventId: tick.signature,
            observedAt: tick.receivedAt,
            receivedAt: tick.receivedAt,
            matchedAt: new Date('2026-04-27T00:00:00Z').toISOString(),
            idempotencyKey: alertEventKey(alert.id, `${alert.generation}:${tick.signature}`, alert.threshold_type),
            engineVersion: 'rust-shadow-test',
            alertGeneration: alert.generation,
            basisCommitment: 'confirmed',
            metricConfidence: 0.9,
            metricEstimated: false,
            metricVersion: 'rolling-v2',
            metricRevision: 1,
        })).resolves.toBe(true);

        expect(mockedQuery.mock.calls[3][1]).toEqual(expect.arrayContaining([
            STREAMS.alertsTriggered,
            expect.stringContaining('event-2'),
        ]));
    });

    it('filters ordered batched SSE payloads by token', () => {
        const events = streamMessagesToSseEvents([
            {
                stream: STREAMS.marketTrades,
                id: '1-0',
                payload: { tokenMint: 'token-a', side: 'buy', usdAmount: 10 },
            },
            {
                stream: STREAMS.marketStates,
                id: '2-0',
                payload: { tokenMint: 'token-b', priceUsd: 1 },
            },
            {
                stream: STREAMS.marketCandles,
                id: '3-0',
                payload: { tokenAddress: 'token-a', close: 0.1 },
            },
        ], 'token-a');

        expect(events.map((event) => event.event)).toEqual(['trade', 'candle']);
        expect(events.map((event) => event.id)).toEqual(['1-0', '3-0']);
    });
});
