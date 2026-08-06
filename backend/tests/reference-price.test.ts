import { describe, expect, it, vi } from 'vitest';
import { applyQuoteUsd } from '../src/services/marketData/tradeEnricher';
import { ReferencePriceService, SOL_MINT } from '../src/services/referencePriceService';
import { NormalizedTradeEvent } from '../src/types';

describe('reference prices', () => {
    it('uses Jupiter Price V3 and coalesces concurrent cache misses', async () => {
        const get = vi.fn().mockResolvedValue({
            data: {
                [SOL_MINT]: { usdPrice: 150, liquidity: 1_000_000, blockId: 42 },
            },
        });
        const service = new ReferencePriceService({ get } as any);
        const [first, second] = await Promise.all([service.getSolUsd(), service.getSolUsd()]);

        expect(first).toMatchObject({ usdPrice: 150, blockId: 42, stale: false });
        expect(second).toEqual(first);
        expect(get).toHaveBeenCalledTimes(1);
        expect(get.mock.calls[0][0]).toMatch(/\/price\/v3$/);
        expect(get.mock.calls[0][1].params).toEqual({ ids: SOL_MINT });
    });

    it('values the executed quote amount without changing exact raw amounts', () => {
        const trade: NormalizedTradeEvent = {
            kind: 'trade', idempotencyKey: 'trade-1', tokenMint: 'token-a', quoteMint: SOL_MINT,
            tokenAmount: 2, quoteAmount: 4, tokenAmountRaw: '2000000', quoteAmountRaw: '4000000000',
            priceQuote: 2, confidence: 0.82, stale: false, source: 'helius_laserstream',
            sourceEventId: 'source-1', observedAt: '2026-08-03T00:00:00.000Z',
            receivedAt: '2026-08-03T00:00:00.010Z',
        };
        const enriched = applyQuoteUsd(trade, {
            mint: SOL_MINT, usdPrice: 150, fetchedAt: '2026-08-03T00:00:00.000Z',
            stale: false, source: 'jupiter_price_v3', confidence: 0.8,
        });

        expect(enriched.priceUsd).toBe(300);
        expect(enriched.usdAmount).toBe(600);
        expect(enriched.confidence).toBe(0.8);
        expect(enriched.quoteAmountRaw).toBe('4000000000');
    });
});
