import { describe, expect, it, vi } from 'vitest';
import {
    fervorInputContract,
    MarketInputService,
} from '../src/services/marketData/marketInputService';

describe('Fervor market inputs', () => {
    it('normalizes and coalesces owned liquidity observations', async () => {
        const db = vi.fn().mockResolvedValue({ rows: [{
            liquidity_usd: '25000',
            source: 'helius_laserstream',
            source_event_id: 'pool-state:42',
            observed_at: '2026-08-06T00:00:00.000Z',
            confidence: '0.91',
            stale: false,
        }] });
        const service = new MarketInputService(db as any);

        const [first, second] = await Promise.all([
            service.get('mint-address'),
            service.get('mint-address'),
        ]);

        expect(first).toEqual(second);
        expect(first).toMatchObject({
            contract: fervorInputContract,
            tokenMint: 'mint-address',
            liquidity: {
                liquidityUsd: 25000,
                source: 'helius_laserstream',
                sourceEventId: 'pool-state:42',
            },
        });
        expect(db).toHaveBeenCalledTimes(1);
    });
});
