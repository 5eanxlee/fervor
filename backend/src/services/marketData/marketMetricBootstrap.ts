import { coreDb, marketDb, type Database } from '../../config/database';
import { env } from '../../config/env';
import { NormalizedTradeEvent, safeSlot } from '../../types';
import type { MarketDataProviderName } from '../../types';
import { MarketMetricService } from './marketMetricService';

interface Lease {
    token: string;
    horizonStart: string;
    cutoffAt: string;
    cursorAt?: string;
    cursorKey?: string;
}

const iso = (value: unknown): string => value instanceof Date
    ? value.toISOString()
    : new Date(String(value)).toISOString();

const tradeFromRow = (row: Record<string, any>): NormalizedTradeEvent => ({
    kind: 'trade',
    idempotencyKey: String(row.idempotency_key),
    tokenMint: String(row.token_mint),
    poolAddress: row.pool_address || undefined,
    protocol: row.protocol || undefined,
    maker: row.maker || undefined,
    side: row.side,
    tokenAmount: row.token_amount === null ? undefined : Number(row.token_amount),
    quoteMint: row.quote_mint || undefined,
    quoteAmount: row.quote_amount === null ? undefined : Number(row.quote_amount),
    tokenAmountRaw: row.token_amount_raw === null ? undefined : String(row.token_amount_raw),
    quoteAmountRaw: row.quote_amount_raw === null ? undefined : String(row.quote_amount_raw),
    tokenDecimals: row.token_decimals === null ? undefined : Number(row.token_decimals),
    quoteDecimals: row.quote_decimals === null ? undefined : Number(row.quote_decimals),
    solAmount: row.sol_amount === null ? undefined : Number(row.sol_amount),
    usdAmount: Number(row.usd_amount),
    priceSol: row.price_sol === null ? undefined : Number(row.price_sol),
    priceUsd: Number(row.price_usd),
    signature: row.signature || undefined,
    slot: safeSlot(row.slot),
    instructionIndex: Number(row.instruction_index || 0),
    eventIndex: Number(row.event_index || 0),
    programId: row.program_id || undefined,
    route: Array.isArray(row.route) ? row.route : undefined,
    quoteKind: row.quote_kind || undefined,
    decodeVersion: row.decode_version || undefined,
    computeUnits: row.compute_units === null ? undefined : Number(row.compute_units),
    source: String(row.source) as MarketDataProviderName,
    sourceEventId: String(row.source_event_id),
    observedAt: iso(row.observed_at),
    receivedAt: iso(row.received_at),
    confidence: Number(row.confidence),
    stale: Boolean(row.stale),
});

export class MarketMetricBootstrap {
    constructor(
        private readonly projector: MarketMetricService,
        private readonly owner = `metric-bootstrap-${process.pid}`,
        private readonly core: Pick<Database, 'query'> = coreDb,
        private readonly market: Pick<Database, 'query'> = marketDb
    ) {}

    async run(): Promise<void> {
        while (!(await this.complete())) {
            const lease = await this.claim();
            if (!lease) {
                await new Promise((resolve) => setTimeout(resolve, 1_000));
                continue;
            }
            await this.replay(lease);
        }
    }

    private async replay(lease: Lease): Promise<void> {
        let cursorAt = lease.cursorAt;
        let cursorKey = lease.cursorKey;
        while (true) {
            const rows = await this.core.query(
                `SELECT * FROM trades
                 WHERE observed_at > $1 AND observed_at <= $2
                   AND ($3::timestamptz IS NULL OR (observed_at, idempotency_key) > ($3, $4))
                   AND idempotency_key ~ '^[0-9a-f]{64}$'
                   AND side IN ('buy', 'sell')
                   AND price_usd > 0 AND usd_amount > 0
                   AND confidence BETWEEN 0 AND 1 AND stale = FALSE
                 ORDER BY observed_at, idempotency_key
                 LIMIT $5`,
                [lease.horizonStart, lease.cutoffAt, cursorAt || null, cursorKey || null,
                    env.MARKET_METRIC_BOOTSTRAP_BATCH]
            );
            for (const row of rows.rows) {
                await this.projector.project(
                    tradeFromRow(row),
                    {
                        nowMs: Date.parse(lease.cutoffAt),
                        publish: false,
                        loadInputs: false,
                    }
                );
            }
            if (rows.rows.length === 0) {
                await this.checkpoint(lease.token, cursorAt, cursorKey, true);
                return;
            }
            const last = rows.rows[rows.rows.length - 1];
            cursorAt = iso(last.observed_at);
            cursorKey = String(last.idempotency_key);
            await this.checkpoint(lease.token, cursorAt, cursorKey, false);
        }
    }

    private async complete(): Promise<boolean> {
        const result = await this.market.query(
            'SELECT status FROM market_metric_bootstrap WHERE id = 1'
        );
        return result.rows[0]?.status === 'complete';
    }

    private async claim(): Promise<Lease | null> {
        const result = await this.market.query(
            `UPDATE market_metric_bootstrap
             SET status = 'running', lease_token = gen_random_uuid(), lease_owner = $1,
                 lease_until = clock_timestamp() + ($2::text || ' milliseconds')::interval,
                 updated_at = clock_timestamp()
             WHERE id = 1 AND status <> 'complete'
               AND (status = 'pending' OR lease_until <= clock_timestamp() OR lease_owner = $1)
             RETURNING lease_token::text, horizon_start, cutoff_at, cursor_at, cursor_key`,
            [this.owner, env.MARKET_METRIC_BOOTSTRAP_LEASE_MS]
        );
        const row = result.rows[0];
        return row ? {
            token: String(row.lease_token),
            horizonStart: iso(row.horizon_start),
            cutoffAt: iso(row.cutoff_at),
            cursorAt: row.cursor_at ? iso(row.cursor_at) : undefined,
            cursorKey: row.cursor_key || undefined,
        } : null;
    }

    private async checkpoint(
        token: string,
        cursorAt?: string,
        cursorKey?: string,
        complete = false
    ): Promise<void> {
        const result = await this.market.query(
            `UPDATE market_metric_bootstrap
             SET status = CASE WHEN $4 THEN 'complete' ELSE 'running' END,
                 cursor_at = $2, cursor_key = $3,
                 lease_token = CASE WHEN $4 THEN NULL ELSE lease_token END,
                 lease_owner = CASE WHEN $4 THEN NULL ELSE lease_owner END,
                 lease_until = CASE WHEN $4 THEN NULL ELSE
                    clock_timestamp() + ($5::text || ' milliseconds')::interval END,
                 completed_at = CASE WHEN $4 THEN clock_timestamp() ELSE completed_at END,
                 updated_at = clock_timestamp()
             WHERE id = 1 AND status = 'running' AND lease_token = $1
             RETURNING id`,
            [token, cursorAt || null, cursorKey || null, complete,
                env.MARKET_METRIC_BOOTSTRAP_LEASE_MS]
        );
        if (!result.rows[0]) throw new Error('Market metric bootstrap lease was lost');
    }
}
