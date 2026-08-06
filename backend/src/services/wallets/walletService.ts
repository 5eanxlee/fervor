import { marketDb, type DbQuery, query } from '../../config/database';
import { env } from '../../config/env';
import {
    TrackedWallet,
    TrackWalletRequest,
    UpdateWalletRequest,
    WalletActivity,
    WalletPortfolio,
    WalletPortfolioPoint,
    WalletPosition,
    safeSlot,
} from '../../types';

type Row = Record<string, any>;

export class WalletError extends Error {
    constructor(readonly code: string, message: string, readonly status: number) {
        super(message);
        this.name = 'WalletError';
    }
}

const iso = (value: unknown): string => (value instanceof Date ? value : new Date(String(value))).toISOString();
const optional = (value: unknown): string | undefined => value === null || value === undefined
    ? undefined
    : String(value);

const trackedFromRow = (row: Row): TrackedWallet => ({
    id: String(row.id),
    walletAddress: String(row.wallet_address),
    label: optional(row.label),
    notify: Boolean(row.notify),
    status: row.status as TrackedWallet['status'],
    lastSignature: optional(row.last_signature),
    lastSlot: safeSlot(row.last_slot),
    backfillComplete: Boolean(row.backfill_complete),
    backfillPages: Number(row.backfill_pages || 0),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
});

export class WalletService {
    private readonly core: DbQuery;
    private readonly market: DbQuery;

    constructor(core: DbQuery = query, market?: DbQuery) {
        this.core = core;
        this.market = market || ((text, params) => marketDb.query(text, params));
    }

    async create(userId: string, request: TrackWalletRequest): Promise<TrackedWallet> {
        const result = await this.core(
            `WITH source AS (
               INSERT INTO wallet_sources (wallet_address, provider)
               VALUES ($2, 'configured')
               ON CONFLICT (wallet_address) DO UPDATE SET wallet_address = EXCLUDED.wallet_address
               RETURNING id
             )
             INSERT INTO tracked_wallets (user_id, source_id, label, notify)
             SELECT $1, source.id, $3, $4 FROM source
             ON CONFLICT (user_id, source_id) DO UPDATE
               SET label = EXCLUDED.label, notify = EXCLUDED.notify, status = 'active'
             RETURNING id`,
            [userId, request.walletAddress, request.label || null, request.notify]
        );
        return this.get(userId, String(result.rows[0].id));
    }

    async list(userId: string): Promise<TrackedWallet[]> {
        const result = await this.core(
            `SELECT tracked.*, source.wallet_address, source.last_signature, source.last_slot,
                    source.backfill_complete, source.backfill_pages
             FROM tracked_wallets tracked
             JOIN wallet_sources source ON source.id = tracked.source_id
             WHERE tracked.user_id = $1 ORDER BY tracked.created_at DESC`,
            [userId]
        );
        return result.rows.map((row) => trackedFromRow(row as Row));
    }

    async get(userId: string, trackedId: string): Promise<TrackedWallet> {
        const row = await this.source(userId, trackedId);
        return trackedFromRow(row);
    }

    async update(userId: string, trackedId: string, request: UpdateWalletRequest): Promise<TrackedWallet> {
        const result = await this.core(
            `UPDATE tracked_wallets SET
               label = CASE WHEN $3::boolean THEN $4 ELSE label END,
               notify = COALESCE($5, notify),
               status = COALESCE($6, status)
             WHERE id = $1 AND user_id = $2 RETURNING id`,
            [trackedId, userId, request.label !== undefined, request.label ?? null,
                request.notify ?? null, request.status ?? null]
        );
        if (!result.rows[0]) throw new WalletError('wallet_not_found', 'Tracked wallet was not found', 404);
        return this.get(userId, trackedId);
    }

    async remove(userId: string, trackedId: string): Promise<void> {
        const result = await this.core(
            'DELETE FROM tracked_wallets WHERE id = $1 AND user_id = $2 RETURNING id',
            [trackedId, userId]
        );
        if (!result.rows[0]) throw new WalletError('wallet_not_found', 'Tracked wallet was not found', 404);
    }

    async activity(
        userId: string,
        trackedId: string,
        limit = 100,
        before?: string
    ): Promise<WalletActivity[]> {
        const source = await this.source(userId, trackedId);
        const cursor = before ? Buffer.from(before, 'base64url').toString('utf8').split('|') : [];
        if (before && (cursor.length !== 2
            || !Number.isFinite(Date.parse(cursor[0]))
            || !/^[0-9a-f]{64}$/.test(cursor[1]))) {
            throw new WalletError('invalid_cursor', 'Wallet activity cursor is invalid', 400);
        }
        const legacy = Number(source.projection_version || 1) < 2;
        const result = legacy
            ? await this.core(
                `SELECT id::text AS event_key, source_id, kind, token_mint, side,
                        quantity_base, value_micro_usd, signature, slot, provider,
                        occurred_at
                 FROM wallet_activity
                 WHERE source_id = $1
                   AND ($2::timestamptz IS NULL OR occurred_at < $2)
                 ORDER BY occurred_at DESC, id DESC
                 LIMIT $3`,
                [source.source_id, cursor[0] || null, Math.min(Math.max(limit, 1), 500)]
            )
            : await this.market(
                `SELECT * FROM wallet_events
                 WHERE source_id = $1
                   AND ($2::timestamptz IS NULL OR (occurred_at, event_key) < ($2, $3))
                 ORDER BY occurred_at DESC, event_key DESC
                 LIMIT $4`,
                [source.source_id, cursor[0] || null, cursor[1] || null, Math.min(Math.max(limit, 1), 500)]
            );
        return result.rows.map((row) => ({
            id: String(row.event_key),
            trackedWalletId: trackedId,
            walletAddress: String(row.wallet_address),
            kind: row.kind as WalletActivity['kind'],
            tokenMint: optional(row.token_mint),
            tokenDecimals: row.token_decimals === null || row.token_decimals === undefined
                ? undefined
                : Number(row.token_decimals),
            side: row.side ? row.side as WalletActivity['side'] : undefined,
            quantityBase: optional(row.quantity_base),
            valueMicroUsd: optional(row.value_micro_usd),
            signature: String(row.signature),
            slot: safeSlot(row.slot),
            source: String(row.provider),
            occurredAt: iso(row.occurred_at),
        }));
    }

    async positions(userId: string, trackedId: string): Promise<WalletPosition[]> {
        const source = await this.source(userId, trackedId);
        return this.positionsFor(
            trackedId,
            String(source.source_id),
            Number(source.projection_version || 1) < 2
        );
    }

    private async positionsFor(
        trackedId: string,
        sourceId: string,
        legacy = false
    ): Promise<WalletPosition[]> {
        if (legacy) {
            const result = await this.core(
                `SELECT *, 0 AS token_decimals
                 FROM wallet_positions
                 WHERE source_id = $1
                 ORDER BY cost_micro_usd DESC, token_mint`,
                [sourceId]
            );
            return result.rows.map((row) => ({
                trackedWalletId: trackedId,
                tokenMint: String(row.token_mint),
                tokenDecimals: 0,
                quantityBase: String(row.quantity_base),
                costMicroUsd: String(row.cost_micro_usd),
                unknownCostBase: String(row.quantity_base),
                realizedPnlMicroUsd: String(row.realized_pnl_micro_usd),
                unresolvedSoldBase: '0',
                untrackedSoldBase: String(row.untracked_sold_base),
                updatedAt: iso(row.updated_at),
            }));
        }
        const result = await this.market(
            `SELECT position.*,
                    metric.latest_state->>'priceUsd' AS price_usd,
                    metric.latest_observed_at AS price_observed_at,
                    CASE WHEN NULLIF(metric.latest_state->>'priceUsd', '') IS NULL THEN NULL ELSE
                      round(position.quantity_base
                        * (metric.latest_state->>'priceUsd')::numeric * 1000000
                        / power(10::numeric, position.token_decimals))
                    END AS current_value_micro_usd
             FROM wallet_position_state position
             LEFT JOIN market_metric_rollups metric
               ON metric.token_mint = position.token_mint
              AND metric.latest_observed_at >= CURRENT_TIMESTAMP
                  - ($2::text || ' milliseconds')::interval
             WHERE position.source_id = $1
             ORDER BY position.cost_micro_usd DESC, position.token_mint`,
            [sourceId, env.MARKET_MAX_STALE_MS]
        );
        return result.rows.map((row) => {
            const current = optional(row.current_value_micro_usd);
            const cost = String(row.cost_micro_usd);
            const knownBasis = String(row.unknown_cost_base) === '0';
            return {
                trackedWalletId: trackedId,
                tokenMint: String(row.token_mint),
                tokenDecimals: Number(row.token_decimals),
                quantityBase: String(row.quantity_base),
                costMicroUsd: cost,
                unknownCostBase: String(row.unknown_cost_base),
                realizedPnlMicroUsd: String(row.realized_pnl_micro_usd),
                unresolvedSoldBase: String(row.unresolved_sold_base),
                untrackedSoldBase: String(row.untracked_sold_base),
                currentValueMicroUsd: current,
                unrealizedPnlMicroUsd: current && knownBasis
                    ? (BigInt(current) - BigInt(cost)).toString()
                    : undefined,
                priceUsd: optional(row.price_usd),
                priceObservedAt: row.price_observed_at ? iso(row.price_observed_at) : undefined,
                updatedAt: iso(row.updated_at),
            };
        });
    }

    async portfolio(userId: string, trackedId: string): Promise<WalletPortfolio> {
        const source = await this.source(userId, trackedId);
        const legacy = Number(source.projection_version || 1) < 2;
        const positions = await this.positionsFor(trackedId, String(source.source_id), legacy);
        let marketValue = 0n;
        let cost = 0n;
        let realized = 0n;
        let unrealized = 0n;
        const historyComplete = Boolean(source.backfill_complete);
        let pnlComplete = historyComplete;
        let pricedAssets = 0;
        let unpricedAssets = 0;
        for (const position of positions) {
            cost += BigInt(position.costMicroUsd);
            realized += BigInt(position.realizedPnlMicroUsd);
            if (BigInt(position.unknownCostBase) > 0n
                || BigInt(position.unresolvedSoldBase) > 0n
                || BigInt(position.untrackedSoldBase) > 0n) {
                pnlComplete = false;
            }
            if (position.currentValueMicroUsd === undefined) unpricedAssets += Number(BigInt(position.quantityBase) > 0n);
            else {
                marketValue += BigInt(position.currentValueMicroUsd);
                pricedAssets += Number(BigInt(position.quantityBase) > 0n);
            }
            if (position.unrealizedPnlMicroUsd !== undefined) {
                unrealized += BigInt(position.unrealizedPnlMicroUsd);
            } else if (BigInt(position.quantityBase) > 0n) {
                pnlComplete = false;
            }
        }
        return {
            trackedWalletId: trackedId,
            marketValueMicroUsd: marketValue.toString(),
            costMicroUsd: cost.toString(),
            realizedPnlMicroUsd: realized.toString(),
            unrealizedPnlMicroUsd: pnlComplete ? unrealized.toString() : undefined,
            pnlComplete,
            historyComplete,
            pricedAssets,
            unpricedAssets,
            positions,
        };
    }

    async portfolioHistory(
        userId: string,
        trackedId: string,
        limit = 500,
        before?: string
    ): Promise<WalletPortfolioPoint[]> {
        const source = await this.source(userId, trackedId);
        if (Number(source.projection_version || 1) < 2) return [];
        const result = await this.market(
            `SELECT * FROM wallet_portfolio_points
             WHERE source_id = $1 AND ($2::timestamptz IS NULL OR bucket_at < $2)
             ORDER BY bucket_at DESC LIMIT $3`,
            [source.source_id, before || null, Math.min(Math.max(limit, 1), 2000)]
        );
        return result.rows.map((row) => ({
            at: iso(row.bucket_at),
            marketValueMicroUsd: String(row.market_value_micro_usd),
            costMicroUsd: String(row.cost_micro_usd),
            realizedPnlMicroUsd: String(row.realized_pnl_micro_usd),
            pnlComplete: Boolean(row.pnl_complete) && Boolean(source.backfill_complete),
            pricedAssets: Number(row.priced_assets),
            unpricedAssets: Number(row.unpriced_assets),
        }));
    }

    private async source(userId: string, trackedId: string): Promise<Row> {
        const result = await this.core(
            `SELECT tracked.*, source.id AS source_id, source.wallet_address,
                    source.last_signature, source.last_slot,
                    source.backfill_complete, source.backfill_pages, source.projection_version
             FROM tracked_wallets tracked
             JOIN wallet_sources source ON source.id = tracked.source_id
             WHERE tracked.id = $1 AND tracked.user_id = $2`,
            [trackedId, userId]
        );
        if (!result.rows[0]) throw new WalletError('wallet_not_found', 'Tracked wallet was not found', 404);
        return result.rows[0] as Row;
    }
}
