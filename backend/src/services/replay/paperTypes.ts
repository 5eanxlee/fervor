import { createHash } from 'node:crypto';
import { z } from 'zod';
import { amountSchema, u64Schema, u64Text } from '../../types/amount';
import { addressSchema } from '../../types/execution';

export const paperModelContract = 'fervor-paper-fill-v1' as const;
export const paperFactContract = 'fervor-paper-fact-v1' as const;
export const paperCheckpointContract = 'fervor-paper-checkpoint-v1' as const;

export const bpsBase = 10_000n;
export const paperHash = z.string().regex(/^[0-9a-f]{64}$/);
export const paperTime = z.string().datetime({ offset: true });
export const paperOrderId = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/);
export const rawPriceSchema = z.object({
    quoteRaw: amountSchema,
    tokenRaw: amountSchema,
}).strict();
const fixedFeeSchema = z.object({
    kind: z.enum(['network', 'priority', 'rent']),
    mint: addressSchema,
    amountRaw: u64Schema,
}).strict();

export const paperModelSchema = z.object({
    contract: z.literal(paperModelContract),
    latency: z.object({
        clientMs: z.number().int().min(0).max(60_000),
        buildMs: z.number().int().min(0).max(60_000),
        submitMs: z.number().int().min(0).max(60_000),
    }).strict(),
    participationBps: z.number().int().min(1).max(10_000),
    maxLookaheadMs: z.number().int().min(1).max(86_400_000),
    priceGuardBps: z.number().int().min(0).max(9_999),
    protocolFeeBps: z.number().int().min(0).max(9_999),
    fixedFees: z.array(fixedFeeSchema).max(3),
    partialFill: z.literal('allow'),
}).strict().refine((model) => new Set(model.fixedFees.map((fee) => fee.kind)).size
    === model.fixedFees.length, {
    message: 'Fixed fee kinds must be unique',
    path: ['fixedFees'],
});

const orderBase = z.object({
    id: paperOrderId,
    side: z.enum(['buy', 'sell']),
    tokenMint: addressSchema,
    quoteMint: addressSchema,
    inputRaw: amountSchema,
}).strict();
const marketOrder = orderBase.extend({
    kind: z.literal('market'),
    reference: rawPriceSchema,
}).strict();
const limitOrder = orderBase.extend({
    kind: z.literal('limit'),
    limit: rawPriceSchema,
}).strict();

export const paperOrderSchema = z.discriminatedUnion('kind', [marketOrder, limitOrder]);
export const paperStatusSchema = z.enum([
    'pending',
    'eligible',
    'partially_filled',
    'filled',
    'expired',
    'cancelled',
]);

export type PaperSide = 'buy' | 'sell';
export type PaperStatus = z.infer<typeof paperStatusSchema>;
export type PaperFactKind = 'intent' | 'eligible' | 'fill' | 'filled' | 'expired' | 'cancelled';
export type PaperRequest = z.infer<typeof paperOrderSchema>;
export type PaperModelInput = z.infer<typeof paperModelSchema>;

export interface RawPrice {
    readonly quoteRaw: string;
    readonly tokenRaw: string;
}

export interface PaperFee {
    readonly kind: 'protocol' | 'network' | 'priority' | 'rent';
    readonly mint: string;
    readonly amountRaw: string;
}

export interface PaperFill {
    readonly tradeId: string;
    readonly cursor: number;
    readonly observedAt: string;
    readonly inputMint: string;
    readonly outputMint: string;
    readonly inputRaw: string;
    readonly grossOutputRaw: string;
    readonly netOutputRaw: string;
    readonly price: RawPrice;
    readonly fees: readonly PaperFee[];
}

export interface PaperOrder {
    readonly id: string;
    readonly kind: 'market' | 'limit';
    readonly side: PaperSide;
    readonly status: PaperStatus;
    readonly tokenMint: string;
    readonly quoteMint: string;
    readonly inputRaw: string;
    readonly remainingRaw: string;
    readonly filledInputRaw: string;
    readonly grossOutputRaw: string;
    readonly netOutputRaw: string;
    readonly placedCursor: number;
    readonly placedAt: string | null;
    readonly eligibleAt: string | null;
    readonly expiresAt: string | null;
    readonly price: RawPrice;
    readonly modelSha256: string;
    readonly fills: readonly PaperFill[];
}

export interface PaperFact {
    readonly contract: typeof paperFactContract;
    readonly key: string;
    readonly runId: string;
    readonly epoch: number;
    readonly sourceReplaySha256: string;
    readonly modelSha256: string;
    readonly orderId: string;
    readonly seq: number;
    readonly kind: PaperFactKind;
    readonly status: PaperStatus;
    readonly cursor: number;
    readonly observedAt: string | null;
    readonly reason?: 'user' | 'lookahead_elapsed' | 'end_of_tape';
    readonly fill?: PaperFill;
}

export interface PaperModel {
    readonly contract: typeof paperModelContract;
    readonly latency: Readonly<PaperModelInput['latency']>;
    readonly participationBps: number;
    readonly maxLookaheadMs: number;
    readonly priceGuardBps: number;
    readonly protocolFeeBps: number;
    readonly fixedFees: readonly Readonly<PaperModelInput['fixedFees'][number]>[];
    readonly partialFill: 'allow';
}

const gcd = (left: bigint, right: bigint): bigint => {
    let a = left;
    let b = right;
    while (b !== 0n) [a, b] = [b, a % b];
    return a;
};

export const priceOf = (value: z.infer<typeof rawPriceSchema>): RawPrice => {
    const quote = BigInt(value.quoteRaw);
    const token = BigInt(value.tokenRaw);
    const divisor = gcd(quote, token);
    return Object.freeze({
        quoteRaw: (quote / divisor).toString(),
        tokenRaw: (token / divisor).toString(),
    });
};

export const asU64 = (value: bigint, name: string): string => {
    const text = value.toString();
    if (u64Text(text) === undefined) throw new Error(`${name} exceeds an unsigned 64-bit amount`);
    return text;
};

export const toIso = (value: number): string => new Date(value).toISOString();

export const addMs = (base: number, delta: number): number => {
    const value = base + delta;
    if (!Number.isSafeInteger(value)) throw new Error('Paper order time is outside the safe range');
    return value;
};

export const parseTime = (value: string): number => {
    if (!paperTime.safeParse(value).success) {
        throw new Error('Paper broker requires a valid replay time');
    }
    const parsed = Date.parse(value);
    if (!Number.isSafeInteger(parsed)) throw new Error('Paper broker requires a valid replay time');
    return parsed;
};

export const parseCanonicalTime = (value: string): number => {
    const parsed = parseTime(value);
    if (toIso(parsed) !== value) throw new Error('Paper checkpoint time is not canonical');
    return parsed;
};

export const cloneFee = (fee: PaperFee): PaperFee => Object.freeze({ ...fee });
export const cloneFill = (fill: PaperFill): PaperFill => Object.freeze({
    ...fill,
    price: Object.freeze({ ...fill.price }),
    fees: Object.freeze(fill.fees.map(cloneFee)),
});
export const cloneOrder = (order: PaperOrder): PaperOrder => Object.freeze({
    ...order,
    price: Object.freeze({ ...order.price }),
    fills: Object.freeze(order.fills.map(cloneFill)),
});
export const cloneFact = (fact: PaperFact): PaperFact => Object.freeze({
    ...fact,
    ...(fact.fill === undefined ? {} : { fill: cloneFill(fact.fill) }),
});

export const normalizeModel = (value: unknown): PaperModel => {
    const parsed = paperModelSchema.parse(value);
    const fixedFees = parsed.fixedFees
        .map((fee) => Object.freeze({ ...fee }))
        .sort((left, right) => left.kind.localeCompare(right.kind));
    return Object.freeze({
        contract: paperModelContract,
        latency: Object.freeze({ ...parsed.latency }),
        participationBps: parsed.participationBps,
        maxLookaheadMs: parsed.maxLookaheadMs,
        priceGuardBps: parsed.priceGuardBps,
        protocolFeeBps: parsed.protocolFeeBps,
        fixedFees: Object.freeze(fixedFees),
        partialFill: 'allow',
    });
};

export const modelDigest = (model: PaperModel): string => createHash('sha256')
    .update(paperModelContract)
    .update('\0')
    .update(JSON.stringify(model))
    .digest('hex');

export const terminal = (status: PaperStatus): boolean =>
    status === 'filled' || status === 'expired' || status === 'cancelled';

export const marketPriceOk = (
    side: PaperSide,
    trade: RawPrice,
    reference: RawPrice,
    guardBps: number
): boolean => {
    const left = BigInt(trade.quoteRaw) * BigInt(reference.tokenRaw) * bpsBase;
    const move = BigInt(guardBps);
    const right = BigInt(reference.quoteRaw) * BigInt(trade.tokenRaw)
        * (side === 'buy' ? bpsBase + move : bpsBase - move);
    return side === 'buy' ? left <= right : left >= right;
};

export const limitPriceOk = (side: PaperSide, trade: RawPrice, limit: RawPrice): boolean => {
    const left = BigInt(trade.quoteRaw) * BigInt(limit.tokenRaw);
    const right = BigInt(limit.quoteRaw) * BigInt(trade.tokenRaw);
    return side === 'buy' ? left <= right : left >= right;
};

export const grossOf = (side: PaperSide, input: bigint, price: RawPrice): bigint =>
    side === 'buy'
        ? input * BigInt(price.tokenRaw) / BigInt(price.quoteRaw)
        : input * BigInt(price.quoteRaw) / BigInt(price.tokenRaw);

export const protocolFee = (gross: bigint, feeBps: number): bigint => feeBps === 0
    ? 0n
    : (gross * BigInt(feeBps) + bpsBase - 1n) / bpsBase;

export const sameJson = (left: unknown, right: unknown): boolean =>
    JSON.stringify(left) === JSON.stringify(right);
