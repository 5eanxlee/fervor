import { DbQuery, transaction } from '../../config/database';
import { NormalizedTradeEvent } from '../../types';
import { metrics } from '../metrics';
import { aggregateCandles, CandleInterval, CandleUpdate, isCandleTrade } from './candleEngine';

export { aggregateCandles, CANDLE_INTERVALS, CandleInterval, CandleUpdate, isCandleTrade } from './candleEngine';

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
