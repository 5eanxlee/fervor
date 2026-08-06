import { NormalizedTradeEvent } from '../../types';
import { RefPrice, ReferencePriceService, referencePrices } from '../referencePriceService';

const valid = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0;

export const isDecodedTrade = (value: unknown): value is NormalizedTradeEvent => {
    const trade = value as Partial<NormalizedTradeEvent> | null;
    return Boolean(
        trade
        && trade.kind === 'trade'
        && trade.idempotencyKey
        && trade.tokenMint
        && trade.quoteMint
        && trade.signature
        && valid(trade.tokenAmount)
        && valid(trade.quoteAmount)
        && valid(trade.priceQuote)
        && Number.isFinite(Date.parse(String(trade.observedAt)))
    );
};

export const applyQuoteUsd = (trade: NormalizedTradeEvent, quote: RefPrice): NormalizedTradeEvent => ({
    ...trade,
    priceUsd: trade.priceQuote! * quote.usdPrice,
    usdAmount: trade.quoteAmount! * quote.usdPrice,
    confidence: Math.min(trade.confidence, quote.confidence),
    stale: trade.stale || quote.stale,
    usdSource: quote.source,
    usdObservedAt: quote.fetchedAt,
    usdBlockId: quote.blockId,
});

export class TradeEnricher {
    constructor(private readonly prices: ReferencePriceService = referencePrices) {}

    async enrich(trade: NormalizedTradeEvent): Promise<NormalizedTradeEvent | null> {
        if (!isDecodedTrade(trade)) return null;
        const quote = await this.prices.getUsd(trade.quoteMint!);
        if (!quote || quote.stale) return null;
        return applyQuoteUsd(trade, quote);
    }
}
