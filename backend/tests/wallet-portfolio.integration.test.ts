import crypto from 'crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const enabled = process.env.RUN_INFRA_TESTS === 'true';
const suite = enabled ? describe : describe.skip;
const wallet = '7Zb1d7t2S9Bkv8G6gPKZQdgs7Qk1HSA1xY5g7uEczwzE';
const token = 'So11111111111111111111111111111111111111112';

suite('wallet portfolio infrastructure', () => {
    let query: any;
    let marketDb: any;
    let WalletProjectionRepository: any;
    let WalletIndexerService: any;
    let WalletService: any;
    let userId = '';
    let sourceId = '';
    let trackedId = '';
    let metricKey = '';
    const marker = crypto.randomBytes(8).toString('hex');
    const start = Date.now() - 10_000;

    beforeAll(async () => {
        ({ query, marketDb } = await import('../src/config/database'));
        ({ WalletProjectionRepository } = await import('../src/services/wallets/walletProjectionRepository'));
        ({ WalletIndexerService } = await import('../src/services/wallets/walletIndexerService'));
        ({ WalletService } = await import('../src/services/wallets/walletService'));
        const user = await query(
            'INSERT INTO users (wallet_address) VALUES ($1) RETURNING id',
            [`WalletPortfolio${marker}`]
        );
        userId = user.rows[0].id;
        const source = await query(
            `INSERT INTO wallet_sources (wallet_address, provider, backfill_complete)
             VALUES ($1, 'fixture', TRUE) RETURNING id`,
            [wallet]
        );
        sourceId = source.rows[0].id;
        const tracked = await query(
            `INSERT INTO tracked_wallets (user_id, source_id, label)
             VALUES ($1, $2, 'Fixture') RETURNING id`,
            [userId, sourceId]
        );
        trackedId = tracked.rows[0].id;

        metricKey = crypto.createHash('sha256').update(`wallet-metric:${marker}`).digest('hex');
        await marketDb.query(
            `INSERT INTO market_metric_rollups
                 (token_mint, revision, rollup, latest_state, latest_observed_at,
                  latest_event_key)
             VALUES ($1, 1, '{}'::jsonb, '{"priceUsd":30}'::jsonb, $2, $3)
             ON CONFLICT (token_mint) DO UPDATE SET
                 revision = EXCLUDED.revision,
                 latest_state = EXCLUDED.latest_state,
                 latest_observed_at = EXCLUDED.latest_observed_at,
                 latest_event_key = EXCLUDED.latest_event_key`,
            [token, new Date(start - 60_000).toISOString(), metricKey]
        );
        await marketDb.query(
            `INSERT INTO market_metric_events
                 (event_key, input_hash, token_mint, source_event_id, observed_at,
                  revision, state, usd_value, swap_type)
             VALUES ($1, $1, $2, $3, $4, 1,
                     '{"priceUsd":30}'::jsonb, 1, 'buy')`,
            [metricKey, token, `wallet-metric-${marker}`, new Date(start - 60_000).toISOString()]
        );
        const lateMetricKey = crypto.createHash('sha256').update(`late-wallet-metric:${marker}`).digest('hex');
        await marketDb.query(
            `INSERT INTO market_metric_events
                 (event_key, input_hash, token_mint, source_event_id, observed_at,
                  revision, state, usd_value, swap_type)
             VALUES ($1, $1, $2, $3, $4, 2,
                     jsonb_build_object('priceUsd', 999, 'priceObservedAt', $5::text), 1, 'buy')`,
            [lateMetricKey, token, `late-wallet-metric-${marker}`,
                new Date(start - 30_000).toISOString(), new Date(start + 60_000).toISOString()]
        );
    });

    afterAll(async () => {
        if (userId) await query('DELETE FROM users WHERE id = $1', [userId]);
        if (sourceId) await query('DELETE FROM wallet_sources WHERE id = $1', [sourceId]);
        if (metricKey) {
            await marketDb.query('DELETE FROM market_metric_events WHERE token_mint = $1', [token]);
            await marketDb.query(
                'DELETE FROM market_metric_rollups WHERE token_mint = $1 AND latest_event_key = $2',
                [token, metricKey]
            );
        }
    });

    const event = (
        id: string,
        side: 'buy' | 'sell',
        quantityBase: string,
        valueMicroUsd: string | undefined,
        offsetMs: number,
        kind: 'swap' | 'transfer_in' | 'transfer_out' = 'swap'
    ) => ({
        idempotencyKey: `${marker}:${id}`,
        kind,
        tokenMint: token,
        tokenDecimals: 0,
        side,
        quantityBase,
        valueMicroUsd,
        signature: crypto.createHash('sha512').update(`${marker}:${id}`).digest('hex').slice(0, 88),
        slot: 100 + offsetMs,
        eventIndex: 0,
        commitment: 'finalized' as const,
        occurredAt: new Date(start + offsetMs).toISOString(),
        summary: { source: 'helius_history_v2' },
    });

    it('leases a due source to only one overlapping poller', async () => {
        await query(
            `UPDATE wallet_sources
             SET next_poll_at = CURRENT_TIMESTAMP, lease_token = NULL,
                 lease_owner = NULL, lease_until = NULL
             WHERE id = $1`,
            [sourceId]
        );
        let release!: () => void;
        let started!: () => void;
        const gate = new Promise<void>((resolve) => { release = resolve; });
        const entered = new Promise<void>((resolve) => { started = resolve; });
        let calls = 0;
        const provider = {
            name: 'fixture' as const,
            history: async () => {
                calls += 1;
                started();
                await gate;
                return { transactions: [] };
            },
        };
        const projections = {
            append: async () => ({ created: false, key: '', payload: {}, published: true }),
            appendMany: async () => [],
            rebuild: async () => 0,
            snapshotNow: async () => undefined,
            pending: async () => [],
            markPublished: async () => undefined,
            markPublishError: async () => undefined,
        };
        const first = new WalletIndexerService(provider, undefined, projections, 'wallet-test-a').runBatch(1);
        await entered;
        const second = new WalletIndexerService(provider, undefined, projections, 'wallet-test-b').runBatch(1);
        release();

        expect(await Promise.all([first, second])).toEqual([1, 0]);
        expect(calls).toBe(1);
    });

    it('replays out-of-order wallet facts into normalized FIFO lots and portfolio marks', async () => {
        const repository = new WalletProjectionRepository();
        const buy = event('buy', 'buy', '10', '100000000', 1_000);
        expect((await repository.append(sourceId, wallet, buy, true, 'fixture')).created).toBe(true);
        expect((await repository.append(sourceId, wallet, buy, true, 'fixture')).created).toBe(false);
        await expect(repository.append(
            sourceId,
            wallet,
            { ...buy, quantityBase: '11' },
            true,
            'fixture'
        )).rejects.toThrow('identity changed');

        const batch = await repository.appendMany(sourceId, wallet, [
            event('transfer', 'buy', '5', undefined, 3_000, 'transfer_in'),
            event('sell', 'sell', '12', '240000000', 4_000),
        ], true, 'fixture');
        expect(batch.map((item: any) => item.created)).toEqual([true, true]);
        await repository.append(sourceId, wallet, event('late-buy', 'buy', '2', '20000000', 2_000), true, 'fixture');

        const state = await marketDb.query(
            `SELECT quantity_base::text, cost_micro_usd::text, unknown_cost_base::text,
                    realized_pnl_micro_usd::text, unresolved_sold_base::text,
                    untracked_sold_base::text, revision
             FROM wallet_position_state WHERE source_id = $1 AND token_mint = $2`,
            [sourceId, token]
        );
        expect(state.rows[0]).toMatchObject({
            quantity_base: '5',
            cost_micro_usd: '0',
            unknown_cost_base: '5',
            realized_pnl_micro_usd: '120000000',
            unresolved_sold_base: '0',
            untracked_sold_base: '0',
        });
        expect(Number(state.rows[0].revision)).toBe(4);
        const lots = await marketDb.query(
            `SELECT remaining_base::text, remaining_cost_micro_usd::text
             FROM wallet_position_lots WHERE source_id = $1 ORDER BY lot_seq`,
            [sourceId]
        );
        expect(lots.rows).toEqual([{ remaining_base: '5', remaining_cost_micro_usd: null }]);

        const service = new WalletService();
        const portfolio = await service.portfolio(userId, trackedId);
        expect(portfolio).toMatchObject({
            marketValueMicroUsd: '150000000',
            costMicroUsd: '0',
            realizedPnlMicroUsd: '120000000',
            unrealizedPnlMicroUsd: undefined,
            pnlComplete: false,
            historyComplete: true,
            pricedAssets: 1,
            unpricedAssets: 0,
        });
        expect(portfolio.positions[0]).toMatchObject({
            quantityBase: '5',
            unknownCostBase: '5',
            currentValueMicroUsd: '150000000',
            unrealizedPnlMicroUsd: undefined,
        });
        const history = await service.portfolioHistory(userId, trackedId);
        expect(history.length).toBeGreaterThan(0);
        expect(history[0].pricedAssets).toBe(1);
        expect(history[0].pnlComplete).toBe(false);

        await repository.append(
            sourceId,
            wallet,
            event('transfer-out', 'sell', '2', undefined, 5_000, 'transfer_out'),
            true,
            'fixture'
        );
        const afterTransfer = await marketDb.query(
            `SELECT quantity_base::text, unknown_cost_base::text,
                    realized_pnl_micro_usd::text, unresolved_sold_base::text
             FROM wallet_position_state WHERE source_id = $1 AND token_mint = $2`,
            [sourceId, token]
        );
        expect(afterTransfer.rows[0]).toMatchObject({
            quantity_base: '3',
            unknown_cost_base: '3',
            realized_pnl_micro_usd: '120000000',
            unresolved_sold_base: '0',
        });
        const pnlEvents = await marketDb.query(
            'SELECT COUNT(*)::int AS count FROM wallet_pnl_events WHERE source_id = $1',
            [sourceId]
        );
        expect(pnlEvents.rows[0].count).toBe(1);

        await expect(marketDb.query(
            `UPDATE wallet_events SET quantity_base = 99
             WHERE source_id = $1`,
            [sourceId]
        )).rejects.toThrow('append-only');
    });
});
