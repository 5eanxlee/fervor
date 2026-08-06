import { query } from '../../config/database';
import { TokenData, TokenMarketStateView } from '../../types';

export class MarketStateRepository {
    async getTokenState(tokenMint: string): Promise<TokenMarketStateView | null> {
        const result = await query(
            `SELECT mint, price_usd, price_sol, market_cap_usd, fdv_usd, liquidity_usd,
                    total_supply, circulating_supply, source, observed_at, stale
             FROM tokens
             WHERE mint = $1`,
            [tokenMint]
        );
        const row = result.rows[0];
        if (!row) return null;
        return {
            tokenMint: row.mint,
            priceUsd: row.price_usd === null ? undefined : Number(row.price_usd),
            priceSol: row.price_sol === null ? undefined : Number(row.price_sol),
            marketCapUsd: row.market_cap_usd === null ? undefined : Number(row.market_cap_usd),
            fdvUsd: row.fdv_usd === null ? undefined : Number(row.fdv_usd),
            liquidityUsd: row.liquidity_usd === null ? undefined : Number(row.liquidity_usd),
            totalSupply: row.total_supply === null ? undefined : Number(row.total_supply),
            circulatingSupply: row.circulating_supply === null ? undefined : Number(row.circulating_supply),
            source: row.source || 'fixture',
            observedAt: row.observed_at?.toISOString?.() || row.observed_at || new Date(0).toISOString(),
            stale: Boolean(row.stale),
            confidence: 1,
        };
    }

    async getTokenData(tokenMint: string): Promise<TokenData | null> {
        const result = await query(
            `SELECT mint, name, symbol, image, price_usd, market_cap_usd, fdv_usd, liquidity_usd,
                    source, observed_at, stale, updated_at
             FROM tokens
             WHERE mint = $1`,
            [tokenMint]
        );
        const row = result.rows[0];
        if (!row || row.price_usd === null) return null;
        return {
            address: row.mint,
            name: row.name || 'Unknown Token',
            symbol: row.symbol || 'UNKNOWN',
            logo: row.image || undefined,
            price: Number(row.price_usd),
            market_cap: row.market_cap_usd === null ? undefined : Number(row.market_cap_usd),
            fdv: row.fdv_usd === null ? undefined : Number(row.fdv_usd),
            liquidity_usd: row.liquidity_usd === null ? undefined : Number(row.liquidity_usd),
            stale: Boolean(row.stale),
            source: row.source || undefined,
            observed_at: row.observed_at,
            last_updated: row.updated_at || new Date(),
        };
    }
}
