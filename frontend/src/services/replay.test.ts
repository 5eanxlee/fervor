import { describe, expect, it } from 'vitest';
import {
    advanceReplayParticipants,
    amountOf,
    chartPriceOf,
    mergeCandles,
    isReplayParticipants,
    replayClockAt,
    replayParticipantStats,
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
            expect.objectContaining({ open: 3, high: 4, low: 3, close: 4, volumeUsd: 30, txCount: 1 }),
        ]);
    });

    it('uses verified spot prices without synthesizing inactive intervals', () => {
        const candles = mergeCandles([], [
            trade({ chartPriceUsd: 2.1, priceUsd: 8 }),
            trade({ idempotencyKey: 'trade-2', observedAt: '2024-11-19T00:00:04.000Z', chartPriceUsd: 3.1, priceUsd: 12 }),
        ], 1);

        expect(chartPriceOf(trade({ chartPriceUsd: 2.1, priceUsd: 8 }))).toBe(2.1);
        expect(candles.map((candle) => [candle.timestamp, candle.close, candle.txCount])).toEqual([
            [Date.parse('2024-11-19T00:00:01.000Z'), 2.1, 1],
            [Date.parse('2024-11-19T00:00:04.000Z'), 3.1, 1],
        ]);
        expect(candles[1]).toMatchObject({ open: 2.1, high: 3.1, low: 2.1 });
    });

    it('charts verified FX display fields from the first trade on the replay timeline', () => {
        const candles = mergeCandles([], [
            trade({
                priceUsd: undefined,
                usdAmount: undefined,
                chartPriceUsd: 2.5,
                chartUsdAmount: 7,
                replayAt: '2024-11-19T00:00:01.000Z',
            }),
            trade({
                idempotencyKey: 'trade-2',
                observedAt: '2024-11-19T00:03:54.000Z',
                replayAt: '2024-11-19T00:00:02.000Z',
                chartPriceUsd: 3,
                usdAmount: undefined,
                chartUsdAmount: 11,
            }),
        ], 1);

        expect(candles).toEqual([
            expect.objectContaining({ timestamp: Date.parse('2024-11-19T00:00:01.000Z'), close: 2.5, volumeUsd: 7 }),
            expect.objectContaining({ timestamp: Date.parse('2024-11-19T00:00:02.000Z'), close: 3, volumeUsd: 11 }),
        ]);
    });

    it('derives exact display amounts only from bounded fixed-point inputs', () => {
        expect(amountOf(trade({ tokenAmountRaw: '2500000', tokenDecimals: 6 }))).toBe(2.5);
        expect(supplyOf(trade({ supply: { rawAmount: '1000000000000000', decimals: 6, fixed: true } }))).toBe(1_000_000_000);
        expect(supplyOf(trade({ supply: { rawAmount: '100', decimals: 0, fixed: false } }))).toBeUndefined();
    });

    it('keeps long one-second pauses sparse', () => {
        const candles = mergeCandles([], [
            trade(),
            trade({ idempotencyKey: 'trade-2', observedAt: '2024-11-19T00:50:01.000Z', priceUsd: 3 }),
        ], 1, 2_000);

        expect(candles).toHaveLength(2);
        expect(candles[0].timestamp).toBe(Date.parse('2024-11-19T00:00:01.000Z'));
        expect(candles.at(-1)).toMatchObject({
            timestamp: Date.parse('2024-11-19T00:50:01.000Z'),
            open: 2,
            high: 3,
            low: 2,
            close: 3,
            txCount: 1,
        });
    });

    it('does not advance candles without a trade', () => {
        const base = mergeCandles([], [trade()], 1);
        expect(mergeCandles(base, [], 1)).toBe(base);
    });

    it('incrementally appends an ordered tail without changing candle semantics', () => {
        const items = [
            trade(),
            trade({ idempotencyKey: 'trade-2', observedAt: '2024-11-19T00:00:01.400Z', side: 'sell', priceUsd: 1.5 }),
            trade({ idempotencyKey: 'trade-3', observedAt: '2024-11-19T00:00:04.000Z', priceUsd: 3 }),
        ];
        const incremental = items.reduce<ReturnType<typeof mergeCandles>>(
            (candles, item) => mergeCandles(candles, [item], 1),
            []
        );
        expect(incremental).toEqual(mergeCandles([], items, 1));
        expect(incremental.at(-1)).toMatchObject({ open: 1.5, high: 3, low: 1.5, close: 3 });
    });

    it('removes legacy zero-trade candles from an existing series', () => {
        const base = mergeCandles([], [trade()], 1);
        const empty = { ...base[0], timestamp: base[0].timestamp + 1_000, txCount: 0, volumeUsd: 0 };
        expect(mergeCandles([...base, empty], [], 1)).toEqual(base);
    });

    it.each([1, 5, 15, 30, 60, 300, 3_600])('keeps %s-second candles sparse and vertically continuous', (interval) => {
        const start = Date.parse('2024-11-19T00:00:00.000Z');
        const candles = mergeCandles([], [
            trade({ observedAt: new Date(start + 1_000).toISOString(), priceUsd: 2 }),
            trade({
                idempotencyKey: 'trade-2',
                observedAt: new Date(start + interval * 3_000 + 1_000).toISOString(),
                priceUsd: 4,
            }),
        ], interval);

        expect(candles).toHaveLength(2);
        expect(candles[1]).toMatchObject({ open: 2, high: 4, low: 2, close: 4 });
    });

    it('projects a bounded replay clock between canonical trades', () => {
        const cut = {
            now: '2024-11-19T00:00:01.000Z',
            nextAt: '2024-11-19T00:00:04.000Z',
            status: 'running' as const,
        };
        expect(replayClockAt(cut, 1, 1_500)).toBe(Date.parse('2024-11-19T00:00:02.500Z'));
        expect(replayClockAt(cut, 1, 5_000)).toBe(Date.parse(cut.nextAt));
        expect(replayClockAt({ ...cut, status: 'paused' }, 20, 1_000)).toBe(Date.parse(cut.now));
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
            trade({ maker, tokenAmountRaw: '100', tokenDecimals: 0, replayCursor: 0, usdAmount: undefined, chartUsdAmount: 20 }),
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
                pricedBuyRaw: '100',
                boughtUsd: 20,
                tradeCount: 2,
            }],
        });
        expect(next).toBeDefined();
        if (!next) throw new Error('Expected replay participants');
        expect(advanceReplayParticipants(base, [trade({
            maker,
            tokenAmountRaw: '1',
            tokenDecimals: 0,
            replayCursor: 2,
        })])).toBeUndefined();

        const stats = replayParticipantStats(next.items[0], next, 3);
        expect(stats).toMatchObject({
            boughtTokens: 100,
            soldTokens: 40,
            remainingTokens: 60,
            avgBuyPriceUsd: 0.2,
            avgSellPriceUsd: 0.3,
            avgBuyMcapUsd: 200,
            avgSellMcapUsd: 300,
            currentValueUsd: 180,
            unrealizedPnlUsd: 168,
            realizedPnlUsd: 4,
            remainingPercent: 6,
            heldSeconds: 0,
            lastActiveSeconds: 0,
        });
    });
});
