import { describe, expect, it } from 'vitest';
import fixtureTrade from './fixtures/fixture-trade.pumpfun.json';
import { ProviderRawEvent } from '../src/types';
import {
    calculateFdvUsd,
    calculateMarketCapUsd,
    marketStateToFeedTick,
    normalizeProviderRawEvent,
} from '../src/services/marketData/normalization';
import { createMarketDataProvider } from '../src/services/marketData/providerFactory';
import { aggregateRollingWindows } from '../src/services/marketData/rollingWindowAggregator';

const receivedAt = '2026-04-27T00:00:00.000Z';

describe('raw-first market data pipeline contracts', () => {
    it('calculates market cap and fdv from explicit supply fields instead of trade notional', () => {
        expect(calculateMarketCapUsd(0.00072, 850_000_000, 'fervor_mint_supply_v1')).toBe(612000);
        expect(calculateMarketCapUsd(0.00072, 850_000_000)).toBeUndefined();
        expect(calculateFdvUsd(0.00072, 1_000_000_000)).toBe(720000);
    });

    it('normalizes decoded protocol trades into trade and market-state events', () => {
        const raw: ProviderRawEvent = {
            provider: 'helius_laserstream',
            source: 'helius_laserstream',
            sourceEventId: 'helius:event:1',
            type: 'transaction',
            tokenMint: fixtureTrade.tokenMint,
            poolAddress: fixtureTrade.poolAddress,
            signature: fixtureTrade.signature,
            slot: fixtureTrade.slot,
            receivedAt,
            observedAt: receivedAt,
            confidence: 0.95,
            stale: false,
            payload: {
                ...fixtureTrade,
                supplyPolicy: 'fervor_mint_supply_v1',
                marketCapUsd: 1,
                fdvUsd: 2,
            },
        };

        const events = normalizeProviderRawEvent(raw);
        const trade = events.find((event) => event.kind === 'trade');
        const state = events.find((event) => event.kind === 'market_state');

        expect(trade).toMatchObject({
            kind: 'trade',
            tokenMint: fixtureTrade.tokenMint,
            side: 'buy',
            usdAmount: 180,
        });
        expect(state).toMatchObject({
            kind: 'market_state',
            metricSource: 'fervor_engine',
            metricVersion: 'fervor-market-v1',
            tokenMint: fixtureTrade.tokenMint,
            priceUsd: 0.00072,
            marketCapUsd: 612000,
            fdvUsd: 720000,
            liquidityUsd: 35000,
        });
    });

    it('derives Helius market state without trusting provider market-cap or FDV fields', () => {
        const raw: ProviderRawEvent = {
            provider: 'helius_laserstream',
            source: 'helius_laserstream',
            sourceEventId: 'helius:market-state:1',
            type: 'market_state',
            tokenMint: fixtureTrade.tokenMint,
            receivedAt,
            observedAt: receivedAt,
            confidence: 0.95,
            stale: false,
            payload: {
                priceUsd: 150.25,
                totalSupply: 1_000_000,
                circulatingSupply: 900_000,
                supplyPolicy: 'provider_claim_v1',
                marketCapUsd: 1,
                fdvUsd: 2,
                liquidityUsd: 12000000,
            },
        };

        const [state] = normalizeProviderRawEvent(raw);
        expect(state).toMatchObject({
            kind: 'market_state',
            metricSource: 'fervor_engine',
            metricVersion: 'fervor-market-v1',
            tokenMint: fixtureTrade.tokenMint,
            priceUsd: 150.25,
            marketCapUsd: undefined,
            fdvUsd: 150250000,
            liquidityUsd: 12000000,
        });
    });

    it('normalizes decoded transaction payloads from provider streams when Helius access is unavailable', () => {
        const raw: ProviderRawEvent = {
            provider: 'helius_laserstream',
            source: 'helius_laserstream',
            sourceEventId: 'helius:event:decoded:1',
            type: 'transaction',
            tokenMint: fixtureTrade.tokenMint,
            poolAddress: fixtureTrade.poolAddress,
            signature: fixtureTrade.signature,
            slot: fixtureTrade.slot,
            receivedAt,
            observedAt: receivedAt,
            confidence: 0.9,
            stale: false,
            payload: {
                decoded: fixtureTrade,
            },
        };

        const events = normalizeProviderRawEvent(raw);
        expect(events.some((event) => event.kind === 'trade')).toBe(true);
        expect(events.some((event) => event.kind === 'market_state')).toBe(true);
    });

    it('preserves exact Rust decoder fields and source confidence', () => {
        const raw: ProviderRawEvent = {
            provider: 'helius_laserstream',
            source: 'helius_laserstream',
            sourceEventId: 'laserstream:42:signature:0:0',
            type: 'transaction',
            tokenMint: fixtureTrade.tokenMint,
            signature: fixtureTrade.signature,
            slot: 42,
            receivedAt,
            observedAt: receivedAt,
            confidence: 0.82,
            stale: false,
            payload: {
                tokenMint: fixtureTrade.tokenMint,
                quoteMint: 'So11111111111111111111111111111111111111112',
                signature: fixtureTrade.signature,
                side: 'buy',
                protocol: 'orca_whirlpool',
                programId: 'whirLbMiicVdio4qvUfM5KAg6CtVciGkn7hKfLiE6iQ',
                tokenAmount: 2,
                quoteAmount: 4,
                tokenAmountRaw: '2000000',
                quoteAmountRaw: '4000000000',
                tokenDecimals: 6,
                quoteDecimals: 9,
                solAmount: 4,
                priceSol: 2,
                priceQuote: 2,
                quoteKind: 'native_sol',
                route: ['orca_whirlpool'],
                decodeVersion: 'balance-delta-v1',
                computeUnits: 88000,
                instructionIndex: 0,
                eventIndex: 0,
            },
        };

        const trade = normalizeProviderRawEvent(raw).find((event) => event.kind === 'trade');
        expect(trade).toMatchObject({
            kind: 'trade',
            confidence: 0.82,
            quoteAmountRaw: '4000000000',
            quoteKind: 'native_sol',
            route: ['orca_whirlpool'],
            computeUnits: 88000,
        });
    });

    it.each([
        9007199254740992,
        '0',
        '-1',
        '1.5',
        '18446744073709551616',
    ])('rejects malformed raw decoder amount %s before persistence', (tokenAmountRaw) => {
        const raw: ProviderRawEvent = {
            provider: 'helius_laserstream',
            source: 'helius_laserstream',
            sourceEventId: 'laserstream:invalid-amount',
            type: 'transaction',
            tokenMint: fixtureTrade.tokenMint,
            signature: fixtureTrade.signature,
            slot: 42,
            receivedAt,
            observedAt: receivedAt,
            confidence: 0.82,
            stale: false,
            payload: {
                ...fixtureTrade,
                tokenAmountRaw,
                quoteAmountRaw: '1',
            },
        };

        expect(() => normalizeProviderRawEvent(raw)).toThrow(/exact u64 string/);
    });

    it('derives alert ticks only from normalized market state values', () => {
        const raw: ProviderRawEvent = {
            provider: 'helius_laserstream',
            source: 'helius_laserstream',
            sourceEventId: 'helius:event:2',
            type: 'transaction',
            tokenMint: fixtureTrade.tokenMint,
            poolAddress: fixtureTrade.poolAddress,
            signature: fixtureTrade.signature,
            slot: fixtureTrade.slot,
            receivedAt,
            observedAt: receivedAt,
            confidence: 0.95,
            stale: false,
            payload: {
                ...fixtureTrade,
                supplyPolicy: 'fervor_mint_supply_v1',
                usdAmount: 999999999,
            },
        };
        const state = normalizeProviderRawEvent(raw).find((event) => event.kind === 'market_state');
        expect(state?.kind).toBe('market_state');
        const tick = marketStateToFeedTick(state as any);
        expect(tick?.marketCap).toBe(612000);
        expect(tick?.usdValue).toBe(0);
    });

    it('rejects unknown providers instead of silently substituting market data', () => {
        expect(() => createMarketDataProvider('unknown')).toThrow(/Unsupported market data provider/);
    });

    it('aggregates rolling trade windows from normalized trade events', () => {
        const raw: ProviderRawEvent = {
            provider: 'helius_laserstream',
            source: 'helius_laserstream',
            sourceEventId: 'helius:event:3',
            type: 'transaction',
            tokenMint: fixtureTrade.tokenMint,
            poolAddress: fixtureTrade.poolAddress,
            signature: fixtureTrade.signature,
            slot: fixtureTrade.slot,
            receivedAt,
            observedAt: receivedAt,
            confidence: 0.95,
            stale: false,
            payload: fixtureTrade,
        };
        const trade = normalizeProviderRawEvent(raw).find((event) => event.kind === 'trade');
        const metrics = aggregateRollingWindows(fixtureTrade.tokenMint, [trade as any], new Date(receivedAt));

        expect(metrics.volumeUsd['1m']).toBe(180);
        expect(metrics.buyCount['5m']).toBe(1);
        expect(metrics.uniqueBuyers['24h']).toBe(1);
    });
});
