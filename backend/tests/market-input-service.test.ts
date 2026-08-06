import { afterEach, describe, expect, it, vi } from 'vitest';
import { env } from '../src/config/env';
import {
    fervorInputContract,
    MarketInputService,
} from '../src/services/marketData/marketInputService';

const originalKey = env.HELIUS_API_KEY;

describe('Fervor market inputs', () => {
    afterEach(() => {
        env.HELIUS_API_KEY = originalKey;
    });

    it('normalizes and coalesces provider-specific supply and liquidity observations', async () => {
        env.HELIUS_API_KEY = 'helius-test-key';
        const getSupply = vi.fn().mockResolvedValue({
            mint: 'mint-address',
            rawAmount: '1000000000',
            decimals: 6,
            totalSupply: 1000,
            slot: 42,
            observedAt: '2026-08-06T00:00:00.000Z',
            source: 'helius_rpc',
            confidence: 0.98,
            stale: false,
        });
        const db = vi.fn().mockResolvedValue({ rows: [{
            liquidity_usd: '25000',
            source: 'helius_laserstream',
            source_event_id: 'pool-state:42',
            observed_at: '2026-08-06T00:00:00.000Z',
            confidence: '0.91',
            stale: false,
        }] });
        const service = new MarketInputService({ getSupply } as any, db as any);

        const [first, second] = await Promise.all([
            service.get('mint-address'),
            service.get('mint-address'),
        ]);

        expect(first).toEqual(second);
        expect(first).toMatchObject({
            contract: fervorInputContract,
            tokenMint: 'mint-address',
            supply: {
                totalSupply: 1000,
                circulatingSupply: 1000,
                supplyPolicy: 'fervor_mint_supply_v1',
                rawAmount: '1000000000',
                source: 'helius_rpc',
                sourceEventId: 'helius_rpc:supply:mint-address:42',
            },
            liquidity: {
                liquidityUsd: 25000,
                source: 'helius_laserstream',
                sourceEventId: 'pool-state:42',
            },
        });
        expect(getSupply).toHaveBeenCalledTimes(1);
        expect(db).toHaveBeenCalledTimes(1);
    });
});
