import { describe, expect, it } from 'vitest';
import { deriveFervorMetrics, supplyAmount } from '../src/services/marketData/metricEngine';
import type { FervorSupplyInput } from '../src/types';

const supply: FervorSupplyInput = {
    contract: 'fervor-supply-v1',
    tokenMint: '3an8rhdepsLCya22af7qDBKPbdomw8K4iCHXaA2Gpump',
    rawAmount: '1000000000000000',
    decimals: 6,
    fixed: true,
    layout: 'pump-event-2024-11-v1',
    source: 'old_faithful',
    sourceEventId: 'old_faithful:supply:302459600:signature:0:0',
    slot: 302459600,
    signature: '4mhRTtkQZLF6CL7joHwWwWdaSLP38or5WfhVY6DtZC4vKG3je1sxrDUbNtr2gyTvMXHGTynEUPC6M1NpQF7mbS8d',
    instructionIndex: 0,
    eventIndex: 0,
    observedAt: '2024-11-20T03:48:28Z',
    confidence: 1,
    stale: false,
    commitment: 'finalized',
};

describe('Fervor metric engine', () => {
    it('derives Pump total supply and FDV from exact owned evidence', () => {
        expect(supplyAmount(supply, supply.tokenMint)).toBe(1_000_000_000);
        expect(deriveFervorMetrics({
            tokenMint: supply.tokenMint,
            priceUsd: 0.0000004,
            supply,
        })).toEqual({
            metricSource: 'fervor_engine',
            metricVersion: 'fervor-market-v2',
            marketCapUsd: undefined,
            fdvUsd: 400,
            liquidityUsd: undefined,
        });
    });

    it('fails closed for mismatched, mutable, or unsafe supply evidence', () => {
        expect(supplyAmount(supply, 'another-mint')).toBeUndefined();
        expect(supplyAmount({ ...supply, fixed: false } as any, supply.tokenMint)).toBeUndefined();
        expect(supplyAmount({ ...supply, decimals: 19 } as any, supply.tokenMint)).toBeUndefined();
        expect(supplyAmount({ ...supply, rawAmount: '18446744073709551615', decimals: 0 }, supply.tokenMint))
            .toBeUndefined();
    });
});
