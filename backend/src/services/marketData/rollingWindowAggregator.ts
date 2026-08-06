import { NormalizedMarketState, NormalizedTradeEvent } from '../../types';
import { stableHash } from './normalization';

export const ROLLING_WINDOWS_MS = {
    '1m': 60_000,
    '5m': 5 * 60_000,
    '1h': 60 * 60_000,
    '6h': 6 * 60 * 60_000,
    '24h': 24 * 60 * 60_000,
} as const;

export type RollingWindowName = keyof typeof ROLLING_WINDOWS_MS;

export interface RollingWindowMetrics {
    volumeUsd: Record<RollingWindowName, number>;
    buyCount: Record<RollingWindowName, number>;
    sellCount: Record<RollingWindowName, number>;
    txCount: Record<RollingWindowName, number>;
    uniqueBuyers: Record<RollingWindowName, number>;
    uniqueSellers: Record<RollingWindowName, number>;
    uniqueExact: Record<RollingWindowName, boolean>;
    uniqueErrorPct: Record<RollingWindowName, number>;
}

const emptyMetrics = (): RollingWindowMetrics => ({
    volumeUsd: { '1m': 0, '5m': 0, '1h': 0, '6h': 0, '24h': 0 },
    buyCount: { '1m': 0, '5m': 0, '1h': 0, '6h': 0, '24h': 0 },
    sellCount: { '1m': 0, '5m': 0, '1h': 0, '6h': 0, '24h': 0 },
    txCount: { '1m': 0, '5m': 0, '1h': 0, '6h': 0, '24h': 0 },
    uniqueBuyers: { '1m': 0, '5m': 0, '1h': 0, '6h': 0, '24h': 0 },
    uniqueSellers: { '1m': 0, '5m': 0, '1h': 0, '6h': 0, '24h': 0 },
    uniqueExact: { '1m': true, '5m': true, '1h': true, '6h': true, '24h': true },
    uniqueErrorPct: { '1m': 0, '5m': 0, '1h': 0, '6h': 0, '24h': 0 },
});

export const aggregateRollingWindows = (
    tokenMint: string,
    trades: NormalizedTradeEvent[],
    now = new Date()
): RollingWindowMetrics => {
    const metrics = emptyMetrics();
    const nowMs = now.getTime();

    for (const windowName of Object.keys(ROLLING_WINDOWS_MS) as RollingWindowName[]) {
        const minTime = nowMs - ROLLING_WINDOWS_MS[windowName];
        const buyers = new Set<string>();
        const sellers = new Set<string>();
        for (const trade of trades) {
            if (trade.tokenMint !== tokenMint) continue;
            const observedMs = new Date(trade.observedAt).getTime();
            if (!Number.isFinite(observedMs) || observedMs < minTime) continue;
            metrics.txCount[windowName] += 1;
            metrics.volumeUsd[windowName] += trade.usdAmount || 0;
            if (trade.side === 'buy') {
                metrics.buyCount[windowName] += 1;
                if (trade.maker) buyers.add(trade.maker);
            }
            if (trade.side === 'sell') {
                metrics.sellCount[windowName] += 1;
                if (trade.maker) sellers.add(trade.maker);
            }
        }
        metrics.uniqueBuyers[windowName] = buyers.size;
        metrics.uniqueSellers[windowName] = sellers.size;
    }

    return metrics;
};

export const rollingMetricsToMarketState = (
    base: NormalizedMarketState,
    metrics: RollingWindowMetrics
): NormalizedMarketState => ({
    ...base,
    idempotencyKey: stableHash([base.tokenMint, base.source, base.observedAt.slice(0, 19), 'rolling']),
    volumeUsd: metrics.volumeUsd,
    buyCount: metrics.buyCount,
    sellCount: metrics.sellCount,
    txCount: metrics.txCount,
    uniqueBuyers: metrics.uniqueBuyers,
    uniqueSellers: metrics.uniqueSellers,
    uniqueExact: metrics.uniqueExact,
    uniqueErrorPct: metrics.uniqueErrorPct,
});
