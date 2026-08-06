import { query } from '../../config/database';
import {
    NormalizedLiquidityEvent,
    NormalizedMarketEvent,
    NormalizedMarketState,
    NormalizedPoolEvent,
    NormalizedTokenEvent,
    NormalizedTradeEvent,
} from '../../types';
import { metrics } from '../metrics';

const tradeColumns = `
    idempotency_key, token_mint, pool_address, protocol, maker, side, token_amount,
    quote_mint, quote_amount, token_amount_raw, quote_amount_raw, token_decimals, quote_decimals,
    sol_amount, usd_amount, price_sol, price_usd, signature, slot, instruction_index, event_index,
    program_id, route, quote_kind, decode_version, compute_units,
    source, source_event_id, observed_at, received_at, confidence, stale`;

const tradeValues = (event: NormalizedTradeEvent): unknown[] => [
    event.idempotencyKey,
    event.tokenMint,
    event.poolAddress ?? null,
    event.protocol ?? null,
    event.maker ?? null,
    event.side ?? null,
    event.tokenAmount ?? null,
    event.quoteMint ?? null,
    event.quoteAmount ?? null,
    event.tokenAmountRaw ?? null,
    event.quoteAmountRaw ?? null,
    event.tokenDecimals ?? null,
    event.quoteDecimals ?? null,
    event.solAmount ?? null,
    event.usdAmount ?? null,
    event.priceSol ?? null,
    event.priceUsd ?? null,
    event.signature ?? null,
    event.slot ?? null,
    event.instructionIndex ?? 0,
    event.eventIndex ?? 0,
    event.programId ?? null,
    event.route ? JSON.stringify(event.route) : null,
    event.quoteKind ?? null,
    event.decodeVersion ?? null,
    event.computeUnits ?? null,
    event.source,
    event.sourceEventId,
    event.observedAt,
    event.receivedAt,
    event.confidence,
    event.stale,
];

export class MarketEventStorageService {
    async persist(events: NormalizedMarketEvent[]): Promise<void> {
        const trades = events.filter((event): event is NormalizedTradeEvent => event.kind === 'trade');
        const states = events.filter((event): event is NormalizedMarketState => event.kind === 'market_state');
        const liquidity = events.filter((event): event is NormalizedLiquidityEvent => event.kind === 'liquidity');

        if (trades.length > 1) {
            await this.persistTrades(trades);
        } else if (trades[0]) {
            await this.persistTrade(trades[0]);
        }

        if (states.length > 1) {
            await this.persistMarketStates(states);
        } else if (states[0]) {
            await this.persistMarketState(states[0]);
        }

        if (liquidity.length > 1) {
            await this.persistLiquidityBatch(liquidity);
        } else if (liquidity[0]) {
            await this.persistLiquidity(liquidity[0]);
        }

        for (const event of events) {
            if (event.kind === 'token') await this.persistToken(event);
            if (event.kind === 'pool') await this.persistPool(event);
        }
    }

    private async persistTrades(events: NormalizedTradeEvent[]): Promise<void> {
        const done = metrics.timer('fervor_market_trade_batch_insert_ms');
        try {
            const values: any[] = [];
            const rows = events.map((event, index) => {
                const eventValues = tradeValues(event);
                const offset = index * eventValues.length;
                values.push(...eventValues);
                return `(${eventValues.map((_, param) => `$${offset + param + 1}`).join(', ')})`;
            });

            await query(
                `INSERT INTO trades (${tradeColumns})
                 VALUES ${rows.join(', ')}
                 ON CONFLICT (idempotency_key, observed_at) DO NOTHING`,
                values
            );
            metrics.increment('fervor_market_trades_persisted', undefined, events.length);
        } finally {
            done();
        }
    }

    private async persistTrade(event: NormalizedTradeEvent): Promise<void> {
        const done = metrics.timer('fervor_market_trade_insert_ms', { source: event.source });
        try {
            const values = tradeValues(event);
            await query(
                `INSERT INTO trades (${tradeColumns})
                 VALUES (${values.map((_, index) => `$${index + 1}`).join(', ')})
                 ON CONFLICT (idempotency_key, observed_at) DO NOTHING`,
                values
            );
            metrics.increment('fervor_market_trades_persisted', { source: event.source });
        } finally {
            done();
        }
    }

    private async persistMarketState(event: NormalizedMarketState): Promise<void> {
        await query(
            `INSERT INTO market_state_snapshots
             (idempotency_key, token_mint, pool_address, protocol, price_usd, price_sol, market_cap_usd, fdv_usd,
              liquidity_usd, liquidity_sol, total_supply, circulating_supply, source, source_event_id,
              signature, slot, observed_at, received_at, confidence, stale, volume_usd, buy_count,
              sell_count, tx_count, unique_buyers, unique_sellers)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16,
                     $17, $18, $19, $20, $21, $22, $23, $24, $25, $26)
             ON CONFLICT (idempotency_key, observed_at) DO NOTHING`,
            [
                event.idempotencyKey,
                event.tokenMint,
                event.poolAddress ?? null,
                event.protocol ?? null,
                event.priceUsd ?? null,
                event.priceSol ?? null,
                event.marketCapUsd ?? null,
                event.fdvUsd ?? null,
                event.liquidityUsd ?? null,
                event.liquiditySol ?? null,
                event.totalSupply ?? null,
                event.circulatingSupply ?? null,
                event.source,
                event.sourceEventId,
                event.signature ?? null,
                event.slot ?? null,
                event.observedAt,
                event.receivedAt,
                event.confidence,
                event.stale,
                event.volumeUsd ? JSON.stringify(event.volumeUsd) : null,
                event.buyCount ? JSON.stringify(event.buyCount) : null,
                event.sellCount ? JSON.stringify(event.sellCount) : null,
                event.txCount ? JSON.stringify(event.txCount) : null,
                event.uniqueBuyers ? JSON.stringify(event.uniqueBuyers) : null,
                event.uniqueSellers ? JSON.stringify(event.uniqueSellers) : null,
            ]
        );

        await query(
            `INSERT INTO tokens
             (mint, price_usd, price_sol, market_cap_usd, fdv_usd, liquidity_usd, total_supply,
              circulating_supply, source, observed_at, stale, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, CURRENT_TIMESTAMP)
             ON CONFLICT (mint) DO UPDATE SET
               price_usd = COALESCE(EXCLUDED.price_usd, tokens.price_usd),
               price_sol = COALESCE(EXCLUDED.price_sol, tokens.price_sol),
               market_cap_usd = COALESCE(EXCLUDED.market_cap_usd, tokens.market_cap_usd),
               fdv_usd = COALESCE(EXCLUDED.fdv_usd, tokens.fdv_usd),
               liquidity_usd = COALESCE(EXCLUDED.liquidity_usd, tokens.liquidity_usd),
               total_supply = COALESCE(EXCLUDED.total_supply, tokens.total_supply),
               circulating_supply = COALESCE(EXCLUDED.circulating_supply, tokens.circulating_supply),
               source = EXCLUDED.source,
               observed_at = EXCLUDED.observed_at,
               stale = EXCLUDED.stale,
               updated_at = CURRENT_TIMESTAMP
             WHERE tokens.observed_at IS NULL OR EXCLUDED.observed_at >= tokens.observed_at`,
            [
                event.tokenMint,
                event.priceUsd ?? null,
                event.priceSol ?? null,
                event.marketCapUsd ?? null,
                event.fdvUsd ?? null,
                event.liquidityUsd ?? null,
                event.totalSupply ?? null,
                event.circulatingSupply ?? null,
                event.source,
                event.observedAt,
                event.stale,
            ]
        );
        metrics.increment('fervor_market_states_persisted', { source: event.source });
    }

    private async persistMarketStates(events: NormalizedMarketState[]): Promise<void> {
        const snapshotValues: any[] = [];
        const snapshotRows = events.map((event, index) => {
            const offset = index * 26;
            snapshotValues.push(
                event.idempotencyKey,
                event.tokenMint,
                event.poolAddress ?? null,
                event.protocol ?? null,
                event.priceUsd ?? null,
                event.priceSol ?? null,
                event.marketCapUsd ?? null,
                event.fdvUsd ?? null,
                event.liquidityUsd ?? null,
                event.liquiditySol ?? null,
                event.totalSupply ?? null,
                event.circulatingSupply ?? null,
                event.source,
                event.sourceEventId,
                event.signature ?? null,
                event.slot ?? null,
                event.observedAt,
                event.receivedAt,
                event.confidence,
                event.stale,
                event.volumeUsd ? JSON.stringify(event.volumeUsd) : null,
                event.buyCount ? JSON.stringify(event.buyCount) : null,
                event.sellCount ? JSON.stringify(event.sellCount) : null,
                event.txCount ? JSON.stringify(event.txCount) : null,
                event.uniqueBuyers ? JSON.stringify(event.uniqueBuyers) : null,
                event.uniqueSellers ? JSON.stringify(event.uniqueSellers) : null
            );
            return `(${Array.from({ length: 26 }, (_, param) => `$${offset + param + 1}`).join(', ')})`;
        });

        await query(
            `INSERT INTO market_state_snapshots
             (idempotency_key, token_mint, pool_address, protocol, price_usd, price_sol, market_cap_usd, fdv_usd,
              liquidity_usd, liquidity_sol, total_supply, circulating_supply, source, source_event_id,
              signature, slot, observed_at, received_at, confidence, stale, volume_usd, buy_count,
              sell_count, tx_count, unique_buyers, unique_sellers)
             VALUES ${snapshotRows.join(', ')}
             ON CONFLICT (idempotency_key, observed_at) DO NOTHING`,
            snapshotValues
        );

        for (const event of events) {
            await query(
                `INSERT INTO tokens
                 (mint, price_usd, price_sol, market_cap_usd, fdv_usd, liquidity_usd, total_supply,
                  circulating_supply, source, observed_at, stale, updated_at)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, CURRENT_TIMESTAMP)
                 ON CONFLICT (mint) DO UPDATE SET
                   price_usd = COALESCE(EXCLUDED.price_usd, tokens.price_usd),
                   price_sol = COALESCE(EXCLUDED.price_sol, tokens.price_sol),
                   market_cap_usd = COALESCE(EXCLUDED.market_cap_usd, tokens.market_cap_usd),
                   fdv_usd = COALESCE(EXCLUDED.fdv_usd, tokens.fdv_usd),
                   liquidity_usd = COALESCE(EXCLUDED.liquidity_usd, tokens.liquidity_usd),
                   total_supply = COALESCE(EXCLUDED.total_supply, tokens.total_supply),
                   circulating_supply = COALESCE(EXCLUDED.circulating_supply, tokens.circulating_supply),
                   source = EXCLUDED.source,
                   observed_at = EXCLUDED.observed_at,
                   stale = EXCLUDED.stale,
                   updated_at = CURRENT_TIMESTAMP
                 WHERE tokens.observed_at IS NULL OR EXCLUDED.observed_at >= tokens.observed_at`,
                [
                    event.tokenMint,
                    event.priceUsd ?? null,
                    event.priceSol ?? null,
                    event.marketCapUsd ?? null,
                    event.fdvUsd ?? null,
                    event.liquidityUsd ?? null,
                    event.totalSupply ?? null,
                    event.circulatingSupply ?? null,
                    event.source,
                    event.observedAt,
                    event.stale,
                ]
            );
        }
        metrics.increment('fervor_market_states_persisted', undefined, events.length);
    }

    private async persistToken(event: NormalizedTokenEvent): Promise<void> {
        await query(
            `INSERT INTO tokens
             (mint, decimals, name, symbol, image, metadata_uri, creator, deployer, launchpad, lifecycle_status,
              source, observed_at, stale, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, CURRENT_TIMESTAMP)
             ON CONFLICT (mint) DO UPDATE SET
               decimals = COALESCE(EXCLUDED.decimals, tokens.decimals),
               name = COALESCE(EXCLUDED.name, tokens.name),
               symbol = COALESCE(EXCLUDED.symbol, tokens.symbol),
               image = COALESCE(EXCLUDED.image, tokens.image),
               metadata_uri = COALESCE(EXCLUDED.metadata_uri, tokens.metadata_uri),
               creator = COALESCE(EXCLUDED.creator, tokens.creator),
               deployer = COALESCE(EXCLUDED.deployer, tokens.deployer),
               launchpad = COALESCE(EXCLUDED.launchpad, tokens.launchpad),
               lifecycle_status = COALESCE(EXCLUDED.lifecycle_status, tokens.lifecycle_status),
               source = EXCLUDED.source,
               observed_at = EXCLUDED.observed_at,
               stale = EXCLUDED.stale,
               updated_at = CURRENT_TIMESTAMP`,
            [
                event.tokenMint,
                event.decimals ?? null,
                event.name ?? null,
                event.symbol ?? null,
                event.image ?? null,
                event.metadataUri ?? null,
                event.creator ?? null,
                event.deployer ?? null,
                event.launchpad ?? null,
                event.lifecycleStatus ?? null,
                event.source,
                event.observedAt,
                event.stale,
            ]
        );
    }

    private async persistPool(event: NormalizedPoolEvent): Promise<void> {
        await query(
            `INSERT INTO pools
             (pool_address, protocol, base_mint, quote_mint, launchpad, lifecycle_status, source, source_event_id, observed_at, received_at, confidence, stale)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
             ON CONFLICT (pool_address) DO UPDATE SET
               protocol = EXCLUDED.protocol,
               base_mint = EXCLUDED.base_mint,
               quote_mint = COALESCE(EXCLUDED.quote_mint, pools.quote_mint),
               launchpad = COALESCE(EXCLUDED.launchpad, pools.launchpad),
               lifecycle_status = COALESCE(EXCLUDED.lifecycle_status, pools.lifecycle_status),
               source = EXCLUDED.source,
               observed_at = EXCLUDED.observed_at,
               stale = EXCLUDED.stale,
               updated_at = CURRENT_TIMESTAMP`,
            [
                event.poolAddress,
                event.protocol,
                event.baseMint,
                event.quoteMint ?? null,
                event.launchpad ?? null,
                event.lifecycleStatus ?? null,
                event.source,
                event.sourceEventId,
                event.observedAt,
                event.receivedAt,
                event.confidence,
                event.stale,
            ]
        );
    }

    private async persistLiquidity(event: NormalizedLiquidityEvent): Promise<void> {
        await query(
            `INSERT INTO liquidity_snapshots
             (idempotency_key, token_mint, pool_address, protocol, token_reserve, sol_reserve,
              liquidity_usd, liquidity_sol, change_type, source, source_event_id, signature, slot,
              observed_at, received_at, confidence, stale)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
             ON CONFLICT (idempotency_key, observed_at) DO NOTHING`,
            [
                event.idempotencyKey,
                event.tokenMint,
                event.poolAddress ?? null,
                event.protocol ?? null,
                event.tokenReserve ?? null,
                event.solReserve ?? null,
                event.liquidityUsd ?? null,
                event.liquiditySol ?? null,
                event.changeType ?? null,
                event.source,
                event.sourceEventId,
                event.signature ?? null,
                event.slot ?? null,
                event.observedAt,
                event.receivedAt,
                event.confidence,
                event.stale,
            ]
        );
    }

    private async persistLiquidityBatch(events: NormalizedLiquidityEvent[]): Promise<void> {
        const values: any[] = [];
        const rows = events.map((event, index) => {
            const offset = index * 17;
            values.push(
                event.idempotencyKey,
                event.tokenMint,
                event.poolAddress ?? null,
                event.protocol ?? null,
                event.tokenReserve ?? null,
                event.solReserve ?? null,
                event.liquidityUsd ?? null,
                event.liquiditySol ?? null,
                event.changeType ?? null,
                event.source,
                event.sourceEventId,
                event.signature ?? null,
                event.slot ?? null,
                event.observedAt,
                event.receivedAt,
                event.confidence,
                event.stale
            );
            return `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}, $${offset + 8}, $${offset + 9}, $${offset + 10}, $${offset + 11}, $${offset + 12}, $${offset + 13}, $${offset + 14}, $${offset + 15}, $${offset + 16}, $${offset + 17})`;
        });

        await query(
            `INSERT INTO liquidity_snapshots
             (idempotency_key, token_mint, pool_address, protocol, token_reserve, sol_reserve,
              liquidity_usd, liquidity_sol, change_type, source, source_event_id, signature, slot,
              observed_at, received_at, confidence, stale)
             VALUES ${rows.join(', ')}
             ON CONFLICT (idempotency_key, observed_at) DO NOTHING`,
            values
        );
    }
}
