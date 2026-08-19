import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { NormalizedTradeEvent } from '../src/types';
import {
    FxPoint,
    FxTapeSource,
    SOL_MINT,
    USDC_MINT,
    fxPolicy,
    stablePolicy,
} from '../src/services/marketData/fxTape';
import { TradeEnricher } from '../src/services/marketData/tradeEnricher';

const pool = '58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2';

const point = (
    bucketStart: string,
    observedAt: string,
    validUntil: string,
    priceMicroUsd: string,
    sourceEventId: string
): FxPoint => ({
    contract: 'fervor-fx-tape-v1',
    policy: fxPolicy,
    sourceEventId,
    bucketStart,
    bucketMs: 30_000,
    observedAt,
    validUntil,
    maxAgeMs: 90_000,
    priceMicroUsd,
    poolSpreadBps: 0,
    quality: 'single_pool',
    estimated: true,
    confidence: 0.9,
    inputCount: 1,
    observationCount: 1,
    poolCount: 1,
    pools: [{
        poolAddress: pool,
        protocol: 'raydium_amm_v4',
        stableMint: USDC_MINT,
        solRaw: '1000000000',
        stableRaw: priceMicroUsd,
        priceMicroUsd,
        observationCount: 1,
        firstObservedAt: observedAt,
        lastObservedAt: observedAt,
        sourceEventIds: [`raw:${sourceEventId}`],
    }],
    commitment: 'finalized',
});

const first = point(
    '2024-11-18T23:59:30.000Z',
    '2024-11-18T23:59:50.000Z',
    '2024-11-19T00:01:20.000Z',
    '202500000',
    'fx:1'
);
const second = point(
    '2024-11-19T00:00:00.000Z',
    '2024-11-19T00:00:10.000Z',
    '2024-11-19T00:01:40.000Z',
    '203000000',
    'fx:2'
);

describe('FX tape price source', () => {
    it('never looks ahead and expires the latest observed point', async () => {
        const source = new FxTapeSource([first, second]);

        await expect(source.getUsd(SOL_MINT, '2024-11-18T23:59:49.999Z')).resolves.toBeNull();
        await expect(source.getUsd(SOL_MINT, first.observedAt)).resolves.toMatchObject({
            usdPrice: 202.5,
            sourceEventId: 'fx:1',
        });
        await expect(source.getUsd(SOL_MINT, '2024-11-19T00:00:09.999Z')).resolves.toMatchObject({
            sourceEventId: 'fx:1',
        });
        await expect(source.getUsd(SOL_MINT, second.observedAt)).resolves.toMatchObject({
            usdPrice: 203,
            sourceEventId: 'fx:2',
        });
        await expect(source.getUsd(SOL_MINT, second.validUntil)).resolves.not.toBeNull();
        await expect(source.getUsd(SOL_MINT, '2024-11-19T00:01:40.001Z')).resolves.toBeNull();
    });

    it('labels the explicit stablecoin-at-par policy', async () => {
        const source = new FxTapeSource([]);
        await expect(source.getUsd(USDC_MINT, '2024-11-19T00:00:00Z')).resolves.toMatchObject({
            usdPrice: 1,
            source: stablePolicy,
            estimated: true,
        });
        await expect(source.getUsd('unsupported', '2024-11-19T00:00:00Z')).resolves.toBeNull();
    });

    it('rejects corrupt prices, lineage, and ordering', () => {
        expect(() => new FxTapeSource([second, first])).toThrow('strictly ordered');
        expect(() => new FxTapeSource([first, first])).toThrow('strictly ordered');
        expect(() => new FxTapeSource([{
            ...first,
            pools: [{ ...first.pools[0], priceMicroUsd: '1' }],
        }])).toThrow('violates fervor-fx-tape-v1');
    });

    it('enriches through the shared trade path with tape lineage', async () => {
        const trade = JSON.parse(fs.readFileSync(
            path.resolve(__dirname, '../../tests/contracts/decoded-trade-v1.json'),
            'utf8'
        )) as NormalizedTradeEvent;
        const enriched = await new TradeEnricher(new FxTapeSource([first, second])).enrich(trade);

        expect(enriched).toMatchObject({
            priceUsd: 405,
            usdAmount: 810,
            usdSource: fxPolicy,
            usdSourceEventId: 'fx:1',
            usdObservedAt: first.observedAt,
            usdEstimated: true,
        });
    });
});
