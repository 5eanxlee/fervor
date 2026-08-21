import { Router } from 'express';
import { authenticateToken } from '../middleware/auth';
import { publicTokenLimiter } from '../middleware/rateLimits';
import { TokenService } from '../services/tokenService';
import { HeliusTokenService } from '../services/heliusTokenService';
import { query } from '../config/database';
import { addressSchema } from '../types';
import { z } from 'zod';

const router = Router();
const tokenService = new TokenService();
const heliusTokens = new HeliusTokenService();

const discoveryLimit = z.coerce.number().int().min(4).max(40).default(16);
const holderLimit = z.coerce.number().int().min(1).max(20).default(20);
const finalStretchUsd = z.coerce.number().positive().default(45_000)
    .parse(process.env.DISCOVERY_FINAL_STRETCH_USD);

// Public token routes (no authentication required)

router.get('/discovery', publicTokenLimiter, async (req, res) => {
    try {
        const limit = discoveryLimit.parse(req.query.limit);
        const result = await query(
            `WITH candidates AS (
               (SELECT t.*, 'new'::text AS category
                FROM tokens t
                WHERE t.stale = FALSE
                  AND t.source = 'fervor_engine'
                  AND COALESCE(t.lifecycle_status, 'unknown') NOT IN ('bonding', 'migrating', 'migrated', 'trading')
                ORDER BY t.observed_at DESC NULLS LAST, t.mint
                LIMIT $1)
               UNION ALL
               (SELECT t.*, 'final'::text AS category
                FROM tokens t
                WHERE t.stale = FALSE
                  AND t.source = 'fervor_engine'
                  AND (t.lifecycle_status = 'migrating'
                    OR (t.lifecycle_status = 'bonding' AND t.market_cap_usd >= $2))
                ORDER BY t.market_cap_usd DESC NULLS LAST, t.mint
                LIMIT $1)
               UNION ALL
               (SELECT t.*, 'migrated'::text AS category
                FROM tokens t
                WHERE t.stale = FALSE
                  AND t.source = 'fervor_engine'
                  AND t.lifecycle_status IN ('migrated', 'trading')
                ORDER BY t.observed_at DESC NULLS LAST, t.mint
                LIMIT $1)
             )
             SELECT candidates.*, pool.pool_address, pool.protocol,
                    snapshot.volume_usd, snapshot.buy_count, snapshot.sell_count
             FROM candidates
             LEFT JOIN LATERAL (
               SELECT p.pool_address, p.protocol
               FROM pools p
               WHERE p.base_mint = candidates.mint AND p.stale = FALSE
               ORDER BY p.observed_at DESC NULLS LAST
               LIMIT 1
             ) pool ON TRUE
             LEFT JOIN LATERAL (
               SELECT s.volume_usd, s.buy_count, s.sell_count
               FROM market_state_snapshots s
               WHERE s.token_mint = candidates.mint AND s.stale = FALSE
                 AND s.source = 'fervor_engine'
               ORDER BY s.observed_at DESC
               LIMIT 1
             ) snapshot ON TRUE
             ORDER BY category,
                      CASE WHEN category = 'final' THEN candidates.market_cap_usd END DESC NULLS LAST,
                      candidates.observed_at DESC NULLS LAST`,
            [limit, finalStretchUsd]
        );

        res.set('Cache-Control', 'public, max-age=1, stale-while-revalidate=4');
        res.json({
            success: true,
            data: result.rows.map((row) => ({
                category: row.category,
                address: row.mint,
                poolAddress: row.pool_address || undefined,
                protocol: row.protocol || undefined,
                name: row.name || 'Unknown Token',
                symbol: row.symbol || 'UNKNOWN',
                logo: row.image || undefined,
                socials: row.socials || undefined,
                creator: row.creator || undefined,
                launchpad: row.launchpad || undefined,
                lifecycle: row.lifecycle_status,
                priceUsd: row.price_usd === null ? undefined : Number(row.price_usd),
                marketCapUsd: row.market_cap_usd === null ? undefined : Number(row.market_cap_usd),
                liquidityUsd: row.liquidity_usd === null ? undefined : Number(row.liquidity_usd),
                volume5mUsd: Number(row.volume_usd?.['5m'] || 0),
                buyCount5m: Number(row.buy_count?.['5m'] || 0),
                sellCount5m: Number(row.sell_count?.['5m'] || 0),
                createdAt: row.created_at,
                observedAt: row.observed_at,
            })),
        });
    } catch (error) {
        if (error instanceof z.ZodError) {
            return res.status(400).json({ success: false, error: error.issues[0]?.message || 'Invalid discovery request' });
        }
        console.error('Error fetching token discovery:', error);
        res.status(500).json({ success: false, error: 'Failed to fetch token discovery' });
    }
});

router.get('/:address/candles', publicTokenLimiter, async (req, res) => {
    try {
        const address = addressSchema.parse(req.params.address);
        const interval = z.enum(['1s', '5s', '15s', '30s', '1m', '3m', '5m', '15m', '30m', '1h', '4h', '6h', '12h', '24h', '1d'])
            .default('1m').parse(req.query.interval);
        const limit = z.coerce.number().int().min(1).max(2000).default(500).parse(req.query.limit);
        const result = await query(
            `SELECT bucket_start, open_usd, high_usd, low_usd, close_usd, volume_usd,
                    buy_count, sell_count, tx_count
             FROM candles WHERE token_mint = $1 AND interval_name = $2
             ORDER BY bucket_start DESC LIMIT $3`,
            [address, interval, limit]
        );
        res.json({
            success: true,
            data: result.rows.reverse().map((row) => ({
                timestamp: new Date(row.bucket_start).getTime(),
                open: Number(row.open_usd), high: Number(row.high_usd), low: Number(row.low_usd),
                close: Number(row.close_usd), volumeUsd: Number(row.volume_usd || 0),
                buyCount: Number(row.buy_count || 0), sellCount: Number(row.sell_count || 0),
                txCount: Number(row.tx_count || 0),
            })),
        });
    } catch (error) {
        if (error instanceof z.ZodError) {
            return res.status(400).json({ success: false, error: error.issues[0]?.message || 'Invalid candle request' });
        }
        console.error('Error fetching candles:', error);
        res.status(500).json({ success: false, error: 'Failed to fetch candles' });
    }
});

router.get('/:address/holders', publicTokenLimiter, async (req, res) => {
    try {
        const address = addressSchema.parse(req.params.address);
        const limit = holderLimit.parse(req.query.limit);
        if (!HeliusTokenService.isConfigured()) {
            return res.status(503).json({
                success: false,
                error: 'Helius holder reads are not configured',
            });
        }
        const supply = await tokenService.getTokenSupply(address);
        const holders = await heliusTokens.getHolders(address, limit, supply);
        res.set('Cache-Control', 'public, max-age=15, stale-while-revalidate=45');
        res.json({ success: true, data: holders });
    } catch (error) {
        if (error instanceof z.ZodError) {
            return res.status(400).json({ success: false, error: error.issues[0]?.message || 'Invalid holder request' });
        }
        console.error('Error fetching token holders:', error);
        res.status(500).json({ success: false, error: 'Failed to fetch token holders' });
    }
});

router.get('/:address/market-data', publicTokenLimiter, async (req, res) => {
    try {
        const address = addressSchema.parse(req.params.address);
        const marketData = await tokenService.getTokenMarketData(address);

        if (!marketData) {
            return res.status(404).json({
                success: false,
                error: 'Market data not found for this token'
            });
        }

        res.json({
            success: true,
            data: marketData
        });
    } catch (error: any) {
        if (error instanceof z.ZodError) {
            return res.status(400).json({ success: false, error: error.issues[0]?.message || 'Invalid token address' });
        }
        console.error('Error fetching market data:', error);
        res.status(500).json({
            success: false,
            error: error.message || 'Failed to fetch market data'
        });
    }
});

// All other token routes require authentication
router.use(authenticateToken);

// Validate token address - fix the route path
router.get('/validate', async (req, res) => {
    try {
        const { address } = req.query;

        if (!address || typeof address !== 'string') {
            return res.status(400).json({
                success: false,
                error: 'Token address is required'
            });
        }

        console.log(`Validating token address: ${address}`);
        const isValid = await tokenService.validateTokenAddress(address);

        res.json({
            success: true,
            data: { isValid }
        });
    } catch (error) {
        console.error('Error validating token:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to validate token address'
        });
    }
});

// Search tokens by name/symbol or address.
router.get('/search', async (req, res) => {
    try {
        const { query, address } = req.query;
        const searchTerm = typeof address === 'string' ? address : query;

        if (!searchTerm || typeof searchTerm !== 'string' || searchTerm.length < 2) {
            return res.status(400).json({
                success: false,
                error: 'Search query must be at least 2 characters'
            });
        }

        console.log(`Searching tokens with query: ${searchTerm}`);
        const tokens = await tokenService.searchTokens(searchTerm);

        res.json({
            success: true,
            data: tokens
        });
    } catch (error) {
        console.error('Error searching tokens:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to search tokens'
        });
    }
});

// Search tokens by contract address.
router.get('/by-address', async (req, res) => {
    try {
        const { address } = req.query;

        if (!address || typeof address !== 'string') {
            return res.status(400).json({
                success: false,
                error: 'Contract address is required'
            });
        }

        console.log(`Searching for token with address: ${address}`);

        const tokenService = new TokenService();
        const tokens = await tokenService.searchTokens(address);

        res.json({
            success: true,
            data: tokens
        });
    } catch (error) {
        console.error('Error searching tokens:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to search tokens',
            details: error instanceof Error ? error.message : 'Unknown error'
        });
    }
});

// Get token data by address
router.get('/:address', async (req, res) => {
    try {
        const { address } = req.params;

        if (!address) {
            return res.status(400).json({
                success: false,
                error: 'Token address is required'
            });
        }

        console.log(`Fetching token data for: ${address}`);
        const tokenData = await tokenService.getTokenData(address);

        if (!tokenData) {
            return res.status(404).json({
                success: false,
                error: 'Token not found or invalid address'
            });
        }

        res.json({
            success: true,
            data: tokenData
        });
    } catch (error) {
        console.error('Error fetching token data:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch token data'
        });
    }
});

// Get token pairs by address
router.get('/:address/pairs', async (req, res) => {
    try {
        const { address } = req.params;

        if (!address) {
            return res.status(400).json({
                success: false,
                error: 'Token address is required'
            });
        }

        console.log(`Fetching token pairs for: ${address}`);
        const pairsData = await tokenService.getTokenPairs(address);

        if (!pairsData) {
            return res.status(404).json({
                success: false,
                error: 'No pairs found for this token'
            });
        }

        res.json({
            success: true,
            data: pairsData
        });
    } catch (error) {
        console.error('Error fetching token pairs:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch token pairs'
        });
    }
});

// Get token metadata by address
router.get('/:address/metadata', async (req, res) => {
    try {
        const { address } = req.params;

        if (!address) {
            return res.status(400).json({
                success: false,
                error: 'Token address is required'
            });
        }

        console.log(`Fetching token metadata for: ${address}`);
        const metadataData = await tokenService.getTokenMetadata(address);

        if (!metadataData) {
            return res.status(404).json({
                success: false,
                error: 'No metadata found for this token'
            });
        }

        res.json({
            success: true,
            data: metadataData
        });
    } catch (error) {
        console.error('Error fetching token metadata:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch token metadata'
        });
    }
});

export default router; 
