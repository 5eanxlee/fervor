import { query, transaction } from '../config/database';
import type { TokenData, TokenMetadata, TokenPairsResponse } from '../types';
import { HeliusTokenService } from './heliusTokenService';
import { MarketStateRepository } from './marketData/marketStateRepository';

const addressPattern = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const metadataTtlMs = 24 * 60 * 60 * 1000;

const numberOrUndefined = (value: unknown): number | undefined => {
    if (value === null || value === undefined) return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
};

const tokenFromRow = (row: any): TokenData => ({
    address: row.mint,
    name: row.name || 'Unknown Token',
    symbol: row.symbol || 'UNKNOWN',
    logo: row.image || undefined,
    price: Number(row.price_usd),
    market_cap: numberOrUndefined(row.market_cap_usd),
    fdv: numberOrUndefined(row.fdv_usd),
    liquidity_usd: numberOrUndefined(row.liquidity_usd),
    stale: Boolean(row.stale),
    source: row.source || undefined,
    observed_at: row.observed_at,
    last_updated: row.updated_at || new Date(),
});

export class TokenService {
    private readonly marketState = new MarketStateRepository();
    private readonly helius = new HeliusTokenService();

    async getTokenData(tokenAddress: string): Promise<TokenData | null> {
        const data = await this.marketState.getTokenData(tokenAddress);
        if (!data) return null;
        if ((data.name && data.name !== 'Unknown Token') || !HeliusTokenService.isConfigured()) return data;

        try {
            const metadata = await this.getTokenMetadata(tokenAddress);
            return {
                ...data,
                name: metadata.name,
                symbol: metadata.symbol,
                logo: metadata.logo || data.logo,
            };
        } catch {
            return data;
        }
    }

    async getTokenMarketData(tokenAddress: string): Promise<Record<string, unknown> | null> {
        const state = await this.marketState.getTokenState(tokenAddress);
        if (!state || state.priceUsd === undefined) return null;
        return {
            address: tokenAddress,
            price: state.priceUsd,
            liquidity: state.liquidityUsd,
            total_supply: state.totalSupply,
            circulating_supply: state.circulatingSupply,
            fdv: state.fdvUsd,
            market_cap: state.marketCapUsd,
            source: state.source,
            observed_at: state.observedAt,
            stale: state.stale,
        };
    }

    async searchTokens(searchTerm: string): Promise<TokenData[]> {
        const normalized = searchTerm.trim();
        if (addressPattern.test(normalized)) {
            const token = await this.getTokenData(normalized);
            return token ? [token] : [];
        }
        if (normalized.length < 2) return [];

        const result = await query(
            `SELECT mint, name, symbol, image, price_usd, market_cap_usd, fdv_usd,
                    liquidity_usd, stale, source, observed_at, updated_at
             FROM tokens
             WHERE price_usd IS NOT NULL
               AND (symbol ILIKE $1 OR name ILIKE $1)
             ORDER BY stale ASC, liquidity_usd DESC NULLS LAST, observed_at DESC NULLS LAST
             LIMIT 25`,
            [`%${normalized.replace(/[%_]/g, '\\$&')}%`]
        );
        return result.rows.map(tokenFromRow);
    }

    async validateTokenAddress(tokenAddress: string): Promise<boolean> {
        const normalized = tokenAddress?.trim();
        if (!addressPattern.test(normalized)) return false;
        const result = await query('SELECT 1 FROM tokens WHERE mint = $1 LIMIT 1', [normalized]);
        return result.rows.length > 0;
    }

    async getMultipleTokenPrices(tokenAddresses: string[]): Promise<Map<string, number>> {
        if (tokenAddresses.length === 0) return new Map();
        const result = await query(
            `SELECT mint, price_usd FROM tokens
             WHERE mint = ANY($1::varchar[]) AND price_usd IS NOT NULL AND stale = FALSE`,
            [tokenAddresses]
        );
        return new Map(result.rows.map((row) => [row.mint, Number(row.price_usd)]));
    }

    async getTokenPairs(tokenAddress: string): Promise<TokenPairsResponse> {
        const result = await query(
            `SELECT p.pool_address, p.protocol, p.base_mint, p.quote_mint,
                    base.name AS base_name, base.symbol AS base_symbol, base.image AS base_image,
                    base.decimals AS base_decimals, quote.name AS quote_name,
                    quote.symbol AS quote_symbol, quote.image AS quote_image,
                    quote.decimals AS quote_decimals,
                    COALESCE(state.price_usd, base.price_usd) AS price_usd,
                    COALESCE(state.liquidity_usd, base.liquidity_usd) AS liquidity_usd
             FROM pools p
             LEFT JOIN tokens base ON base.mint = p.base_mint
             LEFT JOIN tokens quote ON quote.mint = p.quote_mint
             LEFT JOIN LATERAL (
                 SELECT price_usd, liquidity_usd
                 FROM market_state_snapshots
                 WHERE token_mint = p.base_mint
                   AND pool_address = p.pool_address
                   AND stale = FALSE
                 ORDER BY observed_at DESC
                 LIMIT 1
             ) state ON TRUE
             WHERE (p.base_mint = $1 OR p.quote_mint = $1) AND p.stale = FALSE
             ORDER BY COALESCE(state.liquidity_usd, base.liquidity_usd) DESC NULLS LAST,
                      p.observed_at DESC NULLS LAST
             LIMIT 10`,
            [tokenAddress]
        );

        return {
            pageSize: result.rows.length,
            page: 1,
            pairs: result.rows.map((row) => ({
                exchangeAddress: row.pool_address,
                exchangeName: row.protocol,
                exchangeLogo: '',
                pairLabel: `${row.base_symbol || 'UNKNOWN'}/${row.quote_symbol || 'SOL'}`,
                pairAddress: row.pool_address,
                usdPrice: Number(row.price_usd || 0),
                usdPrice24hrPercentChange: 0,
                usdPrice24hrUsdChange: 0,
                liquidityUsd: Number(row.liquidity_usd || 0),
                baseToken: row.base_mint,
                quoteToken: row.quote_mint || '',
                pair: [
                    {
                        tokenAddress: row.base_mint,
                        tokenName: row.base_name || 'Unknown Token',
                        tokenSymbol: row.base_symbol || 'UNKNOWN',
                        tokenLogo: row.base_image || '',
                        tokenDecimals: String(row.base_decimals ?? 0),
                        pairTokenType: 'base',
                        liquidityUsd: Number(row.liquidity_usd || 0),
                    },
                    ...(row.quote_mint ? [{
                        tokenAddress: row.quote_mint,
                        tokenName: row.quote_name || 'Unknown Token',
                        tokenSymbol: row.quote_symbol || 'UNKNOWN',
                        tokenLogo: row.quote_image || '',
                        tokenDecimals: String(row.quote_decimals ?? 0),
                        pairTokenType: 'quote',
                        liquidityUsd: Number(row.liquidity_usd || 0),
                    }] : []),
                ],
            })),
        };
    }

    async getTokenMetadata(address: string): Promise<TokenMetadata> {
        const stored = await this.getStoredMetadata(address);
        const updatedAt = stored?.metadata_updated_at && new Date(stored.metadata_updated_at).getTime();
        if (stored && updatedAt && Date.now() - updatedAt < metadataTtlMs) {
            return this.metadataFromRow(stored);
        }

        if (HeliusTokenService.isConfigured()) {
            try {
                const metadata = await this.helius.getMetadata(address);
                await this.storeMetadata(metadata);
                const fdv = numberOrUndefined(stored?.fdv_usd);
                return { ...metadata, fullyDilutedValue: fdv === undefined ? undefined : String(fdv) };
            } catch (error) {
                if (!stored) throw error;
            }
        }
        if (stored) return this.metadataFromRow(stored);
        throw new Error('Token metadata is unavailable');
    }

    private async getStoredMetadata(address: string): Promise<any | null> {
        const result = await query(
            `SELECT t.mint, COALESCE(m.name, t.name) AS name,
                    COALESCE(m.symbol, t.symbol) AS symbol,
                    COALESCE(m.decimals, t.decimals) AS decimals,
                    COALESCE(m.image, t.image) AS image,
                    COALESCE(m.metadata_uri, t.metadata_uri) AS metadata_uri,
                    m.description, COALESCE(m.socials, t.socials) AS socials,
                    t.total_supply, t.fdv_usd, m.updated_at AS metadata_updated_at
             FROM tokens t
             LEFT JOIN token_metadata m ON m.mint = t.mint
             WHERE t.mint = $1`,
            [address]
        );
        return result.rows[0] || null;
    }

    private metadataFromRow(row: any): TokenMetadata {
        const totalSupply = row.total_supply === null || row.total_supply === undefined
            ? '0'
            : String(row.total_supply);
        const socials = row.socials && typeof row.socials === 'object' ? row.socials : {};
        return {
            mint: row.mint,
            standard: 'FungibleToken',
            name: row.name || 'Unknown Token',
            symbol: row.symbol || 'UNKNOWN',
            logo: row.image || '',
            decimals: Number(row.decimals || 0),
            metadataUri: row.metadata_uri || '',
            totalSupply,
            totalSupplyFormatted: totalSupply,
            fullyDilutedValue: row.fdv_usd === null || row.fdv_usd === undefined ? undefined : String(row.fdv_usd),
            links: {
                website: socials.website,
                twitter: socials.twitter,
                telegram: socials.telegram,
            },
            description: row.description || null,
        };
    }

    private async storeMetadata(metadata: TokenMetadata): Promise<void> {
        await transaction(async (db) => {
            await db(
                `INSERT INTO tokens
                    (mint, decimals, name, symbol, image, metadata_uri, total_supply, source, observed_at)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, 'helius_das', CURRENT_TIMESTAMP)
                 ON CONFLICT (mint) DO UPDATE SET
                    decimals = COALESCE(EXCLUDED.decimals, tokens.decimals),
                    name = COALESCE(NULLIF(EXCLUDED.name, 'Unknown Token'), tokens.name),
                    symbol = COALESCE(NULLIF(EXCLUDED.symbol, 'UNKNOWN'), tokens.symbol),
                    image = COALESCE(NULLIF(EXCLUDED.image, ''), tokens.image),
                    metadata_uri = COALESCE(NULLIF(EXCLUDED.metadata_uri, ''), tokens.metadata_uri),
                    total_supply = COALESCE(EXCLUDED.total_supply, tokens.total_supply),
                    updated_at = CURRENT_TIMESTAMP`,
                [
                    metadata.mint,
                    metadata.decimals,
                    metadata.name,
                    metadata.symbol,
                    metadata.logo,
                    metadata.metadataUri,
                    metadata.totalSupplyFormatted,
                ]
            );
            await db(
                `INSERT INTO token_metadata
                    (mint, name, symbol, decimals, image, metadata_uri, description, socials, source, observed_at)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'helius_das', CURRENT_TIMESTAMP)
                 ON CONFLICT (mint) DO UPDATE SET
                    name = EXCLUDED.name,
                    symbol = EXCLUDED.symbol,
                    decimals = EXCLUDED.decimals,
                    image = EXCLUDED.image,
                    metadata_uri = EXCLUDED.metadata_uri,
                    description = EXCLUDED.description,
                    socials = EXCLUDED.socials,
                    source = EXCLUDED.source,
                    observed_at = EXCLUDED.observed_at,
                    updated_at = CURRENT_TIMESTAMP`,
                [
                    metadata.mint,
                    metadata.name,
                    metadata.symbol,
                    metadata.decimals,
                    metadata.logo,
                    metadata.metadataUri,
                    metadata.description,
                    JSON.stringify(metadata.links || {}),
                ]
            );
        });
    }
}
