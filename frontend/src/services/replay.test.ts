import { describe, expect, it } from 'vitest';
import { amountOf, mergeCandles, supplyOf, type ReplayTrade } from './replay';

const trade = (overrides: Partial<ReplayTrade> = {}): ReplayTrade => ({
    kind: 'trade',
    idempotencyKey: 'trade-1',
    tokenMint: '3an8rhdepsLCya22af7qDBKPbdomw8K4iCHXaA2Gpump',
    observedAt: '2024-11-19T00:00:01.000Z',
    side: 'buy',
    priceUsd: 2,
    usdAmount: 10,
    ...overrides,
});

describe('historical replay projection', () => {
    it('aggregates ordered trades into deterministic interval candles', () => {
        const candles = mergeCandles([], [
            trade(),
            trade({ idempotencyKey: 'trade-2', observedAt: '2024-11-19T00:00:04.000Z', side: 'sell', priceUsd: 3, usdAmount: 20 }),
            trade({ idempotencyKey: 'trade-3', observedAt: '2024-11-19T00:00:06.000Z', priceUsd: 4, usdAmount: 30 }),
        ], 5);
        expect(candles).toEqual([
            expect.objectContaining({ open: 2, high: 3, low: 2, close: 3, volumeUsd: 30, buyCount: 1, sellCount: 1, txCount: 2 }),
            expect.objectContaining({ open: 4, close: 4, volumeUsd: 30, txCount: 1 }),
        ]);
    });

    it('derives exact display amounts only from bounded fixed-point inputs', () => {
        expect(amountOf(trade({ tokenAmountRaw: '2500000', tokenDecimals: 6 }))).toBe(2.5);
        expect(supplyOf(trade({ supply: { rawAmount: '1000000000000000', decimals: 6, fixed: true } }))).toBe(1_000_000_000);
        expect(supplyOf(trade({ supply: { rawAmount: '100', decimals: 0, fixed: false } }))).toBeUndefined();
    });
});
