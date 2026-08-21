import { NormalizedTradeEvent } from '../../types';
import { tradeOrder } from './tradeOrder';

export const CANDLE_INTERVALS = {
    '1s': 1_000,
    '5s': 5_000,
    '15s': 15_000,
    '30s': 30_000,
    '1m': 60_000,
    '3m': 180_000,
    '5m': 300_000,
    '15m': 900_000,
    '30m': 1_800_000,
    '1h': 3_600_000,
    '4h': 14_400_000,
    '6h': 21_600_000,
    '12h': 43_200_000,
    '24h': 86_400_000,
    '1d': 86_400_000,
} as const;

export type CandleInterval = keyof typeof CANDLE_INTERVALS;

export interface CandleUpdate {
    tokenMint: string;
    poolAddress?: string;
    intervalName: CandleInterval;
    bucketStart: string;
    openAt: string;
    closeAt: string;
    openKey: string;
    closeKey: string;
    openUsd: number;
    highUsd: number;
    lowUsd: number;
    closeUsd: number;
    volumeUsd: number;
    buyCount: number;
    sellCount: number;
    txCount: number;
    source: 'trade_projection';
}

const validNumber = (value: unknown): value is number =>
    typeof value === 'number' && Number.isFinite(value);

export const isCandleTrade = (event: unknown): event is NormalizedTradeEvent => {
    const trade = event as Partial<NormalizedTradeEvent> | undefined;
    if (!trade || trade.kind !== 'trade' || !trade.idempotencyKey || !trade.tokenMint || trade.stale) return false;
    if (!validNumber(trade.priceUsd) || trade.priceUsd <= 0) return false;
    if (trade.usdAmount !== undefined && (!validNumber(trade.usdAmount) || trade.usdAmount < 0)) return false;
    return Number.isFinite(Date.parse(String(trade.observedAt)));
};

export const aggregateCandles = (events: NormalizedTradeEvent[]): CandleUpdate[] => {
    const buckets = new Map<string, {
        open: NormalizedTradeEvent;
        close: NormalizedTradeEvent;
        candle: CandleUpdate;
    }>();

    for (const event of events) {
        if (!isCandleTrade(event)) continue;
        const observedMs = Date.parse(event.observedAt);
        for (const [intervalName, durationMs] of Object.entries(CANDLE_INTERVALS) as Array<[CandleInterval, number]>) {
            const bucketStart = new Date(Math.floor(observedMs / durationMs) * durationMs).toISOString();
            const key = `${event.tokenMint}:${intervalName}:${bucketStart}`;
            const existing = buckets.get(key);
            if (!existing) {
                buckets.set(key, {
                    open: event,
                    close: event,
                    candle: {
                        tokenMint: event.tokenMint,
                        poolAddress: event.poolAddress,
                        intervalName,
                        bucketStart,
                        openAt: event.observedAt,
                        closeAt: event.observedAt,
                        openKey: event.idempotencyKey,
                        closeKey: event.idempotencyKey,
                        openUsd: event.priceUsd!,
                        highUsd: event.priceUsd!,
                        lowUsd: event.priceUsd!,
                        closeUsd: event.priceUsd!,
                        volumeUsd: event.usdAmount || 0,
                        buyCount: event.side === 'buy' ? 1 : 0,
                        sellCount: event.side === 'sell' ? 1 : 0,
                        txCount: 1,
                        source: 'trade_projection',
                    },
                });
                continue;
            }

            const candle = existing.candle;
            candle.highUsd = Math.max(candle.highUsd, event.priceUsd!);
            candle.lowUsd = Math.min(candle.lowUsd, event.priceUsd!);
            candle.volumeUsd += event.usdAmount || 0;
            candle.buyCount += event.side === 'buy' ? 1 : 0;
            candle.sellCount += event.side === 'sell' ? 1 : 0;
            candle.txCount += 1;
            if (tradeOrder(event, existing.open) < 0) {
                existing.open = event;
                candle.openAt = event.observedAt;
                candle.openKey = event.idempotencyKey;
                candle.openUsd = event.priceUsd!;
            }
            if (tradeOrder(event, existing.close) >= 0) {
                existing.close = event;
                candle.closeAt = event.observedAt;
                candle.closeKey = event.idempotencyKey;
                candle.closeUsd = event.priceUsd!;
                candle.poolAddress = event.poolAddress || candle.poolAddress;
            }
        }
    }

    return Array.from(buckets.values(), ({ candle }) => candle)
        .sort((left, right) => left.bucketStart.localeCompare(right.bucketStart)
            || left.tokenMint.localeCompare(right.tokenMint)
            || left.intervalName.localeCompare(right.intervalName));
};
