import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const enabled = process.env.RUN_INFRA_TESTS === 'true';
const suite = enabled ? describe : describe.skip;
const tokenMint = 'MetricFixture1111111111111111111111111111111';
const eventKey = '1'.repeat(64);
const lateEventKey = '2'.repeat(64);

suite('market projection infrastructure', () => {
    let query: any;
    let redisStreams: any;
    let STREAMS: any;
    let MarketEventStorageService: any;
    let MarketMetricService: any;
    let marketDb: any;

    beforeAll(async () => {
        process.env.DATABASE_URL = 'postgresql://fervor@localhost:55432/fervor';
        process.env.REDIS_URL = 'redis://localhost:6379';
        ({ query, marketDb } = await import('../src/config/database'));
        ({ redisStreams, STREAMS } = await import('../src/services/redisStreamService'));
        ({ MarketEventStorageService } = await import('../src/services/marketData/marketEventStorageService'));
        ({ MarketMetricService } = await import('../src/services/marketData/marketMetricService'));
        await redisStreams.connect();
        await query(
            `INSERT INTO tokens (mint, total_supply, circulating_supply, source, observed_at, stale)
             VALUES ($1, 1000000000, 900000000, 'fixture', CURRENT_TIMESTAMP, false)
             ON CONFLICT (mint) DO UPDATE SET total_supply = EXCLUDED.total_supply,
               circulating_supply = EXCLUDED.circulating_supply`,
            [tokenMint]
        );
        await redisStreams.command.del(
            `stream:seen:market.states:${eventKey}:state`,
            `stream:seen:ticks.normalized:${eventKey}:tick`,
            `stream:seen:market.states:${lateEventKey}:state`,
            `stream:seen:ticks.normalized:${lateEventKey}:tick`
        );
        await marketDb.query('DELETE FROM market_metric_events WHERE token_mint = $1', [tokenMint]);
        await marketDb.query('DELETE FROM market_metric_rollups WHERE token_mint = $1', [tokenMint]);
    });

    afterAll(async () => {
        await query('DELETE FROM market_state_snapshots WHERE token_mint = $1', [tokenMint]);
        await query('DELETE FROM trades WHERE token_mint = $1', [tokenMint]);
        await query('DELETE FROM tokens WHERE mint = $1', [tokenMint]);
        await redisStreams.command.del(
            `stream:seen:market.states:${eventKey}:state`,
            `stream:seen:ticks.normalized:${eventKey}:tick`,
            `stream:seen:market.states:${lateEventKey}:state`,
            `stream:seen:ticks.normalized:${lateEventKey}:tick`
        );
        await marketDb.query('DELETE FROM market_metric_events WHERE token_mint = $1', [tokenMint]);
        await marketDb.query('DELETE FROM market_metric_rollups WHERE token_mint = $1', [tokenMint]);
        await redisStreams.close();
    });

    it('persists exact amounts and atomically emits one rolling state and tick', async () => {
        const now = new Date();
        const trade = {
            kind: 'trade',
            idempotencyKey: eventKey,
            tokenMint,
            quoteMint: 'So11111111111111111111111111111111111111112',
            tokenAmount: 2,
            quoteAmount: 4,
            tokenAmountRaw: '2000000',
            quoteAmountRaw: '4000000000',
            tokenDecimals: 6,
            quoteDecimals: 9,
            solAmount: 4,
            usdAmount: 600,
            priceSol: 2,
            priceUsd: 300,
            priceQuote: 2,
            usdSource: 'jupiter_price_v3',
            usdObservedAt: now.toISOString(),
            usdBlockId: 41,
            maker: 'fixture-wallet',
            side: 'buy',
            protocol: 'orca_whirlpool',
            quoteKind: 'native_sol',
            route: ['orca_whirlpool'],
            decodeVersion: 'balance-delta-v1',
            source: 'helius_laserstream',
            sourceEventId: 'fixture-source-1',
            signature: 'fixture-signature-1',
            slot: 42,
            observedAt: now.toISOString(),
            receivedAt: now.toISOString(),
            confidence: 0.8,
            stale: false,
        };
        await new MarketEventStorageService().persist([trade]);
        const beforeStates = await redisStreams.command.xlen(STREAMS.marketStates);
        const beforeTicks = await redisStreams.command.xlen(STREAMS.ticksNormalized);
        const service = new MarketMetricService({
            get: async () => ({
                contract: 'fervor-market-input-v1',
                tokenMint,
                supply: {
                    totalSupply: 1_000_000_000,
                    circulatingSupply: 900_000_000,
                    supplyPolicy: 'fixture_supply_v1',
                    source: 'fixture',
                    sourceEventId: 'fixture:supply:1',
                    observedAt: now.toISOString(),
                    stale: false,
                    confidence: 0.95,
                },
            }),
        } as any);

        expect(await service.project(trade, { nowMs: now.getTime() })).toBe('committed');
        expect(await service.project(trade, { nowMs: now.getTime() })).toBe('duplicate');
        expect(await redisStreams.command.xlen(STREAMS.marketStates)).toBe(beforeStates + 1);
        expect(await redisStreams.command.xlen(STREAMS.ticksNormalized)).toBe(beforeTicks + 1);

        const storedTrade = await query(
            `SELECT token_amount_raw::text, quote_amount_raw::text, quote_mint, route
             FROM trades WHERE idempotency_key = $1`,
            [eventKey]
        );
        expect(storedTrade.rows[0]).toMatchObject({
            token_amount_raw: '2000000',
            quote_amount_raw: '4000000000',
            quote_mint: 'So11111111111111111111111111111111111111112',
            route: ['orca_whirlpool'],
        });
        const state = await query(
            `SELECT market_cap_usd::text, fdv_usd::text, volume_usd, buy_count
             FROM market_state_snapshots WHERE token_mint = $1 ORDER BY observed_at DESC LIMIT 1`,
            [tokenMint]
        );
        expect(state.rows[0]).toMatchObject({
            market_cap_usd: '270000000000.00',
            fdv_usd: '300000000000.00',
        });
        expect(state.rows[0].volume_usd['1m']).toBe(600);
        expect(state.rows[0].buy_count['24h']).toBe(1);
        const projected = await marketDb.query(
            `SELECT state FROM market_metric_events WHERE event_key = $1`,
            [eventKey]
        );
        expect(projected.rows[0].state.metricQuality).toMatchObject({
            price: { confidence: 0.8 },
            market_cap: { confidence: 0.8 },
            fdv: { confidence: 0.8 },
            supply: { sourceEventId: 'fixture:supply:1' },
            rolling: { estimated: true },
        });
        expect(projected.rows[0].state).toMatchObject({
            inputContract: 'fervor-market-input-v1',
            metricSource: 'fervor_engine',
            metricVersion: 'fervor-market-v1',
            supplyPolicy: 'fixture_supply_v1',
        });

        const late = {
            ...trade,
            idempotencyKey: lateEventKey,
            sourceEventId: 'fixture-source-late',
            signature: 'fixture-signature-late',
            priceUsd: 1,
            usdAmount: 50,
            observedAt: new Date(now.getTime() - 30_000).toISOString(),
        };
        expect(await service.project(late, { nowMs: now.getTime() })).toBe('committed');
        const latest = await marketDb.query(
            `SELECT state, source_event_id, usd_value::float8, base_amount::text, swap_type
             FROM market_metric_events WHERE event_key = $1`,
            [lateEventKey]
        );
        expect(latest.rows[0].state.priceUsd).toBe(300);
        expect(latest.rows[0].state.volumeUsd['1m']).toBe(650);
        expect(latest.rows[0].state.metricRevision).toBe(2);
        expect(latest.rows[0]).toMatchObject({
            source_event_id: 'fixture-source-late',
            usd_value: 50,
            base_amount: '2000000',
            swap_type: 'buy',
        });

        await expect(service.project({ ...late, priceUsd: 2 }, { nowMs: now.getTime() }))
            .rejects.toThrow('Metric event identity changed its input');
        await expect(service.project(
            { ...late, quoteAmountRaw: '4000000001' },
            { nowMs: now.getTime() }
        ))
            .rejects.toThrow('Metric event identity changed its input');
        const rollup = await marketDb.query(
            `SELECT revision FROM market_metric_rollups WHERE token_mint = $1`,
            [tokenMint]
        );
        expect(Number(rollup.rows[0].revision)).toBe(2);
    });
});
