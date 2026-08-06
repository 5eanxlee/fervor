import { marketDb, type DbQuery } from '../../config/database';
import { FeedTick, NormalizedMarketState } from '../../types';
import { StoredRollup } from './rollingMetricBook';

export interface MetricEvent {
    eventKey: string;
    inputHash: string;
    tokenMint: string;
    sourceEventId: string;
    slot?: number;
    observedAt: string;
}

export interface MetricBase {
    rollup: StoredRollup;
    state: NormalizedMarketState | null;
    latestObservedAt: string | null;
    latestSlot: number | null;
    latestEventKey: string | null;
}

export interface MetricOutput {
    rollup: StoredRollup;
    state: NormalizedMarketState;
    tick: FeedTick;
    latestObservedAt: string;
    latestSlot: number | null;
    latestEventKey: string;
}

export interface StoredMetric {
    created: boolean;
    published: boolean;
    state: NormalizedMarketState;
    tick: FeedTick;
}

interface MetricRow {
    input_hash: string;
    state: NormalizedMarketState;
    observed_at: Date | string;
    usd_value: string | number;
    base_amount: string | null;
    swap_type: 'buy' | 'sell';
    published_at: Date | string | null;
}

const tickFromRow = (row: MetricRow): FeedTick => {
    const state = row.state;
    const observedAt = row.observed_at instanceof Date
        ? row.observed_at.toISOString()
        : new Date(row.observed_at).toISOString();
    return {
        tokenAddress: state.tokenMint,
        signature: state.signature || state.sourceEventId,
        slot: state.slot || 0,
        blockTime: Math.floor(Date.parse(observedAt) / 1000),
        price: state.priceUsd,
        marketCap: state.marketCapUsd,
        liquidity: state.liquidityUsd,
        volume: state.volumeUsd,
        buyCount: state.buyCount,
        sellCount: state.sellCount,
        txCount: state.txCount,
        usdValue: Number(row.usd_value),
        baseAmount: row.base_amount || undefined,
        swapType: row.swap_type,
        sourceExchange: state.protocol || state.observationSource,
        observationSource: state.observationSource,
        inputContract: state.inputContract,
        receivedAt: state.receivedAt,
        sourceEventId: state.sourceEventId,
        observedAt,
        priceObservedAt: state.priceObservedAt || state.observedAt,
        commitment: state.commitment,
        confidence: state.confidence,
        stale: state.stale,
        metricSource: state.metricSource,
        metricVersion: state.metricVersion,
        metricRevision: state.metricRevision,
        metricQuality: state.metricQuality,
    };
};

const eventFromRow = (row: MetricRow, inputHash: string): StoredMetric => {
    if (row.input_hash !== inputHash) throw new Error('Metric event identity changed its input');
    return {
        created: false,
        published: row.published_at !== null,
        state: row.state,
        tick: tickFromRow(row),
    };
};

export class MarketMetricRepository {
    async apply(
        event: MetricEvent,
        empty: StoredRollup,
        build: (base: MetricBase) => MetricOutput
    ): Promise<StoredMetric> {
        return marketDb.transaction(async (db) => {
            await db(
                `INSERT INTO market_metric_rollups (token_mint, rollup)
                 VALUES ($1, $2::jsonb)
                 ON CONFLICT (token_mint) DO NOTHING`,
                [event.tokenMint, JSON.stringify(empty)]
            );
            const locked = await db(
                `SELECT revision, rollup, latest_state, latest_observed_at, latest_slot, latest_event_key
                 FROM market_metric_rollups
                 WHERE token_mint = $1
                 FOR UPDATE`,
                [event.tokenMint]
            );
            const existing = await this.find(db, event.eventKey);
            if (existing) return eventFromRow(existing, event.inputHash);

            const row = locked.rows[0];
            if (!row) throw new Error('Metric rollup lock is unavailable');
            const priorRevision = Number(row.revision);
            if (Number(row.rollup?.revision) !== priorRevision) {
                throw new Error('Metric rollup revision is inconsistent');
            }
            const output = build({
                rollup: row.rollup as StoredRollup,
                state: row.latest_state as NormalizedMarketState | null,
                latestObservedAt: row.latest_observed_at?.toISOString?.() || row.latest_observed_at || null,
                latestSlot: row.latest_slot === null ? null : Number(row.latest_slot),
                latestEventKey: row.latest_event_key,
            });
            const revision = output.rollup.revision;
            if (revision !== priorRevision + 1) {
                throw new Error('Metric rollup revision must advance exactly once');
            }
            await db(
                `INSERT INTO market_metric_events
                 (event_key, input_hash, token_mint, source_event_id, slot, observed_at,
                  revision, state, usd_value, base_amount, swap_type)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11)`,
                [
                    event.eventKey,
                    event.inputHash,
                    event.tokenMint,
                    event.sourceEventId,
                    event.slot ?? null,
                    event.observedAt,
                    revision,
                    JSON.stringify(output.state),
                    output.tick.usdValue,
                    output.tick.baseAmount || null,
                    output.tick.swapType,
                ]
            );
            await db(
                `UPDATE market_metric_rollups
                 SET revision = $2,
                     rollup = $3::jsonb,
                     latest_state = $4::jsonb,
                     latest_observed_at = $5,
                     latest_slot = $6,
                     latest_event_key = $7,
                     updated_at = clock_timestamp()
                 WHERE token_mint = $1`,
                [
                    event.tokenMint,
                    revision,
                    JSON.stringify(output.rollup),
                    JSON.stringify(output.state),
                    output.latestObservedAt,
                    output.latestSlot,
                    output.latestEventKey,
                ]
            );
            return { created: true, published: false, state: output.state, tick: output.tick };
        });
    }

    async pending(limit = 250): Promise<Array<StoredMetric & { eventKey: string }>> {
        const result = await marketDb.query<MetricRow & { event_key: string }>(
            `SELECT event_key, input_hash, state, observed_at, usd_value,
                    base_amount::text, swap_type, published_at
             FROM market_metric_events
             WHERE published_at IS NULL
             ORDER BY committed_at
             LIMIT $1`,
            [limit]
        );
        return result.rows.map((row) => ({
            ...eventFromRow(row, row.input_hash),
            eventKey: row.event_key,
        }));
    }

    async markPublished(eventKey: string): Promise<void> {
        const result = await marketDb.query(
            `UPDATE market_metric_events
             SET published_at = COALESCE(published_at, clock_timestamp())
             WHERE event_key = $1`,
            [eventKey]
        );
        if (result.rowCount !== 1) throw new Error('Metric event disappeared before publication');
    }

    async prunePublished(cutoff: Date, limit = 5_000): Promise<number> {
        const result = await marketDb.query(
            `WITH victims AS (
               SELECT event_key
               FROM market_metric_events
               WHERE published_at IS NOT NULL AND committed_at < $1
               ORDER BY committed_at
               LIMIT $2
             )
             DELETE FROM market_metric_events event
             USING victims
             WHERE event.event_key = victims.event_key`,
            [cutoff.toISOString(), limit]
        );
        return result.rowCount || 0;
    }

    private async find(db: DbQuery, eventKey: string): Promise<MetricRow | null> {
        const result = await db(
            `SELECT input_hash, state, observed_at, usd_value,
                    base_amount::text, swap_type, published_at
             FROM market_metric_events
             WHERE event_key = $1`,
            [eventKey]
        );
        return result.rows[0] as MetricRow | undefined || null;
    }
}
