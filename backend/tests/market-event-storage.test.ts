import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/config/database', () => ({
    query: vi.fn().mockResolvedValue({ rows: [] }),
}));

import { query } from '../src/config/database';
import { MarketEventStorageService } from '../src/services/marketData/marketEventStorageService';
import type { NormalizedMarketState } from '../src/types';

const mockedQuery = vi.mocked(query);

describe('market event storage', () => {
    beforeEach(() => {
        mockedQuery.mockClear();
        mockedQuery.mockResolvedValue({ rows: [] } as any);
    });

    it('persists legitimate zero market-state values instead of null', async () => {
        const event: NormalizedMarketState = {
            kind: 'market_state',
            metricSource: 'fervor_engine',
            metricVersion: 'fervor-market-v1',
            tokenMint: 'So11111111111111111111111111111111111111112',
            poolAddress: 'pool-1',
            protocol: 'pump_fun',
            priceUsd: 0,
            priceSol: 0,
            marketCapUsd: 0,
            fdvUsd: 0,
            liquidityUsd: 0,
            liquiditySol: 0,
            totalSupply: 0,
            circulatingSupply: 0,
            supplyPolicy: 'fervor_mint_supply_v1',
            source: 'fervor_engine',
            observationSource: 'helius_laserstream',
            inputContract: 'fervor-market-input-v1',
            sourceEventId: 'event-1',
            idempotencyKey: 'state-event-1',
            signature: 'signature-1',
            slot: 0,
            observedAt: '2026-04-27T00:00:00.000Z',
            receivedAt: '2026-04-27T00:00:00.000Z',
            confidence: 0.95,
            stale: false,
        };

        await new MarketEventStorageService().persist([event]);

        expect(mockedQuery.mock.calls[0][1]?.slice(4, 12)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
        expect(mockedQuery.mock.calls[1][1]?.slice(1, 5)).toEqual([0, 0, 0, 0]);
    });
});
