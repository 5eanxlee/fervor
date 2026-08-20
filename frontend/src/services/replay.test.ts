import { describe, expect, it } from 'vitest';
import {
    advanceReplayParticipants,
    amountOf,
    chartPriceOf,
    mergeCandles,
    isReplayParticipants,
    replayTickDelay,
    stabilizeReplayPrices,
    supplyOf,
    volumePrice,
    type ReplayTrade,
    type ReplayParticipants,
} from './replay';

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

    it('uses verified spot prices and fills short inactive intervals', () => {
        const candles = mergeCandles([], [
            trade({ chartPriceUsd: 2.1, priceUsd: 8 }),
            trade({ idempotencyKey: 'trade-2', observedAt: '2024-11-19T00:00:04.000Z', chartPriceUsd: 3.1, priceUsd: 12 }),
        ], 1);

        expect(chartPriceOf(trade({ chartPriceUsd: 2.1, priceUsd: 8 }))).toBe(2.1);
        expect(candles.map((candle) => [candle.timestamp, candle.close, candle.txCount])).toEqual([
            [Date.parse('2024-11-19T00:00:01.000Z'), 2.1, 1],
            [Date.parse('2024-11-19T00:00:02.000Z'), 2.1, 0],
            [Date.parse('2024-11-19T00:00:03.000Z'), 2.1, 0],
            [Date.parse('2024-11-19T00:00:04.000Z'), 3.1, 1],
        ]);
    });

    it('derives exact display amounts only from bounded fixed-point inputs', () => {
        expect(amountOf(trade({ tokenAmountRaw: '2500000', tokenDecimals: 6 }))).toBe(2.5);
        expect(supplyOf(trade({ supply: { rawAmount: '1000000000000000', decimals: 6, fixed: true } }))).toBe(1_000_000_000);
        expect(supplyOf(trade({ supply: { rawAmount: '100', decimals: 0, fixed: false } }))).toBeUndefined();
    });

    it('accelerates visual ticks for denser and higher-volume bursts', () => {
        expect(replayTickDelay(12, 100)).toBeLessThan(replayTickDelay(2, 100));
        expect(replayTickDelay(4, 10_000)).toBeLessThan(replayTickDelay(4, 1));
        expect(replayTickDelay(1, 1, true)).toBe(16);
    });

    it('dampens dust-price outliers while preserving liquid and verified moves', () => {
        expect(volumePrice(2, 2.2, 1)).toBe(2.2);
        expect(volumePrice(2, 20, 1)).toBeLessThan(2.2);
        expect(volumePrice(2, 20, 10_000)).toBeGreaterThan(19.8);

        const stabilized = stabilizeReplayPrices([
            trade({ priceUsd: 2, usdAmount: 100 }),
            trade({ idempotencyKey: 'dust', priceUsd: 20, usdAmount: 1 }),
            trade({ idempotencyKey: 'verified', chartPriceUsd: 4, chartPriceSource: 'curve_spot', usdAmount: 1 }),
        ], 2);
        expect(chartPriceOf(stabilized[1])).toBeLessThan(2.2);
        expect(chartPriceOf(stabilized[2])).toBe(4);
        expect(stabilized[1].priceUsd).toBe(20);
    });

    it('advances holder balances and trader rankings at exact replay cursors', () => {
        const maker = '7Zb1d7t2S9Bkv8G6gPKZQdgs7Qk1HSA1xY5g7uEczwzE';
        const base: ReplayParticipants = {
            contract: 'fervor-replay-participants-v1',
            sourceReplaySha256: 'a'.repeat(64),
            runId: 'run',
            epoch: 1,
            cutCursor: 0,
            cutAt: null,
            tokenMint: trade().tokenMint,
            tokenDecimals: 0,
            supplyRaw: '1000',
            traderCount: 0,
            holderCount: 0,
            top10Percent: 0,
            coverage: {
                source: 'verified_trade_tape',
                scope: 'observed_trade_balance',
                openingBalanceKnown: false,
                transfersIncluded: false,
                tradeCount: 0,
                pricedTradeCount: 0,
                priceCoverageBps: 0,
            },
            items: [],
        };
        expect(isReplayParticipants(base)).toBe(true);
        const next = advanceReplayParticipants(base, [
            trade({ maker, tokenAmountRaw: '100', tokenDecimals: 0, replayCursor: 0, usdAmount: 20 }),
            trade({ maker, side: 'sell', tokenAmountRaw: '40', tokenDecimals: 0, replayCursor: 1, usdAmount: 12 }),
        ]);
        expect(next).toMatchObject({
            cutCursor: 2,
            traderCount: 1,
            holderCount: 1,
            top10Percent: 6,
            coverage: { tradeCount: 2, pricedTradeCount: 2, priceCoverageBps: 10_000 },
            items: [{
                wallet: maker,
                boughtRaw: '100',
                soldRaw: '40',
                balanceRaw: '60',
                tradeCount: 2,
            }],
        });
        expect(advanceReplayParticipants(base, [trade({
            maker,
            tokenAmountRaw: '1',
            tokenDecimals: 0,
            replayCursor: 2,
        })])).toBeUndefined();
    });
});
