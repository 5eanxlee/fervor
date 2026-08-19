import { z } from 'zod';
import { fervorSupplyContract, NormalizedTradeEvent } from '../../types';
import { amountSchema } from '../../types/amount';
import { addressSchema, signatureSchema } from '../../types/execution';
import type { PriceSource, RefPrice } from '../referencePriceService';

const positive = z.number().positive().finite();
const safeUint = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const venue = z.enum([
    'pump_fun',
    'pump_swap',
    'raydium_amm_v4',
    'raydium_clmm',
    'raydium_cpmm',
    'raydium_launchlab',
    'meteora_dlmm',
    'meteora_dbc',
    'orca_whirlpool',
]);

export const supplySchema = z.object({
    contract: z.literal(fervorSupplyContract),
    tokenMint: addressSchema,
    rawAmount: amountSchema,
    decimals: z.number().int().min(0).max(18),
    fixed: z.literal(true),
    layout: z.string().regex(/^[a-z0-9-]{1,64}$/),
    source: z.string().regex(/^[a-z0-9_-]{1,32}$/),
    sourceEventId: z.string().min(1).max(180),
    slot: safeUint,
    signature: signatureSchema,
    instructionIndex: z.number().int().min(0).max(0xffff_ffff),
    eventIndex: z.number().int().min(0).max(0xffff_ffff),
    observedAt: z.string().datetime({ offset: true }),
    confidence: z.number().min(0).max(1),
    stale: z.boolean(),
    commitment: z.enum(['processed', 'confirmed', 'finalized']),
}).strict();

export const decodedTradeSchema = z.object({
    source: z.string().regex(/^[a-z0-9_-]{1,32}$/),
    sourceEventId: z.string().min(1).max(180),
    kind: z.literal('trade'),
    idempotencyKey: z.string().regex(/^[0-9a-f]{64}$/),
    tokenMint: addressSchema,
    quoteMint: addressSchema,
    poolAddress: addressSchema.optional(),
    protocol: venue,
    programId: addressSchema,
    maker: addressSchema,
    side: z.enum(['buy', 'sell']),
    tokenAmount: positive,
    quoteAmount: positive,
    tokenAmountRaw: amountSchema,
    quoteAmountRaw: amountSchema,
    tokenDecimals: z.number().int().min(0).max(0xff),
    quoteDecimals: z.number().int().min(0).max(0xff),
    priceQuote: positive,
    solAmount: positive.optional(),
    usdAmount: positive.optional(),
    priceSol: positive.optional(),
    priceUsd: positive.optional(),
    quoteKind: z.enum(['wsol', 'usdc', 'usdt', 'native_sol']),
    route: z.array(venue).min(1),
    txIndex: safeUint,
    instructionIndex: z.number().int().min(0).max(0xffff_ffff),
    eventIndex: z.number().int().min(0).max(0xffff_ffff),
    slot: safeUint,
    signature: signatureSchema,
    receivedAt: z.string().datetime({ offset: true }),
    observedAt: z.string().datetime({ offset: true }),
    confidence: z.number().min(0).max(1),
    stale: z.boolean(),
    commitment: z.enum(['processed', 'confirmed', 'finalized']),
    decodeVersion: z.literal('balance-delta-v1'),
    computeUnits: safeUint.optional(),
    supply: supplySchema.optional(),
}).strict().superRefine((value, context) => {
    const supply = value.supply;
    if (!supply) return;
    if (supply.tokenMint !== value.tokenMint
        || supply.source !== value.source
        || supply.slot !== value.slot
        || supply.signature !== value.signature
        || supply.commitment !== value.commitment) {
        context.addIssue({ code: 'custom', message: 'Supply provenance differs from its trade' });
    }
});

export const isDecodedTrade = (value: unknown): value is NormalizedTradeEvent => {
    return decodedTradeSchema.safeParse(value).success;
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
    usdSourceEventId: quote.sourceEventId,
    usdEstimated: quote.estimated ?? true,
});

export class TradeEnricher {
    constructor(private readonly prices: PriceSource) {}

    async enrich(trade: NormalizedTradeEvent): Promise<NormalizedTradeEvent | null> {
        if (!isDecodedTrade(trade)) return null;
        const quote = await this.prices.getUsd(trade.quoteMint!, trade.observedAt);
        if (!quote || quote.stale) return null;
        return applyQuoteUsd(trade, quote);
    }
}
