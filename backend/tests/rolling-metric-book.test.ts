import { describe, expect, it } from 'vitest';
import type { NormalizedTradeEvent } from '../src/types';
import { Cardinality } from '../src/services/marketData/cardinality';
import { RollingMetricBook } from '../src/services/marketData/rollingMetricBook';

const nowMs = Date.parse('2026-08-03T12:00:00.000Z');

const trade = (offsetMs: number, side: 'buy' | 'sell', maker: string, usdAmount = 10): NormalizedTradeEvent => ({
    kind: 'trade',
    idempotencyKey: `${offsetMs}:${side}:${maker}`,
    tokenMint: 'token-a',
    maker,
    side,
    usdAmount,
    priceUsd: 1,
    source: 'helius_laserstream',
    sourceEventId: `${offsetMs}:${side}:${maker}`,
    observedAt: new Date(nowMs + offsetMs).toISOString(),
    receivedAt: new Date(nowMs).toISOString(),
    confidence: 1,
    stale: false,
});

describe('RollingMetricBook', () => {
    it('keeps exact counts and unique wallets across hierarchical buckets', () => {
        const book = new RollingMetricBook('token-a');
        expect(book.add(trade(-10_000, 'buy', 'wallet-a'), nowMs)).toBe(true);
        expect(book.add(trade(-20_000, 'buy', 'wallet-a'), nowMs)).toBe(true);
        expect(book.add(trade(-120_000, 'sell', 'wallet-b', 25), nowMs)).toBe(true);

        const metrics = book.metrics(nowMs);
        expect(metrics.volumeUsd['1m']).toBe(20);
        expect(metrics.volumeUsd['5m']).toBe(45);
        expect(metrics.buyCount['1m']).toBe(2);
        expect(metrics.sellCount['5m']).toBe(1);
        expect(metrics.uniqueBuyers['1m']).toBe(1);
        expect(metrics.uniqueSellers['5m']).toBe(1);
    });

    it('survives snapshot hydration without retaining raw trades', () => {
        const book = new RollingMetricBook('token-a');
        book.add(trade(-1_000, 'buy', 'wallet-a', 42), nowMs);
        const restored = RollingMetricBook.hydrate(JSON.parse(JSON.stringify(book.serialize())));

        expect(restored.metrics(nowMs)).toEqual(book.metrics(nowMs));
        expect(JSON.stringify(restored.serialize())).not.toContain('idempotencyKey');
    });

    it('rejects future and expired observations', () => {
        const book = new RollingMetricBook('token-a');
        expect(book.add(trade(31_000, 'buy', 'wallet-a'), nowMs)).toBe(false);
        expect(book.add(trade(-(24 * 60 * 60 * 1000 + 1), 'buy', 'wallet-a'), nowMs)).toBe(false);
        expect(book.metrics(nowMs).txCount['24h']).toBe(0);
    });

    it('uses fixed-point volume and bounded cardinality sketches', () => {
        const book = new RollingMetricBook('token-a');
        book.add(trade(-1_000, 'buy', 'wallet-a', 0.1), nowMs);
        book.add(trade(-2_000, 'buy', 'wallet-b', 0.2), nowMs);
        for (let index = 0; index < 200; index += 1) {
            book.add(trade(-3_000, 'buy', `hot-wallet-${index}`, 1), nowMs);
        }

        const metrics = book.metrics(nowMs);
        expect(metrics.volumeUsd['1m']).toBe(200.3);
        expect(metrics.uniqueExact['1m']).toBe(false);
        expect(metrics.uniqueErrorPct['1m']).toBeGreaterThan(0);
        expect(metrics.uniqueBuyers['1m']).toBeGreaterThan(150);
        expect(metrics.uniqueBuyers['1m']).toBeLessThan(250);
        expect(JSON.stringify(book.serialize())).not.toContain('hot-wallet-199');

        const stored = JSON.parse(JSON.stringify(book.serialize()));
        const restored = RollingMetricBook.hydrate(stored);
        expect(restored.serialize()).toEqual(stored);
        expect(restored.metrics(nowMs)).toEqual(metrics);
    });

    it('upgrades legacy snapshots without losing volume or unique counts', () => {
        const legacy = {
            version: 1 as const,
            revision: 1,
            tokenMint: 'token-a',
            windows: Object.fromEntries(
                ['1m', '5m', '1h', '6h', '24h'].map((name) => [name, [{
                    startMs: nowMs - 5_000,
                    volumeUsd: 12.5,
                    buyCount: 1,
                    sellCount: 0,
                    txCount: 1,
                    buyers: ['wallet-a'],
                    sellers: [],
                }]])
            ),
        } as any;
        const restored = RollingMetricBook.hydrate(legacy);
        expect(restored.metrics(nowMs).volumeUsd['1m']).toBe(12.5);
        expect(restored.metrics(nowMs).uniqueBuyers['24h']).toBe(1);
        expect(restored.serialize().version).toBe(2);

        const corrupt = JSON.parse(JSON.stringify(legacy));
        corrupt.windows['1m'][0].volumeUsd = '12.5';
        expect(() => RollingMetricBook.hydrate(corrupt)).toThrow();
    });

    it('rejects corrupt snapshots instead of silently dropping state', () => {
        const book = new RollingMetricBook('token-a');
        book.add(trade(-1_000, 'buy', 'wallet-a', 42), nowMs);
        book.add(trade(-1_000, 'buy', 'wallet-b', 42), nowMs);
        const stored = book.serialize();
        const corrupt = (change: (value: any) => void): any => {
            const value = JSON.parse(JSON.stringify(stored));
            change(value);
            return value;
        };

        expect(() => RollingMetricBook.hydrate(corrupt((value) => { value.revision = -1; })))
            .toThrow();
        expect(() => RollingMetricBook.hydrate(corrupt((value) => { delete value.windows['1m']; })))
            .toThrow();
        expect(() => RollingMetricBook.hydrate(corrupt((value) => { value.ignored = true; })))
            .toThrow();
        expect(() => RollingMetricBook.hydrate(corrupt((value) => {
            value.windows['1m'][0].startMs += 1;
        }))).toThrow();
        expect(() => RollingMetricBook.hydrate(corrupt((value) => {
            value.windows['1m'][0].buyers.values.reverse();
        }))).toThrow();
        const invalidSketch = Buffer.alloc(128, 255).toString('base64');
        expect(() => new Cardinality({ mode: 'hll', data: invalidSketch })).toThrow();
        expect(() => RollingMetricBook.hydrate(corrupt((value) => {
            value.windows['1m'][0].buyers = {
                mode: 'hll',
                data: invalidSketch,
            };
        }))).toThrow();
        expect(() => RollingMetricBook.hydrate(corrupt((value) => {
            value.revision = 65;
            value.windows['1m'][0].buyCount = 65;
            value.windows['1m'][0].txCount = 65;
            value.windows['1m'][0].buyers = {
                mode: 'hll',
                data: Buffer.alloc(128).toString('base64'),
            };
        }))).toThrow();
    });
});
