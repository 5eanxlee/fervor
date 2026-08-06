import crypto from 'crypto';
import { describe, expect, it } from 'vitest';
import { candidateFromAlertTick } from '../src/services/alertEventWriter';
import { valueForThreshold } from '../src/services/alertValue';
import {
    alertCreateSchema,
    alertCandidateSchema,
    alertNotificationJobSchema,
    alertUpdateSchema,
    AlertThresholdType,
    FeedTick,
    TokenAlert,
} from '../src/types';

const tick: FeedTick = {
    tokenAddress: 'So11111111111111111111111111111111111111112',
    signature: 'signature-1',
    slot: 1,
    blockTime: 1,
    price: 1.25,
    marketCap: 1_000_000,
    liquidity: 250_000,
    volume: { '5m': 75_000 },
    buyCount: { '1m': 12 },
    sellCount: { '1h': 30 },
    txCount: { '24h': 900 },
    usdValue: 1_000,
    receivedAt: new Date().toISOString(),
    sourceEventId: 'metric:event-1',
    observedAt: new Date().toISOString(),
    metricVersion: 'rolling-v2',
    metricRevision: 7,
    metricQuality: {
        price: { sourceEventId: 'price-1', observedAt: new Date().toISOString(), confidence: 0.9, stale: false, estimated: true, commitment: 'confirmed' },
        market_cap: { sourceEventId: 'supply-1', observedAt: new Date().toISOString(), confidence: 0.8, stale: false, estimated: true, commitment: 'confirmed' },
        liquidity: { sourceEventId: 'pool-1', observedAt: new Date().toISOString(), confidence: 0.8, stale: false, estimated: false, commitment: 'confirmed' },
        rolling: { sourceEventId: 'rolling-1', observedAt: new Date().toISOString(), confidence: 0.9, stale: false, estimated: false, commitment: 'confirmed' },
    },
};

describe('alert metrics', () => {
    it.each<[AlertThresholdType, number]>([
        ['price', 1.25],
        ['market_cap', 1_000_000],
        ['liquidity', 250_000],
        ['volume_5m', 75_000],
        ['buy_count_1m', 12],
        ['sell_count_1h', 30],
        ['tx_count_24h', 900],
    ])('resolves %s from a normalized market tick', (type, expected) => {
        expect(valueForThreshold(type, tick)).toBe(expected);
    });

    it('does not invent a zero value for a missing metric', () => {
        expect(valueForThreshold('liquidity', { ...tick, liquidity: undefined })).toBeUndefined();
        expect(valueForThreshold('volume_1m', tick)).toBeUndefined();
    });

    it('uses the same metric resolver when creating durable alert candidates', () => {
        const alert = {
            id: 'alert-1', user_id: 'user-1', token_address: tick.tokenAddress,
            threshold_type: 'volume_5m', threshold_value: 50_000, condition: 'above',
            notification_type: 'discord', is_active: true, is_triggered: false,
            generation: 2,
            created_at: new Date(), updated_at: new Date(),
        } as TokenAlert;
        expect(candidateFromAlertTick(alert, tick)).toMatchObject({
            thresholdType: 'volume_5m',
            currentValue: 75_000,
            notificationType: 'discord',
            alertGeneration: 2,
            sourceEventId: 'metric:event-1',
            basisCommitment: 'confirmed',
            metricRevision: 7,
        });
    });

    it('fails closed when a metric is stale or lacks lineage', () => {
        const alert = {
            id: 'alert-1', user_id: 'user-1', token_address: tick.tokenAddress,
            threshold_type: 'price', threshold_value: 1, condition: 'above',
            notification_type: 'discord', is_active: true, is_triggered: false,
            generation: 1, created_at: new Date(), updated_at: new Date(),
        } as TokenAlert;
        expect(() => candidateFromAlertTick(alert, { ...tick, metricQuality: undefined }))
            .toThrow('eligible price provenance');
        expect(() => candidateFromAlertTick(alert, {
            ...tick,
            metricQuality: { ...tick.metricQuality, price: { ...tick.metricQuality!.price!, stale: true } },
        })).toThrow('eligible price provenance');
    });
});

describe('alert input validation', () => {
    const validAlert = {
        tokenAddress: tick.tokenAddress,
        thresholdType: 'volume_5m',
        thresholdValue: '10000.25',
        condition: 'above',
        notificationType: 'discord',
    };

    it('normalizes an exact numeric string', () => {
        expect(alertCreateSchema.parse(validAlert).thresholdValue).toBe(10000.25);
    });

    it.each([
        { ...validAlert, thresholdValue: '10abc' },
        { ...validAlert, thresholdValue: 'Infinity' },
        { ...validAlert, thresholdValue: 0 },
        { ...validAlert, tokenAddress: 'not-a-solana-address' },
        { ...validAlert, thresholdType: 'holders' },
        { ...validAlert, unexpected: true },
    ])('rejects malformed create input %#', (input) => {
        expect(alertCreateSchema.safeParse(input).success).toBe(false);
    });

    it('requires a typed, non-empty update', () => {
        expect(alertUpdateSchema.safeParse({}).success).toBe(false);
        expect(alertUpdateSchema.safeParse({ isActive: 'true' }).success).toBe(false);
        expect(alertUpdateSchema.parse({ isActive: true })).toEqual({ isActive: true });
    });

    it('rejects candidates without a fenced generation and metric basis', () => {
        expect(alertCandidateSchema.safeParse({
            alertId: crypto.randomUUID(),
            userId: crypto.randomUUID(),
            tokenAddress: tick.tokenAddress,
            thresholdType: 'price',
            thresholdValue: 1,
            condition: 'above',
            currentValue: 2,
            notificationType: 'discord',
            signature: 'signature',
            sourceEventId: 'metric:event',
            observedAt: new Date().toISOString(),
            receivedAt: new Date().toISOString(),
            matchedAt: new Date().toISOString(),
            idempotencyKey: 'a'.repeat(64),
            engineVersion: 'test',
        }).success).toBe(false);
    });

    it('rejects notification jobs that cannot identify one durable alert event', () => {
        const job = {
            alertEventId: crypto.randomUUID(),
            alertId: crypto.randomUUID(),
            userId: crypto.randomUUID(),
            tokenAddress: tick.tokenAddress,
            currentValue: 2,
            notificationType: 'discord',
            idempotencyKey: 'b'.repeat(64),
            triggeredAt: new Date().toISOString(),
        };
        expect(alertNotificationJobSchema.safeParse(job).success).toBe(true);
        expect(alertNotificationJobSchema.safeParse({ ...job, alertEventId: 'not-an-event' }).success).toBe(false);
        expect(alertNotificationJobSchema.safeParse({ ...job, unexpected: true }).success).toBe(false);
    });
});
