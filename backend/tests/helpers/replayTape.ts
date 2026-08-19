import type { MetricReplay } from '../../src/services/marketData/metricReplay';
import type { NormalizedTradeEvent } from '../../src/types';

export const replayMint = 'YMN9Qj5jPNp7j14VPcML1B6xGgcPWVZUGLFU3Mnyfaf';
export const replaySha = '1'.repeat(64);

const trade = (index: number): NormalizedTradeEvent => ({
    kind: 'trade',
    source: 'old_faithful',
    sourceEventId: `source:${index}`,
    idempotencyKey: index.toString(16).padStart(64, '0'),
    tokenMint: replayMint,
    maker: `wallet-${index}`,
    side: index === 1 ? 'sell' : 'buy',
    priceSol: index + 1,
    slot: 42 + index,
    txIndex: 0,
    instructionIndex: 0,
    eventIndex: 0,
    observedAt: new Date(Date.UTC(2024, 10, 19, 0, 0, index * 10)).toISOString(),
    receivedAt: new Date(Date.UTC(2024, 10, 19, 0, 0, index * 10)).toISOString(),
    confidence: 1,
    stale: false,
});

export const replayTape = (count = 3): MetricReplay => {
    const sourceTrades = Array.from({ length: count }, (_, index) => trade(index));
    const priced = [0, 2].filter((index) => index < count).map((index) => ({
        ...sourceTrades[index],
        priceUsd: (index + 1) * 100,
        usdAmount: (index + 1) * 20,
        usdSourceEventId: `fx:${index}`,
    }));
    return {
        source: { mint: replayMint, trades: sourceTrades.length, replaySha256: replaySha },
        sourceTrades,
        trades: priced,
    } as unknown as MetricReplay;
};
