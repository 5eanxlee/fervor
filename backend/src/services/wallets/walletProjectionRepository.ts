import crypto from 'crypto';
import { marketDb, type Database, type DbQuery } from '../../config/database';
import { env } from '../../config/env';
import { safeSlot } from '../../types';
import { NormalizedWalletActivity } from './walletNormalizer';

type Row = Record<string, any>;

export interface StoredWalletEvent {
    created: boolean;
    key: string;
    payload: Record<string, unknown>;
    published: boolean;
}

const eventKey = (sourceId: string, identity: string): string =>
    crypto.createHash('sha256').update(`${sourceId}:${identity}`).digest('hex');

const inputHash = (
    sourceId: string,
    walletAddress: string,
    event: NormalizedWalletActivity,
    provider: string
): string =>
    crypto.createHash('sha256').update(JSON.stringify([
        sourceId,
        walletAddress,
        provider,
        event.idempotencyKey,
        event.kind,
        event.tokenMint,
        event.tokenDecimals,
        event.side,
        event.quantityBase,
        event.valueMicroUsd ?? null,
        event.signature,
        event.slot ?? null,
        event.txIndex ?? null,
        event.eventIndex,
        event.commitment ?? null,
        event.occurredAt,
    ])).digest('hex');

const laterThan = (event: NormalizedWalletActivity, state?: Row): boolean => {
    if (!state?.last_occurred_at) return true;
    const time = Date.parse(event.occurredAt) - new Date(state.last_occurred_at).getTime();
    if (time !== 0) return time > 0;
    return eventKey(String(state.source_id), event.idempotencyKey) > String(state.last_event_key || '');
};

export class WalletProjectionRepository {
    constructor(private readonly db: Database = marketDb) {}

    async append(
        sourceId: string,
        walletAddress: string,
        event: NormalizedWalletActivity,
        projectNow: boolean,
        provider: string
    ): Promise<StoredWalletEvent> {
        return this.db.transaction(async (db) => {
            await this.lock(db, sourceId);
            return this.appendTx(db, sourceId, walletAddress, event, projectNow, provider);
        });
    }

    async appendMany(
        sourceId: string,
        walletAddress: string,
        events: NormalizedWalletActivity[],
        projectNow: boolean,
        provider: string,
        heartbeat?: () => Promise<void>
    ): Promise<StoredWalletEvent[]> {
        if (events.length === 0) return [];
        return this.db.transaction(async (db) => {
            await this.lock(db, sourceId);
            const stored: StoredWalletEvent[] = [];
            for (let index = 0; index < events.length; index += 1) {
                if (heartbeat && index % 100 === 0) await heartbeat();
                const event = events[index];
                stored.push(await this.appendTx(
                    db, sourceId, walletAddress, event, false, provider
                ));
            }
            const created = stored.filter((event) => event.created).map((event) => event.key);
            if (projectNow && created.length > 0) {
                await this.projectBatchTx(db, sourceId, created, heartbeat);
            }
            return stored;
        });
    }

    async pending(limit = 250): Promise<Array<{
        sourceId: string;
        key: string;
        payload: Record<string, unknown>;
    }>> {
        const result = await this.db.query(
            `SELECT source_id::text, event_key, payload
             FROM wallet_event_fanout
             WHERE published_at IS NULL
             ORDER BY created_at
             LIMIT $1`,
            [limit]
        );
        return result.rows.map((row) => ({
            sourceId: row.source_id,
            key: row.event_key,
            payload: row.payload,
        }));
    }

    async markPublished(sourceId: string, key: string): Promise<void> {
        await this.db.query(
            `UPDATE wallet_event_fanout
             SET published_at = COALESCE(published_at, clock_timestamp()),
                 attempts = attempts + 1, last_error = NULL
             WHERE source_id = $1 AND event_key = $2`,
            [sourceId, key]
        );
    }

    async markPublishError(sourceId: string, key: string, error: unknown): Promise<void> {
        await this.db.query(
            `UPDATE wallet_event_fanout
             SET attempts = attempts + 1, last_error = $3
             WHERE source_id = $1 AND event_key = $2`,
            [sourceId, key, error instanceof Error ? error.message.slice(0, 1000) : String(error).slice(0, 1000)]
        );
    }

    async rebuild(sourceId: string, heartbeat?: () => Promise<void>): Promise<number> {
        return this.db.transaction(async (db) => {
            await this.lock(db, sourceId);
            return this.rebuildTx(db, sourceId, heartbeat);
        });
    }

    async snapshotNow(sourceId: string): Promise<void> {
        await this.db.transaction(async (db) => {
            await this.lock(db, sourceId);
            const state = await db(
                'SELECT revision, last_event_key FROM wallet_projection_state WHERE source_id = $1',
                [sourceId]
            );
            if (!state.rows[0]?.last_event_key) return;
            await this.snapshot(
                db,
                sourceId,
                state.rows[0].last_event_key,
                new Date().toISOString(),
                String(state.rows[0].revision)
            );
        });
    }

    private async appendTx(
        db: DbQuery,
        sourceId: string,
        walletAddress: string,
        event: NormalizedWalletActivity,
        projectNow: boolean,
        provider: string
    ): Promise<StoredWalletEvent> {
        const key = eventKey(sourceId, event.idempotencyKey);
        const hash = inputHash(sourceId, walletAddress, event, provider);
        const inserted = await db(
            `INSERT INTO wallet_events
                 (source_id, event_key, input_hash, wallet_address, kind, token_mint,
                  token_decimals, side, quantity_base, value_micro_usd, signature, slot,
                  tx_index, event_index, provider, commitment, raw_summary, occurred_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
                     $14, $15, $16, $17::jsonb, $18)
             ON CONFLICT (source_id, event_key) DO NOTHING
             RETURNING event_key`,
            [sourceId, key, hash, walletAddress, event.kind, event.tokenMint,
                event.tokenDecimals, event.side, event.quantityBase, event.valueMicroUsd || null,
                event.signature, event.slot ?? null, event.txIndex ?? null, event.eventIndex,
                provider, event.commitment || null, JSON.stringify(event.summary), event.occurredAt]
        );
        if (!inserted.rows[0]) {
            const existing = await db(
                'SELECT input_hash FROM wallet_events WHERE source_id = $1 AND event_key = $2',
                [sourceId, key]
            );
            if (existing.rows[0]?.input_hash !== hash) {
                throw new Error('Wallet event identity changed its input');
            }
            const fanout = await db(
                `SELECT payload, published_at IS NOT NULL AS published
                 FROM wallet_event_fanout WHERE source_id = $1 AND event_key = $2`,
                [sourceId, key]
            );
            return {
                created: false,
                key,
                payload: fanout.rows[0]?.payload || {},
                published: fanout.rows[0]?.published === true,
            };
        }
        const payload = {
            id: key,
            type: 'wallet.activity',
            version: 2,
            key: sourceId,
            source: provider,
            occurredAt: event.occurredAt,
            receivedAt: new Date().toISOString(),
            payload: { sourceId, walletAddress, ...event },
        };
        await db(
            `INSERT INTO wallet_event_fanout (source_id, event_key, payload)
             VALUES ($1, $2, $3::jsonb)`,
            [sourceId, key, JSON.stringify(payload)]
        );
        if (projectNow) {
            const state = await db(
                'SELECT * FROM wallet_projection_state WHERE source_id = $1 FOR UPDATE',
                [sourceId]
            );
            if (laterThan(event, state.rows[0])) {
                const revision = (BigInt(String(state.rows[0]?.revision || 0)) + 1n).toString();
                await this.project(db, sourceId, key, event, revision);
                await this.advance(db, sourceId, key, event.occurredAt, revision);
                await this.snapshot(db, sourceId, key, event.occurredAt, revision);
            } else {
                await this.rebuildTx(db, sourceId);
            }
        }
        return { created: true, key, payload, published: false };
    }

    private async projectBatchTx(
        db: DbQuery,
        sourceId: string,
        keys: string[],
        heartbeat?: () => Promise<void>
    ): Promise<void> {
        const state = await db(
            `SELECT projection.*, event.occurred_at AS event_occurred_at,
                    event.slot AS event_slot, event.tx_index AS event_tx_index,
                    event.event_index AS event_event_index, event.event_key AS event_event_key
             FROM wallet_projection_state projection
             LEFT JOIN wallet_events event
               ON event.source_id = projection.source_id
              AND event.event_key = projection.last_event_key
             WHERE projection.source_id = $1
             FOR UPDATE OF projection`,
            [sourceId]
        );
        if (!state.rows[0]?.event_event_key) {
            await this.rebuildTx(db, sourceId, heartbeat);
            return;
        }
        const events = await db(
            `SELECT * FROM wallet_events
             WHERE source_id = $1 AND event_key = ANY($2::bpchar[])
             ORDER BY occurred_at, COALESCE(slot, 0), COALESCE(tx_index, 0), event_index, event_key`,
            [sourceId, keys]
        );
        const ordered = [state.rows[0], ...events.rows];
        for (let index = 1; index < ordered.length; index += 1) {
            if (this.compareOrder(ordered[index - 1], ordered[index]) >= 0) {
                await this.rebuildTx(db, sourceId, heartbeat);
                return;
            }
        }
        let revision = BigInt(String(state.rows[0].revision));
        for (let index = 0; index < events.rows.length; index += 1) {
            if (heartbeat && index > 0 && index % 100 === 0) await heartbeat();
            const row = events.rows[index] as Row;
            revision += 1n;
            await this.project(db, sourceId, row.event_key, this.fromRow(row), revision.toString());
            await this.advance(db, sourceId, row.event_key, row.occurred_at, revision.toString());
            const next = events.rows[index + 1] as Row | undefined;
            if (!next || this.minute(row.occurred_at) !== this.minute(next.occurred_at)) {
                await this.snapshot(db, sourceId, row.event_key, row.occurred_at, revision.toString());
            }
        }
    }

    private async rebuildTx(
        db: DbQuery,
        sourceId: string,
        heartbeat?: () => Promise<void>
    ): Promise<number> {
        await db('DELETE FROM wallet_portfolio_points WHERE source_id = $1', [sourceId]);
        await db('DELETE FROM wallet_pnl_events WHERE source_id = $1', [sourceId]);
        await db('DELETE FROM wallet_position_lots WHERE source_id = $1', [sourceId]);
        await db('DELETE FROM wallet_position_state WHERE source_id = $1', [sourceId]);
        await db('DELETE FROM wallet_projection_state WHERE source_id = $1', [sourceId]);
        const events = await db(
            `SELECT * FROM wallet_events
             WHERE source_id = $1
             ORDER BY occurred_at, COALESCE(slot, 0), COALESCE(tx_index, 0), event_index, event_key`,
            [sourceId]
        );
        for (let index = 0; index < events.rows.length; index += 1) {
            if (heartbeat && index % 100 === 0) await heartbeat();
            const row = events.rows[index] as Row;
            const revision = String(index + 1);
            await this.project(db, sourceId, row.event_key, this.fromRow(row), revision);
            await this.advance(db, sourceId, row.event_key, row.occurred_at, revision);
            const next = events.rows[index + 1] as Row | undefined;
            const bucket = this.minute(row.occurred_at);
            const nextBucket = next ? this.minute(next.occurred_at) : undefined;
            if (bucket !== nextBucket) {
                await this.snapshot(db, sourceId, row.event_key, row.occurred_at, revision);
            }
        }
        await db(
            `UPDATE wallet_projection_state
             SET rebuilt_at = clock_timestamp(), updated_at = clock_timestamp()
             WHERE source_id = $1`,
            [sourceId]
        );
        return events.rows.length;
    }

    private async project(
        db: DbQuery,
        sourceId: string,
        key: string,
        event: NormalizedWalletActivity,
        revision: string
    ): Promise<void> {
        const selected = await db(
            `SELECT * FROM wallet_position_state
             WHERE source_id = $1 AND token_mint = $2 FOR UPDATE`,
            [sourceId, event.tokenMint]
        );
        const row = selected.rows[0] as Row | undefined;
        if (row && Number(row.token_decimals) !== event.tokenDecimals) {
            throw new Error('Wallet token decimals changed across events');
        }
        const quantity = BigInt(event.quantityBase);
        const value = event.valueMicroUsd === undefined ? undefined : BigInt(event.valueMicroUsd);

        if (event.side === 'buy') {
            const lotSeq = Number(row?.next_lot_seq || 1);
            await db(
                `INSERT INTO wallet_position_state
                     (source_id, token_mint, token_decimals, quantity_base, cost_micro_usd,
                      unknown_cost_base, next_lot_seq, revision, last_event_key, last_activity_at)
                 VALUES ($1, $2, $3, $4, $5, $6, 2, $7, $8, $9)
                 ON CONFLICT (source_id, token_mint) DO UPDATE SET
                     quantity_base = wallet_position_state.quantity_base + EXCLUDED.quantity_base,
                     cost_micro_usd = wallet_position_state.cost_micro_usd + EXCLUDED.cost_micro_usd,
                     unknown_cost_base = wallet_position_state.unknown_cost_base + EXCLUDED.unknown_cost_base,
                     next_lot_seq = wallet_position_state.next_lot_seq + 1,
                     revision = EXCLUDED.revision,
                     last_event_key = EXCLUDED.last_event_key,
                     last_activity_at = EXCLUDED.last_activity_at,
                     updated_at = clock_timestamp()`,
                [sourceId, event.tokenMint, event.tokenDecimals, quantity.toString(),
                    (value || 0n).toString(), value === undefined ? quantity.toString() : '0',
                    revision, key, event.occurredAt]
            );
            await db(
                `INSERT INTO wallet_position_lots
                     (source_id, token_mint, lot_seq, open_event_key, remaining_base,
                      remaining_cost_micro_usd, acquired_at)
                 VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                [sourceId, event.tokenMint, lotSeq, key, quantity.toString(),
                    value?.toString() || null, event.occurredAt]
            );
            return;
        }

        const openQuantity = BigInt(String(row?.quantity_base || 0));
        const tracked = quantity < openQuantity ? quantity : openQuantity;
        let remaining = tracked;
        let knownBase = 0n;
        let unknownBase = 0n;
        let consumedCost = 0n;
        if (remaining > 0n) {
            const lots = await db(
                `SELECT * FROM wallet_position_lots
                 WHERE source_id = $1 AND token_mint = $2
                 ORDER BY lot_seq FOR UPDATE`,
                [sourceId, event.tokenMint]
            );
            for (const lot of lots.rows as Row[]) {
                if (remaining === 0n) break;
                const lotQuantity = BigInt(String(lot.remaining_base));
                const consumed = remaining < lotQuantity ? remaining : lotQuantity;
                const lotCost = lot.remaining_cost_micro_usd === null
                    ? undefined
                    : BigInt(String(lot.remaining_cost_micro_usd));
                const consumedLotCost = lotCost === undefined
                    ? undefined
                    : consumed === lotQuantity ? lotCost : lotCost * consumed / lotQuantity;
                if (consumedLotCost === undefined) unknownBase += consumed;
                else {
                    knownBase += consumed;
                    consumedCost += consumedLotCost;
                }
                remaining -= consumed;
                if (consumed === lotQuantity) {
                    await db(
                        `DELETE FROM wallet_position_lots
                         WHERE source_id = $1 AND token_mint = $2 AND lot_seq = $3`,
                        [sourceId, event.tokenMint, lot.lot_seq]
                    );
                } else {
                    await db(
                        `UPDATE wallet_position_lots
                         SET remaining_base = remaining_base - $4,
                             remaining_cost_micro_usd = CASE
                               WHEN remaining_cost_micro_usd IS NULL THEN NULL
                               ELSE remaining_cost_micro_usd - $5
                             END
                         WHERE source_id = $1 AND token_mint = $2 AND lot_seq = $3`,
                        [sourceId, event.tokenMint, lot.lot_seq, consumed.toString(),
                            consumedLotCost?.toString() || '0']
                    );
                }
            }
        }
        const transferOut = event.kind === 'transfer_out';
        const knownProceeds = transferOut || value === undefined || knownBase === 0n
            ? undefined
            : value * knownBase / quantity;
        const realized = knownProceeds === undefined ? 0n : knownProceeds - consumedCost;
        const unresolved = transferOut ? 0n : value === undefined ? tracked : unknownBase;
        await db(
            `INSERT INTO wallet_position_state
                 (source_id, token_mint, token_decimals, quantity_base, cost_micro_usd,
                  unknown_cost_base, realized_pnl_micro_usd, unresolved_sold_base,
                  untracked_sold_base, revision, last_event_key, last_activity_at)
             VALUES ($1, $2, $3, 0, 0, 0, 0, 0, $4, $5, $6, $7)
             ON CONFLICT (source_id, token_mint) DO UPDATE SET
                 quantity_base = wallet_position_state.quantity_base - $8,
                 cost_micro_usd = wallet_position_state.cost_micro_usd - $9,
                 unknown_cost_base = wallet_position_state.unknown_cost_base - $10,
                 realized_pnl_micro_usd = wallet_position_state.realized_pnl_micro_usd + $11,
                 unresolved_sold_base = wallet_position_state.unresolved_sold_base + $12,
                 untracked_sold_base = wallet_position_state.untracked_sold_base + $4,
                 revision = $5,
                 last_event_key = $6,
                 last_activity_at = $7,
                 updated_at = clock_timestamp()`,
            [sourceId, event.tokenMint, event.tokenDecimals, (quantity - tracked).toString(),
                revision, key, event.occurredAt, tracked.toString(), consumedCost.toString(),
                unknownBase.toString(), realized.toString(), unresolved.toString()]
        );
        if (transferOut) return;
        await db(
            `INSERT INTO wallet_pnl_events
                 (source_id, event_key, token_mint, sold_base, known_cost_base,
                  unknown_cost_base, proceeds_micro_usd, consumed_cost_micro_usd,
                  realized_pnl_micro_usd, occurred_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
            [sourceId, key, event.tokenMint, quantity.toString(), knownBase.toString(),
                unknownBase.toString(), value?.toString() || null, consumedCost.toString(),
                knownProceeds === undefined ? null : realized.toString(), event.occurredAt]
        );
    }

    private async advance(
        db: DbQuery,
        sourceId: string,
        key: string,
        occurredAt: string | Date,
        revision: string
    ): Promise<void> {
        await db(
            `INSERT INTO wallet_projection_state
                 (source_id, revision, event_count, last_event_key, last_occurred_at)
             VALUES ($1, $2, $2, $3, $4)
             ON CONFLICT (source_id) DO UPDATE SET
                 revision = EXCLUDED.revision,
                 event_count = EXCLUDED.event_count,
                 last_event_key = EXCLUDED.last_event_key,
                 last_occurred_at = EXCLUDED.last_occurred_at,
                 updated_at = clock_timestamp()`,
            [sourceId, revision, key, occurredAt]
        );
    }

    private async snapshot(
        db: DbQuery,
        sourceId: string,
        key: string,
        observedAt: string | Date,
        revision: string
    ): Promise<void> {
        await db(
            `WITH valued AS (
               SELECT position.quantity_base,
                      position.cost_micro_usd,
                      position.realized_pnl_micro_usd,
                      position.unknown_cost_base,
                      position.unresolved_sold_base,
                      position.untracked_sold_base,
                      CASE WHEN position.quantity_base = 0 THEN 0
                           WHEN metric.price_usd IS NULL THEN NULL ELSE
                        round(position.quantity_base * metric.price_usd * 1000000
                            / power(10::numeric, position.token_decimals))
                      END AS market_value
               FROM wallet_position_state position
               LEFT JOIN LATERAL (
                 SELECT NULLIF(event.state->>'priceUsd', '')::numeric AS price_usd
                 FROM market_metric_events event
                 WHERE event.token_mint = position.token_mint
                   AND COALESCE(
                     NULLIF(event.state->>'priceObservedAt', '')::timestamptz,
                     event.observed_at
                   ) <= $3
                   AND COALESCE(
                     NULLIF(event.state->>'priceObservedAt', '')::timestamptz,
                     event.observed_at
                   ) >= $3::timestamptz
                       - ($5::text || ' milliseconds')::interval
                 ORDER BY COALESCE(
                     NULLIF(event.state->>'priceObservedAt', '')::timestamptz,
                     event.observed_at
                   ) DESC, event.revision DESC
                 LIMIT 1
               ) metric ON TRUE
               WHERE position.source_id = $1
             ), totals AS (
               SELECT COALESCE(sum(market_value) FILTER (WHERE market_value IS NOT NULL), 0) AS market_value,
                      COALESCE(sum(cost_micro_usd), 0) AS cost,
                      COALESCE(sum(realized_pnl_micro_usd), 0) AS realized,
                      COALESCE(sum(unknown_cost_base), 0) AS unknown_cost,
                      COALESCE(sum(unresolved_sold_base), 0) AS unresolved,
                      COALESCE(sum(untracked_sold_base), 0) AS untracked,
                      NOT COALESCE(bool_or(
                        unknown_cost_base > 0 OR unresolved_sold_base > 0
                        OR untracked_sold_base > 0
                        OR (quantity_base > 0 AND market_value IS NULL)
                      ), false) AS pnl_complete,
                      count(*) FILTER (WHERE quantity_base > 0 AND market_value IS NOT NULL)::int AS priced,
                      count(*) FILTER (WHERE quantity_base > 0 AND market_value IS NULL)::int AS unpriced
               FROM valued
             )
             INSERT INTO wallet_portfolio_points
                 (source_id, bucket_at, observed_at, event_key, revision,
                  market_value_micro_usd, cost_micro_usd, realized_pnl_micro_usd,
                  unknown_cost_base, unresolved_sold_base, untracked_sold_base, pnl_complete,
                  priced_assets, unpriced_assets)
             SELECT $1, date_trunc('minute', $3::timestamptz), $3, $2, $4,
                    market_value, cost, realized, unknown_cost, unresolved, untracked,
                    pnl_complete, priced, unpriced
             FROM totals
             ON CONFLICT (source_id, bucket_at) DO UPDATE SET
                 observed_at = EXCLUDED.observed_at,
                 event_key = EXCLUDED.event_key,
                 revision = EXCLUDED.revision,
                 market_value_micro_usd = EXCLUDED.market_value_micro_usd,
                 cost_micro_usd = EXCLUDED.cost_micro_usd,
                 realized_pnl_micro_usd = EXCLUDED.realized_pnl_micro_usd,
                 unknown_cost_base = EXCLUDED.unknown_cost_base,
                 unresolved_sold_base = EXCLUDED.unresolved_sold_base,
                 untracked_sold_base = EXCLUDED.untracked_sold_base,
                 pnl_complete = EXCLUDED.pnl_complete,
                 priced_assets = EXCLUDED.priced_assets,
                 unpriced_assets = EXCLUDED.unpriced_assets
             WHERE (EXCLUDED.observed_at, EXCLUDED.event_key)
                   >= (wallet_portfolio_points.observed_at, wallet_portfolio_points.event_key)`,
            [sourceId, key, observedAt, revision, env.MARKET_MAX_STALE_MS]
        );
    }

    private fromRow(row: Row): NormalizedWalletActivity {
        return {
            idempotencyKey: String(row.event_key),
            kind: row.kind,
            tokenMint: row.token_mint,
            tokenDecimals: Number(row.token_decimals),
            side: row.side,
            quantityBase: String(row.quantity_base),
            valueMicroUsd: row.value_micro_usd === null ? undefined : String(row.value_micro_usd),
            signature: row.signature,
            slot: safeSlot(row.slot),
            txIndex: row.tx_index === null ? undefined : Number(row.tx_index),
            eventIndex: Number(row.event_index),
            commitment: row.commitment || undefined,
            occurredAt: new Date(row.occurred_at).toISOString(),
            summary: row.raw_summary || {},
        };
    }

    private compareOrder(left: Row, right: Row): number {
        const leftValues = [
            new Date(left.event_occurred_at || left.occurred_at).getTime(),
            Number(left.event_slot ?? left.slot ?? 0),
            Number(left.event_tx_index ?? left.tx_index ?? 0),
            Number(left.event_event_index ?? left.event_index ?? 0),
        ];
        const rightValues = [
            new Date(right.event_occurred_at || right.occurred_at).getTime(),
            Number(right.event_slot ?? right.slot ?? 0),
            Number(right.event_tx_index ?? right.tx_index ?? 0),
            Number(right.event_event_index ?? right.event_index ?? 0),
        ];
        for (let index = 0; index < leftValues.length; index += 1) {
            if (leftValues[index] !== rightValues[index]) return leftValues[index] < rightValues[index] ? -1 : 1;
        }
        const leftKey = String(left.event_event_key || left.event_key || '');
        const rightKey = String(right.event_event_key || right.event_key || '');
        return leftKey.localeCompare(rightKey);
    }

    private minute(value: string | Date): string {
        return new Date(value).toISOString().slice(0, 16);
    }

    private async lock(db: DbQuery, sourceId: string): Promise<void> {
        await db('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [sourceId]);
    }
}

export const walletProjectionRepository = new WalletProjectionRepository();
