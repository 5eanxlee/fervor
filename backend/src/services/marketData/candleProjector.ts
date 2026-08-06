import { DbQuery, transaction } from '../../config/database';
import { NormalizedTradeEvent } from '../../types';
import { metrics } from '../metrics';

export const CANDLE_INTERVALS = {
    '1s': 1_000,
    '5s': 5_000,
    '15s': 15_000,
    '30s': 30_000,
    '1m': 60_000,
    '3m': 180_000,
    '5m': 300_000,
    '15m': 900_000,
    '1h': 3_600_000,
    '4h': 14_400_000,
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

const validNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

export const isCandleTrade = (event: unknown): event is NormalizedTradeEvent => {
    const trade = event as Partial<NormalizedTradeEvent> | undefined;
    if (!trade || trade.kind !== 'trade' || !trade.idempotencyKey || !trade.tokenMint || trade.stale) return false;
    if (!validNumber(trade.priceUsd) || trade.priceUsd <= 0) return false;
    if (trade.usdAmount !== undefined && (!validNumber(trade.usdAmount) || trade.usdAmount < 0)) return false;
    return Number.isFinite(Date.parse(String(trade.observedAt)));
};

const compareTrade = (left: NormalizedTradeEvent, right: NormalizedTradeEvent): number => {
    const time = Date.parse(left.observedAt) - Date.parse(right.observedAt);
    return time || left.idempotencyKey.localeCompare(right.idempotencyKey);
};

export const aggregateCandles = (events: NormalizedTradeEvent[]): CandleUpdate[] => {
    const buckets = new Map<string, { open: NormalizedTradeEvent; close: NormalizedTradeEvent; candle: CandleUpdate }>();

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
            if (compareTrade(event, existing.open) < 0) {
                existing.open = event;
                candle.openAt = event.observedAt;
                candle.openKey = event.idempotencyKey;
                candle.openUsd = event.priceUsd!;
            }
            if (compareTrade(event, existing.close) >= 0) {
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

const eventIdentity = (event: NormalizedTradeEvent): string => event.idempotencyKey;

const insertProjectionEvents = async (db: DbQuery, events: NormalizedTradeEvent[]): Promise<Set<string>> => {
    if (!events.length) return new Set();
    const values: unknown[] = [];
    const rows = events.map((event, index) => {
        const offset = index * 4;
        values.push(event.idempotencyKey, event.tokenMint, event.sourceEventId, event.observedAt);
        return `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4})`;
    });
    const result = await db(
        `INSERT INTO candle_projection_events (idempotency_key, token_mint, source_event_id, observed_at)
         VALUES ${rows.join(', ')} ON CONFLICT (idempotency_key) DO NOTHING RETURNING idempotency_key`,
        values
    );
    return new Set(result.rows.map((row) => String(row.idempotency_key)));
};

const upsertCandles = async (db: DbQuery, candles: CandleUpdate[]): Promise<void> => {
    if (!candles.length) return;
    const values: unknown[] = [];
    const rows = candles.map((candle, index) => {
        const offset = index * 17;
        values.push(
            candle.tokenMint, candle.poolAddress || null, candle.intervalName, candle.bucketStart,
            candle.openAt, candle.closeAt, candle.openKey, candle.closeKey,
            candle.openUsd, candle.highUsd, candle.lowUsd,
            candle.closeUsd, candle.volumeUsd, candle.buyCount, candle.sellCount, candle.txCount,
            candle.source
        );
        return `(${Array.from({ length: 17 }, (_, param) => `$${offset + param + 1}`).join(', ')})`;
    });
    await db(
        `INSERT INTO candles
         (token_mint, pool_address, interval_name, bucket_start, open_at, close_at, open_key, close_key, open_usd,
          high_usd, low_usd, close_usd, volume_usd, buy_count, sell_count, tx_count, source)
         VALUES ${rows.join(', ')}
         ON CONFLICT (token_mint, interval_name, bucket_start) DO UPDATE SET
           pool_address = CASE WHEN candles.close_at IS NULL
             OR (EXCLUDED.close_at, EXCLUDED.close_key) >= (candles.close_at, COALESCE(candles.close_key, ''))
             THEN EXCLUDED.pool_address ELSE candles.pool_address END,
           open_usd = CASE WHEN candles.open_at IS NULL
             OR (EXCLUDED.open_at, EXCLUDED.open_key) < (candles.open_at, COALESCE(candles.open_key, ''))
             THEN EXCLUDED.open_usd ELSE candles.open_usd END,
           open_key = CASE WHEN candles.open_at IS NULL
             OR (EXCLUDED.open_at, EXCLUDED.open_key) < (candles.open_at, COALESCE(candles.open_key, ''))
             THEN EXCLUDED.open_key ELSE candles.open_key END,
           open_at = LEAST(COALESCE(candles.open_at, EXCLUDED.open_at), EXCLUDED.open_at),
           high_usd = GREATEST(candles.high_usd, EXCLUDED.high_usd),
           low_usd = LEAST(candles.low_usd, EXCLUDED.low_usd),
           close_usd = CASE WHEN candles.close_at IS NULL
             OR (EXCLUDED.close_at, EXCLUDED.close_key) >= (candles.close_at, COALESCE(candles.close_key, ''))
             THEN EXCLUDED.close_usd ELSE candles.close_usd END,
           close_key = CASE WHEN candles.close_at IS NULL
             OR (EXCLUDED.close_at, EXCLUDED.close_key) >= (candles.close_at, COALESCE(candles.close_key, ''))
             THEN EXCLUDED.close_key ELSE candles.close_key END,
           close_at = GREATEST(COALESCE(candles.close_at, EXCLUDED.close_at), EXCLUDED.close_at),
           volume_usd = candles.volume_usd + EXCLUDED.volume_usd,
           buy_count = candles.buy_count + EXCLUDED.buy_count,
           sell_count = candles.sell_count + EXCLUDED.sell_count,
           tx_count = candles.tx_count + EXCLUDED.tx_count,
           source = EXCLUDED.source,
           updated_at = CURRENT_TIMESTAMP`,
        values
    );
};

const readCandles = async (db: DbQuery, wanted: CandleUpdate[]): Promise<CandleUpdate[]> => {
    if (!wanted.length) return [];
    const unique = Array.from(new Map(wanted.map((candle) => [
        `${candle.tokenMint}:${candle.intervalName}:${candle.bucketStart}`,
        candle,
    ])).values());
    const values: unknown[] = [];
    const rows = unique.map((candle, index) => {
        const offset = index * 3;
        values.push(candle.tokenMint, candle.intervalName, candle.bucketStart);
        return `($${offset + 1}::varchar, $${offset + 2}::varchar, $${offset + 3}::timestamp)`;
    });
    const result = await db(
        `WITH wanted(token_mint, interval_name, bucket_start) AS (VALUES ${rows.join(', ')})
         SELECT c.* FROM candles c JOIN wanted w USING (token_mint, interval_name, bucket_start)`,
        values
    );
    return result.rows.map((row) => ({
        tokenMint: String(row.token_mint),
        poolAddress: row.pool_address ? String(row.pool_address) : undefined,
        intervalName: row.interval_name as CandleInterval,
        bucketStart: new Date(row.bucket_start).toISOString(),
        openAt: new Date(row.open_at || row.bucket_start).toISOString(),
        closeAt: new Date(row.close_at || row.bucket_start).toISOString(),
        openKey: String(row.open_key || ''), closeKey: String(row.close_key || ''),
        openUsd: Number(row.open_usd), highUsd: Number(row.high_usd), lowUsd: Number(row.low_usd),
        closeUsd: Number(row.close_usd), volumeUsd: Number(row.volume_usd || 0),
        buyCount: Number(row.buy_count || 0), sellCount: Number(row.sell_count || 0),
        txCount: Number(row.tx_count || 0), source: 'trade_projection',
    }));
};

export class CandleProjector {
    async project(events: NormalizedTradeEvent[]): Promise<CandleUpdate[]> {
        const uniqueEvents = Array.from(new Map(
            events.filter(isCandleTrade).map((event) => [eventIdentity(event), event])
        ).values());
        if (!uniqueEvents.length) return [];
        const wanted = aggregateCandles(uniqueEvents);
        const done = metrics.timer('fervor_candle_project_ms');
        try {
            const result = await transaction(async (db) => {
                const accepted = await insertProjectionEvents(db, uniqueEvents);
                const contributions = aggregateCandles(uniqueEvents.filter((event) => accepted.has(eventIdentity(event))));
                await upsertCandles(db, contributions);
                return readCandles(db, wanted);
            });
            metrics.increment('fervor_candles_projected', undefined, result.length);
            return result;
        } finally {
            done();
        }
    }
}
