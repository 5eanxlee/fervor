import { describe, expect, it } from 'vitest';
import { aggregateCandles, CANDLE_INTERVALS, isCandleTrade } from '../src/services/marketData/candleEngine';
import { NormalizedTradeEvent } from '../src/types';

const trade = (input: Partial<NormalizedTradeEvent> = {}): NormalizedTradeEvent => ({
    kind: 'trade',
    idempotencyKey: input.idempotencyKey || 'trade-1',
    tokenMint: input.tokenMint || 'TokenMint111111111111111111111111111111111',
    side: input.side || 'buy',
    priceUsd: input.priceUsd ?? 1,
    usdAmount: input.usdAmount ?? 10,
    source: 'helius_laserstream',
    sourceEventId: input.sourceEventId || input.idempotencyKey || 'source-1',
    observedAt: input.observedAt || '2026-08-03T12:00:01.000Z',
    receivedAt: input.receivedAt || '2026-08-03T12:00:01.010Z',
    confidence: 1,
    stale: false,
    ...input,
});

describe('candle projection', () => {
    it('builds every interval with deterministic OHLCV values', () => {
        const candles = aggregateCandles([
            trade({ idempotencyKey: 'late', observedAt: '2026-08-03T12:00:04.000Z', priceUsd: 2, usdAmount: 20, side: 'sell' }),
            trade({ idempotencyKey: 'early', observedAt: '2026-08-03T12:00:01.000Z', priceUsd: 1, usdAmount: 10, side: 'buy' }),
            trade({ idempotencyKey: 'high', observedAt: '2026-08-03T12:00:03.000Z', priceUsd: 3, usdAmount: 30, side: 'buy' }),
        ]);
        expect(new Set(candles.map((candle) => candle.intervalName)).size).toBe(Object.keys(CANDLE_INTERVALS).length);
        const oneMinute = candles.find((candle) => candle.intervalName === '1m');
        expect(oneMinute).toMatchObject({
            bucketStart: '2026-08-03T12:00:00.000Z', openUsd: 1, highUsd: 3,
            lowUsd: 1, closeUsd: 2, volumeUsd: 60, buyCount: 2, sellCount: 1, txCount: 3,
        });
    });

    it('rejects malformed and non-price events', () => {
        expect(isCandleTrade(trade())).toBe(true);
        expect(isCandleTrade({ ...trade(), priceUsd: 0 })).toBe(false);
        expect(isCandleTrade({ ...trade(), observedAt: 'invalid' })).toBe(false);
        expect(isCandleTrade({ ...trade(), stale: true })).toBe(false);
        expect(isCandleTrade({ kind: 'market_state' })).toBe(false);
    });

    it('uses chain position to order equal-time closes', () => {
        const candles = aggregateCandles([
            trade({ idempotencyKey: 'a', priceUsd: 2, slot: 42, txIndex: 1, instructionIndex: 0, eventIndex: 0 }),
            trade({ idempotencyKey: 'z', priceUsd: 1, slot: 42, txIndex: 0, instructionIndex: 0, eventIndex: 0 }),
        ]);
        expect(candles.find((candle) => candle.intervalName === '1s')).toMatchObject({
            closeUsd: 2,
            closeKey: 'a',
            openKey: 'z',
        });
    });
});
